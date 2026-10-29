/**
 * Portable HTTP + WebSocket load balancer for the architecture lab
 * (DEV-CONTRACT §5).
 *
 *   node src/lb/load-balancer.mjs --listen=3000 --host=127.0.0.1 \
 *     --nodes=127.0.0.1:8081,127.0.0.1:8082 --strategy=rr|least-conn|room-affinity
 *
 * WHY A NODE LB INSTEAD OF NGINX
 * ------------------------------
 * The Windows build of nginx uses select() and one worker cannot hold more than
 * 1024 descriptors, so a single worker ends up owning every WebSocket plus its
 * upstream socket and new joins get reset. That failure has nothing to do with the
 * collaboration servers. This proxy runs on libuv (IOCP on Windows) and has no such
 * cap, and it works identically on macOS and Linux. nginx is still shipped as a
 * production reference config, never as a requirement.
 *
 * What the three strategies teach:
 *   rr           dispatch blindly. Correct for `shared` (any node serves any room),
 *                catastrophic for `sharded` - that is `broken-sharded`, and it is
 *                the reason the lab exists.
 *   least-conn   same idea with a load signal.
 *   room-affinity make `sharded` honest: hash the room to a node and remember it,
 *                so one room never straddles two nodes that cannot talk.
 *
 * Health is PASSIVE (no background probes): an upstream that fails is marked down
 * and skipped, and a room pinned to it is re-pinned to a healthy node. A down
 * upstream becomes a candidate again after a revive window, so a restarted node
 * rejoins without the LB having to poll anything.
 *
 * MULTI-MACHINE (DEV-CONTRACT §12)
 * --------------------------------
 * Upstreams may live on other hosts, and the controller registers them at runtime
 * instead of listing every node on the command line:
 *
 *   POST   /__lb/upstreams  {"url":"http://h1:8081"}   probes /health, then adds
 *   DELETE /__lb/upstreams?url=http://h1:8081          removes it and re-pins rooms
 *
 * Both mutate the routing table, so they are token-gated: without
 * `SJS_LB_ADMIN_TOKEN` the endpoints answer 403, with it they require `x-lab-token`
 * (401 otherwise). An open admin API would be a remotely controllable proxy on a
 * public port, which is exactly what a lab on a LAN must not ship.
 */
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '../server/hub.mjs';

const STRATEGIES = ['rr', 'least-conn', 'room-affinity'];
const UPSTREAM_CONNECT_TIMEOUT_MS = Number(process.env.SJS_LB_CONNECT_TIMEOUT_MS || 2000);
/** After this long, a failed upstream is tried again on live traffic (half-open). */
const REVIVE_AFTER_MS = Number(process.env.SJS_LB_REVIVE_MS || 15000);
/** roomAssignments is a live map, not a log; keep it bounded. */
const ROOM_MAP_LIMIT = 10000;
/** Admin add: how long the registration probe waits for a remote /health. */
const ADMIN_PROBE_TIMEOUT_MS = Number(process.env.SJS_LB_PROBE_TIMEOUT_MS || 2000);
/** Admin add: request bodies are a single URL; anything bigger is a mistake. */
const ADMIN_BODY_LIMIT = 16 * 1024;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function usage(message) {
  const text = [
    message,
    '',
    'usage: node src/lb/load-balancer.mjs --listen=3000 --host=127.0.0.1 \\',
    '         --nodes=127.0.0.1:8081,127.0.0.1:8082 --strategy=rr|least-conn|room-affinity \\',
    '         [--admin-token=<token>]',
  ].join('\n');
  process.stderr.write(`${text}\n`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const listenPort = Number(args.listen ?? process.env.SJS_LB_PORT ?? 3000);
const listenHost = String(args.host ?? process.env.SJS_LB_HOST ?? '127.0.0.1');
const strategy = String(args.strategy ?? 'rr').toLowerCase();
const nodesArg = String(args.nodes ?? process.env.SJS_NODES ?? '127.0.0.1:8081,127.0.0.1:8082,127.0.0.1:8083');
/**
 * Token guarding the admin API. Empty means "disabled": the endpoints exist but
 * refuse to change routing, which is the only safe default for a LAN-facing proxy.
 * The value is never logged or echoed - see the startup line.
 */
const adminToken = String(args['admin-token'] ?? process.env.SJS_LB_ADMIN_TOKEN ?? '');

if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  usage(`--listen must be a port number, got ${JSON.stringify(args.listen)}`);
}
if (!STRATEGIES.includes(strategy)) {
  usage(`--strategy must be one of ${STRATEGIES.join('|')}, got ${JSON.stringify(args.strategy)}`);
}

/**
 * Parse one upstream target.
 *
 * Two strings come out of this, on purpose:
 *   key      normalised `http://host:port` - the IDENTITY. Adding or removing
 *            `http://Host:8282/` and `http://host:8282` is one upstream, so an agent
 *            that retries a registration cannot create a duplicate.
 *   url      what the caller registered (scheme synthesised for `host:port`), which
 *            is what `/__lb/state` reports. The controller compares it against the
 *            `nodeUrl` its agent reported, so echoing the registered spelling keeps
 *            `status` able to match a remote node to its upstream.
 *
 * Host and scheme are NOT normalised away across names: `http://localhost:8282` and
 * `http://127.0.0.1:8282` are different upstreams because they can be different
 * machines behind the same port.
 *
 * @returns {{key: string, url: string, host: string, port: number} | {error: string}}
 */
function parseUpstreamTarget(input) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return { error: 'expected "host:port" or "http://host:port"' };
  const hasScheme = text.includes('://');
  let parsed;
  try {
    parsed = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return { error: `cannot parse ${JSON.stringify(input)} as a URL` };
  }
  if (parsed.protocol !== 'http:') {
    return { error: `only http:// upstreams are supported, got ${parsed.protocol}//` };
  }
  if (!parsed.hostname || !parsed.port) {
    return { error: `upstream URL needs an explicit host and port, got ${JSON.stringify(input)}` };
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { error: `upstream URL must be scheme://host:port with no path, got ${JSON.stringify(input)}` };
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `invalid port in ${JSON.stringify(input)}` };
  }
  // `parsed.host` keeps IPv6 brackets (`[::1]:8081`) which is what URL identity
  // needs; the socket layer wants the bare address.
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  const key = `http://${parsed.host}`;
  // Drop a lone trailing slash from the reported URL: it is the same target and it
  // would otherwise never string-match the controller's own `http://host:port`.
  const url = hasScheme ? text.replace(/\/+$/, '') : key;
  return { key, url, host, port };
}

function makeUpstream({ key, url, host, port }) {
  return {
    /** Identity used by add/remove matching (normalised). */
    key,
    /** What `/__lb/state` reports: the registered spelling. */
    url,
    host,
    port,
    /** Open WebSocket pipes to this upstream. */
    connections: 0,
    /** HTTP requests currently proxied to this upstream. */
    inFlight: 0,
    healthy: true,
    downSince: 0,
    lastError: null,
  };
}

/** One shape for both `/__lb/state` and the admin responses, so they cannot drift. */
function describeUpstream(up) {
  return {
    url: up.url,
    host: up.host,
    port: up.port,
    connections: up.connections,
    inFlight: up.inFlight,
    healthy: up.healthy,
    ...(up.lastError ? { lastError: up.lastError } : {}),
  };
}

const upstreams = nodesArg
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const target = parseUpstreamTarget(entry);
    if (target.error) usage(`invalid node in --nodes: ${JSON.stringify(entry)} (${target.error})`);
    return makeUpstream(target);
  });

if (!upstreams.length) usage('--nodes needs at least one upstream host:port');

const startedAt = Date.now();
const log = createLogger(`lb-${listenPort}`);

// A join phase interleaves one HTTP request and one WebSocket upgrade per client,
// so the two distributions must have independent cursors. Sharing one cursor would
// advance it by two per user and pin every user to the same half of the nodes.
let rrHttp = 0;
let rrUpgrade = 0;
let httpTotal = 0;
let upgradeTotal = 0;
/** @type {Map<string, number>} room -> upstream index */
const roomAssignments = new Map();
/** Live WebSocket pipes, so a graceful stop can actually close them. */
const liveSockets = new Set();

const label = (up) => `${up.host}:${up.port}`;

function isCandidate(up) {
  if (up.healthy) return true;
  // Half-open retry: passive health must not keep a restarted node out forever.
  return up.downSince > 0 && Date.now() - up.downSince > REVIVE_AFTER_MS;
}

/**
 * Human-readable failure text for logs and `lastError`.
 *
 * Node's happy-eyeballs path (`autoSelectFamily`, on by default) reports a failed
 * connect as an `AggregateError` whose own `message` is EMPTY - the useful codes live
 * in `err.errors` / `err.cause`. Without this, a dead remote node shows up as
 * "marked down: " with no hint at all, which is exactly the state an operator
 * debugging a multi-machine setup needs to read.
 */
function describeFailure(err) {
  if (!err) return 'unknown error';
  const parts = [];
  const add = (value) => {
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (text && !parts.includes(text)) parts.push(text);
  };
  add(err.message);
  // Prefer the per-attempt message: it carries the address/family that failed.
  for (const inner of err.errors ?? []) add(inner?.message ?? inner?.code);
  add(err.cause?.message ?? err.cause?.code);
  add(err.code);
  return parts.join(' | ') || err.name || 'unknown error';
}

/**
 * Move every room pinned to `fromIndex` onto `toIndex`.
 *
 * Shared by two paths that must not disagree: a node dying (markDown) and an
 * upstream being removed by the admin API. Both leave the introspection endpoint
 * honest immediately instead of on the room's next request.
 */
function repinRooms(fromIndex, toIndex, reason) {
  if (fromIndex < 0 || toIndex === -1 || toIndex === fromIndex) return 0;
  let moved = 0;
  for (const [room, index] of roomAssignments) {
    if (index !== fromIndex) continue;
    roomAssignments.set(room, toIndex);
    moved += 1;
    log.warn(`room ${JSON.stringify(room)} re-pinned ${label(upstreams[fromIndex])} -> ${label(upstreams[toIndex])} (${reason})`);
  }
  return moved;
}

function markDown(up, err) {
  const reason = describeFailure(err);
  if (up.healthy) log.warn(`upstream ${label(up)} marked down: ${reason}`);
  up.healthy = false;
  up.downSince = Date.now();
  up.lastError = reason;

  // Re-pin immediately, not on the next request for the room: a room whose node
  // just died must not stay assigned to a corpse while clients keep arriving, and
  // the introspection endpoint has to tell the truth right away.
  const deadIndex = upstreams.indexOf(up);
  const survivor = upstreams.findIndex((candidate, index) => index !== deadIndex && candidate.healthy);
  repinRooms(deadIndex, survivor, 'upstream down');
}

function markUp(up) {
  if (!up.healthy) log.info(`upstream ${label(up)} is healthy again`);
  up.healthy = true;
  up.downSince = 0;
  up.lastError = null;
}

/** Stable string hash (FNV-1a 32 bit) so a room's node does not move between runs. */
function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Room id from the socket.io handshake query (`?EIO=4&transport=websocket&roomId=...`). */
function roomFromUrl(rawUrl) {
  const queryStart = (rawUrl ?? '').indexOf('?');
  if (queryStart === -1) return null;
  const params = new URLSearchParams(rawUrl.slice(queryStart + 1));
  return params.get('roomId') || params.get('roomid') || params.get('room') || null;
}

function rememberRoom(room, index) {
  if (!roomAssignments.has(room) && roomAssignments.size >= ROOM_MAP_LIMIT) {
    // Map keeps insertion order, so the first key is the oldest assignment.
    roomAssignments.delete(roomAssignments.keys().next().value);
  }
  roomAssignments.set(room, index);
}

function pickRoundRobin(cursorName) {
  const cursor = cursorName === 'http' ? rrHttp : rrUpgrade;
  for (let i = 0; i < upstreams.length; i++) {
    const index = (cursor + i) % upstreams.length;
    if (isCandidate(upstreams[index])) {
      if (cursorName === 'http') rrHttp = (index + 1) % upstreams.length;
      else rrUpgrade = (index + 1) % upstreams.length;
      return upstreams[index];
    }
  }
  // Everything is down: still try one, and let the caller's error path record it.
  return upstreams[cursor % upstreams.length];
}

function pickLeastConn() {
  let best = null;
  for (const up of upstreams) {
    if (!isCandidate(up)) continue;
    const load = up.connections + up.inFlight;
    if (!best || load < best.load) best = { up, load };
  }
  return best ? best.up : upstreams[0];
}

/**
 * Room affinity: `hash(roomId) % nodes` picks the first candidate and the mapping
 * is remembered, so the same room keeps landing on the same node while that node is
 * healthy. When the node dies the room is re-pinned to the next healthy node
 * instead of being scattered across the cluster.
 */
function pickByRoom(room) {
  const existing = roomAssignments.get(room);
  const start = existing ?? hashString(room) % upstreams.length;
  for (let i = 0; i < upstreams.length; i++) {
    const index = (start + i) % upstreams.length;
    if (isCandidate(upstreams[index])) {
      if (existing !== index) {
        if (existing !== undefined) {
          log.warn(`room ${JSON.stringify(room)} re-pinned ${label(upstreams[existing])} -> ${label(upstreams[index])}`);
        }
        rememberRoom(room, index);
      }
      return upstreams[index];
    }
  }
  rememberRoom(room, start);
  return upstreams[start];
}

function pickUpstream({ room, kind }) {
  if (strategy === 'room-affinity' && room) return pickByRoom(room);
  if (strategy === 'least-conn') return pickLeastConn();
  return pickRoundRobin(kind);
}

/** One retry candidate, preferring the least loaded healthy node. */
function alternate(primary) {
  const candidates = upstreams.filter((up) => up !== primary && isCandidate(up));
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.connections + a.inFlight - (b.connections + b.inFlight));
  return candidates[0];
}

function stateBody() {
  return {
    ok: true,
    strategy,
    startedAt,
    listen: `${listenHost}:${listenPort}`,
    upstreams: upstreams.map(describeUpstream),
    roomAssignments: Object.fromEntries(
      // A pin can only be stale between a removal and the re-pin that follows it in
      // the same tick; skipping unknown indices keeps /state a 200 no matter what.
      [...roomAssignments]
        .filter(([, index]) => Boolean(upstreams[index]))
        .map(([room, index]) => [room, label(upstreams[index])]),
    ),
    totals: { http: httpTotal, upgrades: upgradeTotal },
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// admin API (DEV-CONTRACT §12)
// ---------------------------------------------------------------------------

/**
 * Token check for the two endpoints that change routing.
 *
 * `timingSafeEqual` is used even though this is a lab token: the endpoint may be
 * exposed on a LAN interface, and a length-revealing comparison is a free hint for
 * nobody's benefit. Comparing Buffers (not strings) keeps multi-byte tokens from
 * throwing inside timingSafeEqual on a length mismatch.
 */
function adminAuthorized(req, res) {
  if (!adminToken) {
    sendJson(res, 403, { error: 'admin-disabled', detail: 'set SJS_LB_ADMIN_TOKEN' });
    return false;
  }
  const given = Buffer.from(String(req.headers['x-lab-token'] ?? ''));
  const expected = Buffer.from(adminToken);
  const ok = given.length === expected.length && timingSafeEqual(given, expected);
  if (!ok) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

/** Read a small JSON request body; rejects oversized/never-ending uploads. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > ADMIN_BODY_LIMIT) {
        reject(Object.assign(new Error(`request body exceeds ${ADMIN_BODY_LIMIT} bytes`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(Object.assign(new Error(`invalid JSON body: ${err.message}`), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Probe a candidate upstream's `/health` before registering it, bounded so a
 * black-holed address (firewalled remote host, wrong IP) cannot stall the LB.
 * A failed probe still registers the upstream - as unhealthy - because the node may
 * simply be restarting; the passive revive path picks it up when it answers again.
 */
async function probeUpstreamHealth(host, port) {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(ADMIN_PROBE_TIMEOUT_MS),
    });
    const drained = res.arrayBuffer().catch(() => null);
    if (!res.ok) return { healthy: false, error: `probe: HTTP ${res.status}` };
    await drained;
    return { healthy: true, error: null };
  } catch (err) {
    const reason =
      err?.name === 'TimeoutError'
        ? `no answer within ${ADMIN_PROBE_TIMEOUT_MS}ms`
        : describeFailure(err);
    return { healthy: false, error: `probe: ${reason}` };
  }
}

async function handleAdminAdd(req, res) {
  if (!adminAuthorized(req, res)) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.status ?? 400, { error: err.status === 413 ? 'body-too-large' : 'invalid-json', detail: err.message });
    return;
  }

  const target = parseUpstreamTarget(body?.url);
  if (target.error) {
    sendJson(res, 400, { error: 'invalid-url', detail: target.error });
    return;
  }

  const existing = upstreams.find((up) => up.key === target.key);
  if (existing) {
    // Idempotent: registration is a "make sure this node is in the pool" call, so a
    // repeated POST from a retrying agent must not duplicate the upstream or reset
    // its counters/health.
    log.info(`admin: upstream ${existing.url} already registered (idempotent POST)`);
    sendJson(res, 200, { ok: true, upstreams: upstreams.map(describeUpstream) });
    return;
  }

  const probe = await probeUpstreamHealth(target.host, target.port);
  const upstream = makeUpstream(target);
  upstream.healthy = probe.healthy;
  upstream.downSince = probe.healthy ? 0 : Date.now();
  upstream.lastError = probe.healthy ? null : probe.error;
  upstreams.push(upstream);
  log.info(
    `admin: registered ${target.url} (probe ${probe.healthy ? 'healthy' : `unhealthy: ${probe.error}`}), ` +
      `${upstreams.length} upstream(s)`,
  );
  sendJson(res, 200, { ok: true, upstreams: upstreams.map(describeUpstream) });
}

function handleAdminRemove(req, res, requestUrl) {
  if (!adminAuthorized(req, res)) return;

  const target = parseUpstreamTarget(requestUrl.searchParams.get('url'));
  if (target.error) {
    sendJson(res, 400, { error: 'invalid-url', detail: target.error });
    return;
  }

  const index = upstreams.findIndex((up) => up.key === target.key);
  if (index === -1) {
    log.info(`admin: DELETE ${target.url} - not registered (idempotent)`);
    sendJson(res, 200, { ok: true, removed: false, upstreams: upstreams.map(describeUpstream) });
    return;
  }
  if (upstreams.length === 1) {
    sendJson(res, 409, {
      error: 'last-upstream',
      detail: `refusing to remove ${target.url}: it is the only upstream, so the LB would have nowhere to route. Register another node first.`,
    });
    return;
  }

  // Pick the survivor BEFORE splicing, then translate every pinned index through the
  // removal: the room map stores array indices, so rooms on later upstreams shift
  // down by one and rooms on the removed upstream are re-pinned to the survivor.
  //
  // Sockets that are ALREADY piped to the removed upstream are left alone on purpose:
  // an agent detach is "stop sending me new traffic", and dropping live sessions the
  // moment a registration disappears would turn an administrative action into a
  // visible glitch. The node stops them when the agent stops it.
  const removed = upstreams[index];
  const survivor =
    upstreams.find((candidate, i) => i !== index && candidate.healthy) ??
    upstreams.find((candidate, i) => i !== index);
  upstreams.splice(index, 1);
  const survivorIndex = survivor ? upstreams.indexOf(survivor) : -1;

  let moved = 0;
  const next = new Map();
  for (const [room, pinned] of roomAssignments) {
    if (pinned === index) {
      if (survivorIndex === -1) continue; // nowhere to put it: let the next join re-hash
      next.set(room, survivorIndex);
      moved += 1;
      log.warn(
        `room ${JSON.stringify(room)} re-pinned ${label(removed)} -> ${label(upstreams[survivorIndex])} (upstream removed)`,
      );
    } else {
      next.set(room, pinned > index ? pinned - 1 : pinned);
    }
  }
  roomAssignments.clear();
  for (const [room, pinned] of next) roomAssignments.set(room, pinned);

  log.info(
    `admin: removed ${target.url} (${moved} room pin(s) moved to ${survivor ? label(upstreams[survivorIndex]) : 'none'}), ` +
      `${upstreams.length} upstream(s) left`,
  );
  sendJson(res, 200, { ok: true, removed: true, upstreams: upstreams.map(describeUpstream) });
}

/**
 * Plain HTTP proxy.
 *
 * Connection counts here are in-flight requests; the WebSocket count lives on the
 * upgrade path. Least-connections sums the two so one metric cannot be gamed by
 * mixing protocols.
 */
const agent = new http.Agent({ keepAlive: true, maxSockets: 2048 });

const server = http.createServer((req, res) => {
  // Path-based routing: the admin endpoints carry a query string, and every other
  // path (including socket.io's `/collaboration/?...`) must be proxied verbatim, so
  // parse a copy of the URL and keep `req.url` untouched for the upstream request.
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${listenHost}:${listenPort}`);
  } catch {
    sendJson(res, 400, { error: 'bad-request', detail: `cannot parse request target ${JSON.stringify(req.url)}` });
    return;
  }
  const { pathname } = requestUrl;

  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('ok');
    return;
  }
  if (pathname === '/__lb/state') {
    sendJson(res, 200, stateBody());
    return;
  }
  if (pathname === '/__lb/upstreams') {
    if (req.method === 'POST') {
      handleAdminAdd(req, res).catch((err) => {
        log.error(`admin add failed: ${describeFailure(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal', detail: describeFailure(err) });
      });
      return;
    }
    if (req.method === 'DELETE') {
      handleAdminRemove(req, res, requestUrl);
      return;
    }
    sendJson(res, 405, { error: 'method-not-allowed', detail: 'POST or DELETE /__lb/upstreams' });
    return;
  }
  if (pathname.startsWith('/__lb/')) {
    sendJson(res, 404, { error: 'not-found', detail: `unknown LB control endpoint ${pathname}` });
    return;
  }
  if (pathname === '/shutdown') {
    // Same reason as the node servers: `taskkill` / SIGTERM can be denied in
    // restricted environments, and a proxy that cannot be stopped keeps the whole
    // stack's URL alive. Answer first, stop shortly after.
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method-not-allowed', detail: 'POST /shutdown' });
      return;
    }
    sendJson(res, 202, { ok: true, nodeId: `lb-${listenPort}` });
    setTimeout(() => shutdown('POST /shutdown'), 200);
    return;
  }

  const room = roomFromUrl(req.url);
  const upstream = pickUpstream({ room, kind: 'http' });
  httpTotal += 1;
  upstream.inFlight += 1;

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    upstream.inFlight = Math.max(0, upstream.inFlight - 1);
  };

  const headers = { ...req.headers };
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  headers['x-forwarded-proto'] = 'http';

  const proxy = http.request(
    { host: upstream.host, port: upstream.port, path: req.url, method: req.method, headers, agent },
    (upstreamRes) => {
      markUp(upstream);
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on('close', done);
    },
  );
  proxy.on('error', (err) => {
    done();
    markDown(upstream, err);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`lb: upstream ${label(upstream)} failed: ${describeFailure(err)}\n`);
  });
  res.on('close', done);
  req.pipe(proxy);
});

/**
 * WebSocket / Upgrade passthrough: raw TCP pipe, original handshake bytes, and the
 * `head` buffer socket.io's upgrade may already have consumed. On an upstream error
 * before the handshake is written, the request is retried ONCE on another node -
 * exactly the case a room-affinity LB hits when a node dies mid-session.
 */
server.on('upgrade', (req, socket, head) => {
  // An 'error' on the client socket before any upstream is connected would
  // otherwise be an uncaught exception and take the whole LB down.
  socket.on('error', () => socket.destroy());
  const room = roomFromUrl(req.url);
  const primary = pickUpstream({ room, kind: 'upgrade' });
  const retry = alternate(primary);
  const candidates = retry ? [primary, retry] : [primary];
  upgradeTotal += 1;
  const startedConnect = Date.now();

  const requestHead = [`${req.method} ${req.url} HTTP/1.1`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    requestHead.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  const handshake = `${requestHead.join('\r\n')}\r\n\r\n`;

  const attempt = (index) => {
    const upstream = candidates[index];
    const conn = net.connect({ host: upstream.host, port: upstream.port });
    let opened = false;

    const timer = setTimeout(() => {
      if (opened) return;
      conn.destroy();
      fail(new Error(`connect timeout after ${UPSTREAM_CONNECT_TIMEOUT_MS}ms`));
    }, UPSTREAM_CONNECT_TIMEOUT_MS);

    const fail = (err) => {
      clearTimeout(timer);
      markDown(upstream, err);
      if (index + 1 < candidates.length) {
        log.warn(`upgrade to ${label(upstream)} failed (${describeFailure(err)}); retrying ${label(candidates[index + 1])}`);
        attempt(index + 1);
        return;
      }
      log.error(`no upstream could serve ${req.url}: ${describeFailure(err)}`);
      socket.destroy();
    };

    conn.on('error', (err) => {
      if (!opened) fail(err);
      else socket.destroy();
    });

    conn.on('connect', () => {
      opened = true;
      clearTimeout(timer);
      markUp(upstream);
      upstream.connections += 1;

      let released = false;
      const pair = { socket, conn };
      const release = () => {
        if (released) return;
        released = true;
        liveSockets.delete(pair);
        upstream.connections = Math.max(0, upstream.connections - 1);
      };
      const closeBoth = () => {
        release();
        socket.destroy();
        conn.destroy();
      };
      liveSockets.add(pair);

      conn.write(handshake);
      // The upgrade request may already have produced payload bytes; they belong to
      // the upstream socket verbatim.
      if (head && head.length) conn.write(head);
      socket.pipe(conn);
      conn.pipe(socket);
      conn.on('close', closeBoth);
      socket.on('close', closeBoth);
      socket.on('error', closeBoth);
      log.info(
        `upgrade room=${room ?? '-'} strategy=${strategy} -> ${label(upstream)} ` +
          `(${upstream.connections} open, ${Date.now() - startedConnect}ms)`,
      );
    });
  };

  attempt(0);
});

server.on('clientError', (_err, socket) => {
  try {
    socket.destroy();
  } catch {
    /* already gone */
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(
      `port ${listenPort} on ${listenHost} is already in use. Stop the process holding it or pass --listen=<free port>; ` +
        'the URL shown to users must match the port that is actually bound.',
    );
    process.exit(2);
  }
  log.error('server error', err.message);
});

server.listen(listenPort, listenHost, () => {
  log.info(
    `listening ${listenHost}:${listenPort} strategy=${strategy} -> ${upstreams.map(label).join(', ')} ` +
      `(healthz=/healthz state=/__lb/state)`,
  );
  // Never print the token itself - only whether the admin surface is armed.
  log.info(
    adminToken
      ? 'admin token: SET (POST/DELETE /__lb/upstreams require x-lab-token)'
      : 'admin token: MISSING (POST/DELETE /__lb/upstreams answer 403 until SJS_LB_ADMIN_TOKEN is set)',
  );
});

/**
 * Graceful stop, shared by SIGINT/SIGTERM and `POST /shutdown`.
 *
 * Upgraded sockets are not HTTP connections, so `server.close()` and
 * `closeAllConnections()` do not touch them - they are destroyed explicitly, or
 * the process would linger until every browser tab disconnects.
 */
function shutdown(reason) {
  log.warn(`${reason}, stopping`);
  for (const { socket, conn } of liveSockets) {
    socket.destroy();
    conn.destroy();
  }
  liveSockets.clear();
  server.close();
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 50);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
