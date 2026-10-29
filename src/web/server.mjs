/**
 * The lab console server: static pages + a small JSON API.
 *
 * Deliberately dependency-free (no express): the whole app is one process the user
 * starts with `npm run web`, it shells out to nothing, and every route is visible in
 * this file. The API is also what `npm run check` and the browser pages talk to, so
 * the console, the CLI and the docs all describe the same state.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LAB_ROOT, PUBLIC_DIR, loadLabConfig } from '../lab/paths.mjs';
import { resolveLicense } from '../server/config.mjs';
import { catalogue, comparisonMatrix } from '../lab/modes.mjs';
import { status as stackStatus, up as stackUp, down as stackDown } from '../lab/orchestrator.mjs';
import { readState, isAlive } from '../lab/state.mjs';
import { getJson } from '../lab/ports.mjs';
import { pingRedis, findBundledRedis } from '../lab/redis.mjs';
import { runCheck } from '../checks/runner.mjs';
import { runBench } from '../bench/bench.mjs';
import { BENCH_DEFAULTS, normalizeScenario, scenarioCatalogue } from '../lab/scenario.mjs';
import { latestReport } from '../checks/report.mjs';
import { findBrowser, resolvePackageEntry } from '../lab/doctor.mjs';
import { publicJsonReplacer } from '../lab/public-json.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Vendor assets served straight out of the installed packages (no build step). */
const VENDOR = {
  '/vendor/socket.io.js': () => resolvePackageEntry('socket.io', 'client-dist/socket.io.min.js'),
  '/vendor/spread-sheets.js': () =>
    resolvePackageEntry('@grapecity-software/spread-sheets', 'dist/gc.spread.sheets.all.min.js'),
  '/vendor/spread-sheets.css': () =>
    resolvePackageEntry('@grapecity-software/spread-sheets', 'styles/gc.spread.sheets.excel2013white.css'),
};

const DEFAULT_PORT = Number(process.env.SJS_LAB_WEB_PORT || 5173);

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, publicJsonReplacer, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req, limitBytes = 1_000_000) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function readClientLicense() {
  try {
    const resolved = resolveLicense();
    return { licenseKey: resolved.licenseKey, designerLicenseKey: resolved.designerLicenseKey,
      source: resolved.source, license: resolved.status };
  } catch (err) {
    return { licenseKey: '', designerLicenseKey: '', source: 'error', error: err.message,
      license: { runtime: false, designer: false, server: false } };
  }
}

/** Cache the (slowish) capability probes so the console can poll freely. */
let environmentCache = { at: 0, value: null };
async function environment() {
  if (Date.now() - environmentCache.at < 10_000 && environmentCache.value) return environmentCache.value;
  const config = loadLabConfig();
  const browser = findBrowser();
  const redisRunning = await pingRedis(config.redisUrl, 700);
  const bundled = findBundledRedis();
  const clientLicense = readClientLicense();
  const value = {
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    redis: { running: redisRunning, url: config.redisUrl, bundled, mode: redisRunning ? 'external' : bundled ? 'bundled' : 'none' },
    browser: { found: Boolean(browser), path: browser },
    license: clientLicense.license,
    licenseError: clientLicense.error ?? null,
    bundledRedis: bundled,
    labRoot: LAB_ROOT,
  };
  environmentCache = { at: Date.now(), value };
  return value;
}

/** Everything the console needs about the running stack, in one round trip. */
async function aggregateStack() {
  const config = loadLabConfig();
  const state = readState();
  if (!state) {
    return {
      running: false,
      state: null,
      describe: null,
      urls: { web: null, lb: null, lbPublic: null },
      nodes: [],
      remote: [],
      lb: null,
      redis: null,
      web: null,
      ports: { lb: config.lbPort, web: config.webPort, wsPath: config.wsPath },
      room: config.defaultRoom,
    };
  }

  const nodes = await Promise.all(
    (state.nodes ?? []).map(async (node) => {
      const base = node.base ?? `http://127.0.0.1:${node.port}`;
      const row = {
        id: node.id,
        port: node.port,
        pid: node.pid,
        remote: Boolean(node.remote),
        host: node.host ?? null,
        base,
        healthy: false,
        health: null,
        clients: [],
        rooms: [],
        docs: [],
        error: null,
      };
      try {
        const health = await getJson(`${base}/health`);
        row.health = health.ok ? health.body : null;
        row.healthy = Boolean(health.ok && health.body?.ok);
        const detail = await getJson(`${base}/state`);
        if (detail.ok && detail.body) {
          row.clients = detail.body.clients ?? [];
          row.rooms = detail.body.rooms ?? [];
          row.docs = detail.body.docs ?? [];
        }
      } catch (err) {
        row.error = err.message;
      }
      return row;
    }),
  );

  let lb = null;
  if (state.lb) {
    lb = { port: state.lb.port, pid: state.lb.pid, strategy: state.lb.strategy, healthy: false, state: null };
    try {
      const res = await getJson(`http://127.0.0.1:${state.lb.port}/__lb/state`);
      lb.state = res.ok ? res.body : null;
      lb.healthy = Boolean(res.ok);
    } catch {
      lb.healthy = false;
    }
  }

  let redis = null;
  if (state.redis) {
    redis = {
      url: state.redis.url,
      mode: state.redis.mode,
      owned: state.redis.owned,
      healthy: state.redis.owned ? isAlive(state.redis.pid) : await pingRedis(state.redis.url, 700),
    };
  }

  const host = '127.0.0.1';
  const remote = (state.remote ?? []).map((entry) => {
    const upstream = (lb?.state?.upstreams ?? []).find((up) => up.url === entry.nodeUrl || up.url === `http://${entry.nodeUrl}`);
    return { ...entry, health: upstream ? { healthy: upstream.healthy } : null };
  });
  return {
    running: true,
    state,
    describe: state.describe ?? null,
    urls: {
      web: state.web ? `http://${host}:${state.web.port}/` : `http://${host}:${config.webPort}/`,
      lb: state.lb ? `http://${host}:${state.lb.port}` : state.nodes?.[0] ? `http://${host}:${state.nodes[0].port}` : null,
      lbPublic: state.lb?.publicUrl ?? null,
    },
    nodes,
    remote,
    lb,
    redis,
    web: state.web ? { port: state.web.port, pid: state.web.pid, alive: isAlive(state.web.pid) } : null,
    ports: state.ports ?? { lb: config.lbPort, web: config.webPort, wsPath: config.wsPath },
    room: state.room ?? config.defaultRoom,
  };
}

/* -------------------------------------------------------------------------- */
/* check jobs                                                                 */
/* -------------------------------------------------------------------------- */

const jobs = new Map();

function newJob(kind) {
  const job = {
    id: randomUUID(),
    kind,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    progress: [],
    result: null,
    stats: null,
    error: null,
  };
  jobs.set(job.id, job);
  // Keep the map bounded; a long-running console session should not grow forever.
  while (jobs.size > 10) {
    const oldest = [...jobs.keys()][0];
    jobs.delete(oldest);
  }
  return job;
}

function startCheckJob(scenario) {
  const job = newJob('check');
  runCheck({
    scenario,
    onProgress: (item) => {
      job.progress.push({
        id: item.id,
        label: item.label,
        status: item.status,
        detail: item.detail,
      });
    },
  })
    .then(({ result }) => {
      job.result = result;
      job.status = 'done';
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message;
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });

  return job.id;
}

function startBenchJob({ scenario, distribute }) {
  const job = newJob('bench');
  runBench({
    scenario,
    distribute,
    log: { info: (msg) => process.stdout.write(`[lab] ${msg}\n`) },
  })
    .then((stats) => {
      job.stats = stats;
      job.status = 'done';
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message;
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });
  return job.id;
}

/* -------------------------------------------------------------------------- */
/* routing                                                                    */
/* -------------------------------------------------------------------------- */

let stackBusy = false;

async function handleApi(req, res, url) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true });

  // Internal control plane: lets `npm run down` stop the console without relying on
  // OS-level kills, which are not always permitted (sandboxes, other user sessions).
  if (req.method === 'POST' && pathname === '/shutdown') {
    json(res, 202, { ok: true });
    setTimeout(() => process.exit(0), 120);
    return undefined;
  }

  if (req.method === 'GET' && pathname === '/api/catalogue') {
    const stack = await aggregateStack();
    return json(res, 200, {
      ...catalogue(),
      comparison: comparisonMatrix(),
      scenario: scenarioCatalogue(),
      environment: await environment(),
      stack: stack.running
        ? { running: true, describe: stack.describe, config: stack.state?.config, urls: stack.urls }
        : { running: false },
    });
  }

  if (req.method === 'GET' && pathname === '/api/stack') {
    return json(res, 200, await aggregateStack());
  }

  if (req.method === 'POST' && pathname === '/api/stack/up') {
    if (stackBusy) return json(res, 409, { error: '上一个启动/停止操作还在进行，请稍候。' });
    stackBusy = true;
    try {
      const body = await readBody(req);
      const state = await stackUp({
        mode: body.mode ?? 'single',
        variant: body.variant ?? null,
        overrides: body.overrides ?? {},
        // Multi-machine: the console only DRIVES agents, it never starts them.
        agents: Array.isArray(body.agents) ? body.agents : [],
        agentToken: body.agentToken ?? null,
        // The console process is already running; do not spawn a second one.
        withWeb: false,
        log: { info: (msg) => process.stdout.write(`[lab] ${msg}\n`) },
      });
      return json(res, 200, { ok: true, state, stack: await aggregateStack() });
    } catch (err) {
      return json(res, 500, { error: '启动失败', detail: err.message });
    } finally {
      stackBusy = false;
    }
  }

  if (req.method === 'POST' && pathname === '/api/stack/down') {
    if (stackBusy) return json(res, 409, { error: '上一个启动/停止操作还在进行，请稍候。' });
    stackBusy = true;
    try {
      const stopped = await stackDown({ log: { info: (msg) => process.stdout.write(`[lab] ${msg}\n`) } });
      return json(res, 200, { ok: true, stopped, stack: await aggregateStack() });
    } catch (err) {
      return json(res, 500, { error: '停止失败', detail: err.message });
    } finally {
      stackBusy = false;
    }
  }

  if (req.method === 'POST' && pathname === '/api/check') {
    const stack = readState();
    if (!stack) return json(res, 409, { error: '没有正在运行的 stack，先启动一个拓扑。' });
    const body = await readBody(req);
    let scenario = null;
    try {
      scenario = body.scenario === undefined ? null : normalizeScenario(body.scenario);
    } catch (err) {
      return json(res, 400, { error: '场景参数不合法', detail: err.message });
    }
    return json(res, 202, { jobId: startCheckJob(scenario) });
  }

  const checkMatch = pathname.match(/^\/api\/check\/([0-9a-f-]+)$/i);
  if (req.method === 'GET' && checkMatch) {
    const job = jobs.get(checkMatch[1]);
    if (!job) return json(res, 404, { error: '没有这个体检任务' });
    return json(res, 200, job);
  }

  if (req.method === 'POST' && pathname === '/api/bench') {
    const stack = readState();
    if (!stack) return json(res, 409, { error: '没有正在运行的 stack，先启动一个拓扑。' });
    const body = await readBody(req);
    let scenario = null;
    try {
      scenario = body.scenario === undefined ? null : normalizeScenario(body.scenario, BENCH_DEFAULTS);
    } catch (err) {
      return json(res, 400, { error: '场景参数不合法', detail: err.message });
    }
    // `true` = this machine + every attached agent; an array = exactly those.
    const distribute = body.distribute === undefined ? false : body.distribute;
    if (distribute !== true && !Array.isArray(distribute) && distribute !== false) {
      return json(res, 400, { error: 'distribute 只能是 true/false 或参与者数组（如 ["local","http://h1:9100"]）' });
    }
    return json(res, 202, { jobId: startBenchJob({ scenario, distribute }) });
  }

  const benchMatch = pathname.match(/^\/api\/bench\/([0-9a-f-]+)$/i);
  if (req.method === 'GET' && benchMatch) {
    const job = jobs.get(benchMatch[1]);
    if (!job) return json(res, 404, { error: '没有这个压测任务' });
    return json(res, 200, { id: job.id, status: job.status, error: job.error, stats: job.stats, startedAt: job.startedAt, finishedAt: job.finishedAt });
  }

  if (req.method === 'GET' && pathname === '/api/report/latest') {
    const report = latestReport();
    if (!report) return json(res, 404, { error: '还没有生成过报告，先运行一次体检。' });
    return json(res, 200, report);
  }

  if (req.method === 'GET' && pathname === '/api/collab-config') {
    const stack = readState();
    const config = loadLabConfig();
    const license = readClientLicense();
    if (license.error) return json(res, 400, { error: '授权配置错误', detail: license.error });
    const host = (req.headers.host ?? '127.0.0.1:5173').split(':')[0];
    // Prefer the load balancer: it is the address a real deployment hands to browsers.
    const wsUrl = stack?.lb
      ? `http://${host}:${stack.lb.port}`
      : stack?.nodes?.[0]
        ? `http://${host}:${stack.nodes[0].port}`
        : null;
    return json(res, 200, {
      wsUrl,
      path: stack?.ports?.wsPath ?? config.wsPath,
      impl: stack?.config?.impl ?? 'mirror',
      room: config.defaultRoom,
      licenseKey: license.licenseKey,
      designerLicenseKey: license.designerLicenseKey,
      license: license.license,
      source: license.source,
    });
  }

  return json(res, 404, { error: `未知的 API 路径 ${pathname}` });
}

function serveStatic(req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return json(res, 400, { error: '非法路径' });
  }

  const vendorResolver = VENDOR[pathname];
  if (vendorResolver) {
    const file = vendorResolver();
    if (!file || !existsSync(file)) {
      return json(res, 404, {
        error: `缺少静态依赖 ${pathname}`,
        detail: '先运行 npm install（依赖需包含 socket.io 与 @grapecity-software/spread-sheets）。',
      });
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=3600',
    });
    createReadStream(file).pipe(res);
    return undefined;
  }

  if (pathname === '/') pathname = '/index.html';
  else if (pathname.endsWith('/')) pathname = `${pathname}index.html`;

  const filePath = resolve(PUBLIC_DIR, `.${pathname}`);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    return json(res, 403, { error: '禁止访问该路径' });
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    if (pathname.startsWith('/official') && pathname.endsWith('bundle.js')) {
      return json(res, 404, {
        error: '官方客户端还没有构建',
        detail: '运行 npm run build:official 生成 public/official/bundle.js（需要 webpack 与官方协同客户端依赖）。',
      });
    }
    return json(res, 404, { error: `找不到 ${pathname}` });
  }

  const ext = extname(filePath);
  const isHtml = ext === '.html';
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': isHtml ? 'no-store' : 'public, max-age=300',
  });
  createReadStream(filePath).pipe(res);
  return undefined;
}

export function createLabServer({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/shutdown') {
        await handleApi(req, res, url);
        return;
      }
      serveStatic(req, res, url);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: '服务器内部错误', detail: err.message });
      else res.end();
    }
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.destroy();
    } catch {
      /* gone */
    }
  });

  return {
    server,
    listen: () =>
      new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolvePromise(`http://${host}:${port}/`);
        });
      }),
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
    port,
    host,
  };
}

/* -------------------------------------------------------------------------- */
/* CLI entry                                                                  */
/* -------------------------------------------------------------------------- */

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const hostArg = process.argv.find((a) => a.startsWith('--host='));
  const port = portArg ? Number(portArg.split('=')[1]) : DEFAULT_PORT;
  const host = hostArg ? hostArg.split('=')[1] : '127.0.0.1';
  const app = createLabServer({ port, host });
  const url = await app.listen();
  process.stdout.write(`[web] 控制台已启动 ${url}\n`);
  process.stdout.write('[web] 未运行任何拓扑时，控制台会显示“未运行”，可在页面上直接启动。\n');
  const shutdown = async () => {
    process.stdout.write('[web] 正在关闭…\n');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
