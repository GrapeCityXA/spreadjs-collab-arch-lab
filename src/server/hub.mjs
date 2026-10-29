/**
 * Per-node control plane and evidence recorder.
 *
 * The lab's whole claim is "this topology delivers (or silently drops) this
 * traffic". A claim like that is only worth something if it can be observed from
 * outside the client that made it, so every node exposes what it saw over HTTP:
 *
 *   GET  /health      liveness + effective feature flags
 *   GET  /state       clients, rooms, documents, counters
 *   GET  /docs?room=  one room document (the only way to see two nodes diverge
 *                     without trusting a client)
 *   POST /reset       clear counters only - never document state
 *
 * The control plane shares the node's single HTTP server: the collaboration
 * server owns the port (it is handed the same `http.Server`), so a second
 * `listen()` would fail with EADDRINUSE. Requests that are not ours fall through
 * to socket.io untouched.
 */
import { EOL } from 'node:os';

/** Rooms listed in /state.docs, to keep responses small (DEV-CONTRACT §3). */
const STATE_DOC_LIMIT = 50;

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

function fmt(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Tiny prefixed logger: `12:04:31.812 [node-8081] INFO  listening ...`.
 * The prefix is the node identity, so several nodes can share one terminal or log
 * file and still be readable.
 */
export function createLogger(prefix) {
  const emit = (stream, level, args) => {
    stream.write(`${timestamp()} [${prefix}] ${level}${args.length ? ' ' : ''}${args.map(fmt).join(' ')}${EOL}`);
  };
  return {
    info: (...args) => emit(process.stdout, 'INFO ', args),
    warn: (...args) => emit(process.stderr, 'WARN ', args),
    error: (...args) => emit(process.stderr, 'ERROR', args),
  };
}

/** Normalize socket.io, sqlite and plain errors into one readable line. */
export function describeError(err) {
  if (!err) return '(empty)';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name || '(Error)';
  if (typeof err.data === 'object' && err.data !== null) {
    const data = err.data;
    return [data.message, data.code !== undefined ? `code=${data.code}` : '', data.type ? `type=${data.type}` : '']
      .filter(Boolean)
      .join(' ');
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NodeHub {
  /**
   * @param {object} options
   * @param {string} options.nodeId
   * @param {number} options.port
   * @param {'mirror'|'real'} options.impl
   * @param {boolean} options.adapterEnabled
   * @param {'local'|'shared'} options.storeMode  document store this node uses
   * @param {boolean} [options.otEnabled]
   * @param {string|null} [options.otDbMode]
   * @param {boolean} [options.presenceEnabled]
   */
  constructor({
    nodeId,
    port,
    impl,
    adapterEnabled,
    storeMode,
    otEnabled = false,
    otDbMode = null,
    presenceEnabled = false,
  }) {
    this.nodeId = nodeId;
    this.port = port;
    this.impl = impl;
    this.adapterEnabled = Boolean(adapterEnabled);
    this.storeMode = storeMode;
    this.otEnabled = Boolean(otEnabled);
    this.otDbMode = otDbMode;
    this.presenceEnabled = Boolean(presenceEnabled);
    this.startedAt = Date.now();
    this.log = createLogger(nodeId);

    this.io = null;
    this.adapterInstrumented = false;
    this.documents = null; // { get(roomId), peek(roomId), list(limit) } or null for impl=real

    this.state = {
      /** @type {Map<string, {id: string, roomId: string, label: string, connectedAt: number}>} */
      clients: new Map(),
      messagesSeen: 0,
      /** Collaboration frames this node received FROM another node over Redis. */
      inbound: 0,
      /** Collaboration fan-outs this node performed locally. */
      outbound: 0,
    };
  }

  /**
   * Attach the socket.io instance and instrument the adapter boundary.
   *
   * The adapter is where multi-node behaviour becomes observable:
   *   - `adapter.onmessage` fires only for events that arrived over Redis from a
   *     foreign node, so it counts *cross-node* deliveries;
   *   - `adapter.broadcast` is the local fan-out this node performs.
   * That asymmetry is the experiment's dependent variable, which is why the
   * counters in /state are called inbound/outbound.
   */
  async attachSocketIo(io) {
    this.io = io;
    if (!io?.sockets?.adapter) return false;
    // The adapter instance is (re)assigned during server construction; give it one
    // tick so the patch lands on the final instance instead of a half-built one.
    await sleep(50);
    this.instrumentAdapter();
    this.log.info(`adapter instrumentation: ${this.adapterInstrumented ? 'active' : 'UNAVAILABLE'}`);
    return this.adapterInstrumented;
  }

  /**
   * Patch the adapter WITHOUT changing behaviour.
   *
   * Both methods must forward every argument verbatim:
   *   - `onmessage(pattern, channel, message)` - dropping `message` makes the
   *     adapter's parser throw and silently breaks cross-node relay;
   *   - `broadcast(packet, opts)` - dropping `opts` throws on `opts.rooms`.
   * A destructive wrapper would make the treatment group fail for reasons that
   * have nothing to do with Redis, so the bodies below only record, then delegate.
   */
  instrumentAdapter() {
    const adapter = this.io?.sockets?.adapter;
    if (!adapter) return false;
    if (adapter.__sjsInstrumented) {
      this.adapterInstrumented = true;
      return true;
    }
    const hub = this;

    const originalOnMessage = adapter.onmessage?.bind(adapter);
    if (typeof originalOnMessage === 'function') {
      adapter.onmessage = function patchedOnMessage(...args) {
        try {
          hub.state.inbound += 1;
        } catch {
          /* instrumentation must never break traffic */
        }
        return originalOnMessage(...args);
      };
    }

    const originalBroadcast = adapter.broadcast?.bind(adapter);
    if (typeof originalBroadcast === 'function') {
      adapter.broadcast = function patchedBroadcast(...args) {
        try {
          const [packet] = args;
          // Count only collaboration frames, not socket.io's own broadcasts.
          if (packet?.data?.[0] === 'm') hub.state.outbound += 1;
        } catch {
          /* ignore */
        }
        return originalBroadcast(...args);
      };
    }

    adapter.__sjsInstrumented = true;
    this.adapterInstrumented = true;
    return true;
  }

  /**
   * Register or update one connected client.
   *
   * Accepts either a socket.io socket id plus fields, or the real server's
   * `connection` object (which exposes `id`, `roomId` and `query`).
   */
  setClient({ id, roomId, label }) {
    if (!id || !roomId) return null;
    const existing = this.state.clients.get(id);
    const record = {
      id: String(id),
      roomId: String(roomId),
      label: String(label ?? existing?.label ?? id),
      connectedAt: existing?.connectedAt ?? Date.now(),
    };
    this.state.clients.set(record.id, record);
    return record;
  }

  removeClient(id) {
    this.state.clients.delete(String(id));
  }

  /** Remember one inbound collaboration frame (any type). */
  recordMessage() {
    this.state.messagesSeen += 1;
  }

  /** Local members of a room, in the shape the protocol's `members` field uses. */
  membersOf(roomId) {
    const members = [];
    for (const client of this.state.clients.values()) {
      if (client.roomId === roomId) members.push({ id: client.id, label: client.label, nodeId: this.nodeId });
    }
    return members;
  }

  rooms() {
    const grouped = new Map();
    for (const client of this.state.clients.values()) {
      if (!grouped.has(client.roomId)) grouped.set(client.roomId, []);
      grouped.get(client.roomId).push(client.id);
    }
    return grouped;
  }

  /** Health fields that are true regardless of what this node currently stores. */
  health() {
    // RSS is exposed so capacity work (docs/12) can measure memory per cell / per
    // connection from the outside without resorting to OS tools or process access.
    const memory = process.memoryUsage();
    return {
      ok: true,
      nodeId: this.nodeId,
      port: this.port,
      pid: process.pid,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      impl: this.impl,
      adapterEnabled: this.adapterEnabled,
      otEnabled: this.otEnabled,
      otDbMode: this.otEnabled ? this.otDbMode : null,
      presenceEnabled: this.presenceEnabled,
      storeMode: this.storeMode,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  async stateSnapshot() {
    const rooms = [];
    for (const [roomId, memberIds] of this.rooms()) {
      const doc = this.documents ? await this.documents.peek(roomId) : null;
      rooms.push({ roomId, members: memberIds, version: doc ? doc.version : null });
    }
    const docs = this.documents ? await this.documents.list(STATE_DOC_LIMIT) : [];
    return {
      ...this.health(),
      clients: [...this.state.clients.values()],
      rooms,
      docs,
      messagesSeen: this.state.messagesSeen,
      inbound: this.state.inbound,
      outbound: this.state.outbound,
      adapterInstrumented: this.adapterInstrumented,
      docsSupported: Boolean(this.documents),
      licenseConfigured: Boolean(this.licenseStatus?.server),
    };
  }

  /**
   * Install the control plane on the node's HTTP server.
   *
   * `/shutdown` exists because a controlled stop cannot be relied on: in
   * sandboxes, containers and some Windows ACL setups `taskkill`/SIGTERM is
   * denied, which leaves an orphan holding the node's port while the orchestrator
   * already believes the stack is down. A process that can be asked to stop over
   * its own control plane is the only portable answer.
   *
   * @param {import('node:http').Server} httpServer
   * @param {object} [options]
   * @param {{ get: Function, peek: Function, list: Function }} [options.documents]
   * @param {object} [options.licenseStatus]
   * @param {(reason: string) => void} [options.onShutdown]
   */
  installControl(httpServer, { documents = null, licenseStatus = null, onShutdown = null } = {}) {
    this.documents = documents;
    this.licenseStatus = licenseStatus;
    // A nested function declaration has its own `this`, so the hub is captured here
    // instead of relying on the call site.
    const hub = this;

    httpServer.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
      const json = (status, body) => {
        const payload = JSON.stringify(body, null, 2);
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
          'cache-control': 'no-store',
        });
        res.end(payload);
      };

      const route = `${req.method} ${url.pathname}`;
      if (!['/health', '/state', '/docs', '/reset', '/shutdown'].includes(url.pathname)) {
        // Not ours: socket.io handles its own paths on this same server.
        return undefined;
      }

      handler(route, url)
        .then((body) => json(body.status ?? 200, body.body))
        .catch((err) => json(500, { error: 'control-plane-failure', detail: describeError(err) }));
    });

    // Declared as a hoisted function so the request listener above can call it
    // without relying on the order of the two definitions.
    async function handler(route, url) {
      switch (route) {
        case 'GET /health':
          return { body: hub.health() };

        case 'GET /state':
          return { body: await hub.stateSnapshot() };

        case 'GET /docs': {
          const roomId = url.searchParams.get('room');
          if (!roomId) {
            return {
              status: 400,
              body: { error: 'missing-room', detail: 'GET /docs requires ?room=<roomId>' },
            };
          }
          if (!hub.documents) {
            // Honest rather than empty: impl=real keeps documents inside the OT
            // feature, so this node genuinely cannot answer.
            return {
              status: 501,
              body: {
                error: 'not-supported',
                detail:
                  'impl=real keeps document state inside the OT feature; only the mirror implementation exposes /docs',
              },
            };
          }
          const doc = await hub.documents.peek(roomId);
          if (!doc) {
            return {
              status: 404,
              body: {
                error: 'not-found',
                detail: `room ${JSON.stringify(roomId)} has no document on ${hub.nodeId} yet (store=${hub.storeMode})`,
              },
            };
          }
          return { body: doc };
        }

        case 'POST /reset':
          // Counters only. Document state is the experiment's measurement, so
          // clearing it here would let a reset hide a divergence.
          hub.state.messagesSeen = 0;
          hub.state.inbound = 0;
          hub.state.outbound = 0;
          return { body: { ok: true, nodeId: hub.nodeId } };

        case 'POST /shutdown': {
          if (!onShutdown) {
            return {
              status: 503,
              body: {
                error: 'not-supported',
                detail: 'this process was started without a shutdown handler',
              },
            };
          }
          // Answer first, stop second: the caller needs the 202 before the socket
          // to this server disappears. The 200 ms grace is enough for the response
          // to be flushed by the kernel even with the connection still open.
          setTimeout(() => onShutdown('POST /shutdown'), 200);
          return { status: 202, body: { ok: true, nodeId: hub.nodeId } };
        }

        default:
          return {
            status: 405,
            body: {
              error: 'method-not-allowed',
              detail: `${route} is not supported; use GET /health, GET /state, GET /docs?room=<id>, POST /reset`,
            },
          };
      }
    }
  }
}

/** Wait until every listed node answers /health, or throw with the stragglers. */
export async function waitForNodes(ports, { timeoutMs = 30000, host = '127.0.0.1' } = {}) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(ports);
  while (pending.size && Date.now() < deadline) {
    for (const port of [...pending]) {
      try {
        const res = await fetch(`http://${host}:${port}/health`);
        if (res.ok) pending.delete(port);
      } catch {
        /* not listening yet */
      }
    }
    if (pending.size) await sleep(200);
  }
  if (pending.size) {
    throw new Error(
      `nodes never became healthy: ${[...pending].map((p) => `${host}:${p}`).join(', ')} - check the node logs for the startup error`,
    );
  }
}
