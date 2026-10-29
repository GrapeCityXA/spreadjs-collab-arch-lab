#!/usr/bin/env node
/**
 * Remote agent host for the architecture lab (DEV-CONTRACT §12).
 *
 *   node src/remote/agent.mjs --port=9100 --lb=http://<controller>:3000 \
 *     --token=<token> --public-host=<ip-or-hostname> [--node-port=8081] \
 *     [--impl=mirror|real] [--node-id=...] [--path=/collaboration/]
 *
 * The controller runs the orchestrator, load balancer, console and Redis. An agent
 * host runs exactly two things: ONE collaboration node (a child process) and a load
 * generator, both driven over the small HTTP surface below. It never starts a load
 * balancer or Redis.
 *
 *   GET  /health              open liveness        {ok:true, role:'agent'}
 *   GET  /agent/status        control              {ok, host, nodePort, node, load}
 *   POST /agent/attach        control              start node + register in the LB
 *   POST /agent/detach        control              deregister + stop node
 *   POST /agent/load          control              run load, return the stats object
 *   POST /agent/load/cancel   control              abort the running load
 *   POST /agent/shutdown      control              deregister, stop node, exit 0
 *
 * Every `/agent/*` request needs `x-lab-token` equal to `--token`; `/health` is open
 * because the controller uses it as a liveness probe before it knows whether a token
 * was accepted. Starting with no token is allowed but leaves the control plane
 * unusable (401) instead of silently open - same reasoning as the LB admin API.
 *
 * Safety rules that this file enforces rather than documents:
 *   - the node child inherits a log file descriptor; `stdio: 'pipe'` is blocked in
 *     sandboxed environments (EPERM) and would deadlock a long-lived server anyway;
 *   - an agent only deregisters the exact upstream URL it registered;
 *   - every outbound call has a hard deadline (attach 30 s, detach 10 s, LB calls
 *     bounded), so a dead controller cannot wedge an agent;
 *   - the token is never printed (startup log says `token: SET` / `MISSING`).
 *
 * `--public-host` is the address AS THE LOAD BALANCER SEES IT. On a real agent host
 * it must be the machine's reachable address, not 127.0.0.1. The node is bound
 * accordingly: a loopback public host binds loopback, anything else binds 0.0.0.0 so
 * the controller can reach it. `--bind-host` / `SJS_BIND_HOST` override both.
 */
import { createServer } from 'node:http';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseArgs } from '../server/config.mjs';
import { LAB_ROOT } from '../lab/paths.mjs';
import { isAlive } from '../lab/state.mjs';
import { spawnBackground, killTree } from '../lab/proc.mjs';
import { getJson, postJson, sleep, probeTcp, waitForJson, waitPortFree } from '../lab/ports.mjs';
import { runLoad } from '../bench/load.mjs';

/** Bounded outbound timeouts (DEV-CONTRACT §12). */
const ATTACH_TIMEOUT_MS = 30_000;
const DETACH_TIMEOUT_MS = 10_000;
const NODE_START_TIMEOUT_MS = 30_000;
const NODE_STOP_TIMEOUT_MS = 5_000;
const STATUS_PROBE_TIMEOUT_MS = 1_500;
const SHUTDOWN_LB_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 256 * 1024;
const NODE_SCRIPT = resolve(LAB_ROOT, 'src/server/node-server.mjs');
const NODE_SUPERVISOR_SCRIPT = resolve(LAB_ROOT, 'src/remote/node-supervisor.mjs');

const LOG_PREFIX = '[agent]';

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function logWarn(message) {
  log(`WARN ${message}`);
}

function logError(message) {
  log(`ERROR ${message}`);
}

// ---------------------------------------------------------------- configuration
const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  process.stdout.write(
    [
      'usage: node src/remote/agent.mjs --port=9100 --lb=http://<controller>:3000 \\',
      '         --token=<token> --public-host=<ip-or-hostname> [--node-port=8081] \\',
      '         [--impl=mirror|real] [--node-id=...] [--path=/collaboration/] [--bind-host=...]',
      '',
      'env: SJS_AGENT_PORT SJS_LB_URL SJS_LB_ADMIN_TOKEN SJS_PUBLIC_HOST SJS_AGENT_NODE_PORT',
      '     SJS_IMPL SJS_NODE_ID SJS_PATH SJS_BIND_HOST',
      '',
      'The controller starts an agent on each extra machine; this process starts one',
      'collaboration node and the load generator, and registers the node in the LB.',
    ].join('\n') + '\n',
  );
  process.exit(0);
}

function envValue(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function toPort(value, what) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${what} must be an integer between 1 and 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

function toChoice(value, allowed, what) {
  const lowered = String(value).toLowerCase();
  if (!allowed.includes(lowered)) {
    throw new Error(`${what} must be one of ${allowed.join('|')}, got ${JSON.stringify(value)}`);
  }
  return lowered;
}

/** Normalize `h1:9100`, `http://h1:9100/` to `http://h1:9100` (never keeps a secret). */
function normalizeUrl(value, what) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`${what} is not a URL: ${JSON.stringify(value)}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${what} must be http(s): ${JSON.stringify(value)}`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function isLoopbackHost(host) {
  const text = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return text === 'localhost' || text === '127.0.0.1' || text === '::1' || text.endsWith('.localhost');
}

/** Node ids carry the host so two agents can never claim the same id. */
function hostSlug(host) {
  return String(host).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
}

let cfg;
try {
  const port = toPort(args.port ?? envValue('SJS_AGENT_PORT') ?? 9100, 'agent port (--port / SJS_AGENT_PORT)');
  const nodePort = toPort(
    args['node-port'] ?? envValue('SJS_AGENT_NODE_PORT') ?? 8081,
    'node port (--node-port / SJS_AGENT_NODE_PORT)',
  );
  const publicHost = String(args['public-host'] ?? envValue('SJS_PUBLIC_HOST') ?? os.hostname()).trim();
  if (!publicHost) throw new Error('--public-host must not be empty');
  const impl = toChoice(args.impl ?? envValue('SJS_IMPL') ?? 'mirror', ['mirror', 'real'], '--impl / SJS_IMPL');
  const path = String(args.path ?? envValue('SJS_PATH') ?? '/collaboration/');
  const nodeId = String(args['node-id'] ?? envValue('SJS_NODE_ID') ?? `node-${hostSlug(publicHost)}-${nodePort}`);
  const lbUrl = normalizeUrl(args.lb ?? envValue('SJS_LB_URL'), '--lb / SJS_LB_URL');
  // Not printed anywhere; only its presence is.
  const token = String(args.token ?? envValue('SJS_LB_ADMIN_TOKEN') ?? '');
  const bindHost = String(
    args['bind-host'] ?? envValue('SJS_BIND_HOST') ?? (isLoopbackHost(publicHost) ? '127.0.0.1' : '0.0.0.0'),
  );
  cfg = { port, nodePort, publicHost, impl, path, nodeId, lbUrl, token, bindHost };
} catch (err) {
  logError(err.message);
  process.exit(2);
}

const startedAt = Date.now();

// ------------------------------------------------------------------- runtime state
/**
 * @type {null | {pid:number, port:number, nodeId:string, logFile:string, startedAt:number, topologyEnv:object}}
 */
let nodeChild = null;
/** @type {{lbUrl:string, nodeUrl:string, nodeId:string, attachedAt:number}|null} */
let attachment = null;
/** @type {{controller:AbortController, startedAt:number, users:number, progress:object|null, promise:Promise<any>}|null} */
let activeLoad = null;
let shuttingDown = false;

// ------------------------------------------------------------------ child process
/** Absolute path of the node log, kept short so error messages stay readable. */
function nodeLogFile(port) {
  return `logs/agent-${cfg.port}-node-${port}.log`;
}

function readTail(file, lines = 20) {
  try {
    const text = readFileSync(resolve(LAB_ROOT, file), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '(没有日志)';
  }
}

function nodeHealthUrl(port) {
  return `http://127.0.0.1:${port}/health`;
}

// ------------------------------------------------------- node configuration model
/**
 * Which env variables define a node's topology. This is exactly the `nodeConfig`
 * surface of DEV-CONTRACT §12 - adding a key here is a contract change.
 */
const TOPOLOGY_ENV_KEYS = [
  'SJS_IMPL',
  // Store before adapter so a `shared` -> `local` regression is reported as
  // "store=local ≠ shared" (the actual correctness bug) rather than a derived flag.
  'SJS_STORE',
  'SJS_STORE_FILE',
  'SJS_ADAPTER',
  'SJS_REDIS_URL',
  'SJS_PATH',
  'SJS_OT',
  'SJS_OT_DB',
  'SJS_OT_DB_FILE',
  'SJS_PRESENCE',
];
const BOOLEAN_ENV_KEYS = new Set(['SJS_ADAPTER', 'SJS_OT', 'SJS_PRESENCE']);
/** Env the node understands but that the agent never accepts through `nodeConfig`. */
const INHERITED_ENV_KEYS = ['SJS_LICENSE_FILE', 'SJS_ROOM', 'SJS_REDIS_CONNECT_TIMEOUT_MS'];
/** Owned by the agent: `nodeConfig` may not override port / node id / bind address. */
const AGENT_OWNED_ENV_KEYS = ['SJS_PORT', 'SJS_NODE_ID', 'SJS_BIND_HOST'];
const FRIENDLY_ENV_NAMES = {
  SJS_IMPL: 'impl',
  SJS_ADAPTER: 'adapter',
  SJS_REDIS_URL: 'redis',
  SJS_PATH: 'path',
  SJS_STORE: 'store',
  SJS_STORE_FILE: 'storeFile',
  SJS_OT: 'ot',
  SJS_OT_DB: 'otDb',
  SJS_OT_DB_FILE: 'otDbFile',
  SJS_PRESENCE: 'presence',
};

function isTruthy(value) {
  if (value === undefined || value === null || value === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Normalize a topology env into the effective values the node will run with, so
 * "absent" and "explicit default" compare equal (otherwise every attach without
 * `nodeConfig` would look like a config change and restart the node).
 */
function normalizeTopology(env) {
  const defaults = {
    SJS_IMPL: cfg.impl,
    SJS_ADAPTER: '1',
    SJS_REDIS_URL: 'redis://127.0.0.1:6379',
    SJS_PATH: cfg.path,
    SJS_STORE: 'local',
    SJS_STORE_FILE: resolve(LAB_ROOT, 'data/lab-store.sqlite'),
    SJS_OT: '0',
    SJS_OT_DB: 'sqlite',
    SJS_OT_DB_FILE: resolve(LAB_ROOT, 'data/ot.sqlite'),
    SJS_PRESENCE: '0',
  };
  const out = {};
  for (const key of TOPOLOGY_ENV_KEYS) {
    const raw = env?.[key] ?? defaults[key];
    if (BOOLEAN_ENV_KEYS.has(key)) out[key] = isTruthy(raw) ? '1' : '0';
    else if (key === 'SJS_STORE_FILE' || key === 'SJS_OT_DB_FILE') out[key] = resolve(LAB_ROOT, String(raw));
    else out[key] = String(raw).trim();
  }
  return out;
}

function friendlyEnvValue(key, value) {
  if (BOOLEAN_ENV_KEYS.has(key)) return value === '1' ? 'on' : 'off';
  return value;
}

/** One readable difference line (`store=local ≠ shared`) or null when equivalent. */
function describeTopologyDiff(currentEnv, desiredEnv) {
  const current = normalizeTopology(currentEnv);
  const desired = normalizeTopology(desiredEnv);
  for (const key of TOPOLOGY_ENV_KEYS) {
    if (current[key] === desired[key]) continue;
    return `${FRIENDLY_ENV_NAMES[key]}=${friendlyEnvValue(key, current[key])} ≠ ${friendlyEnvValue(key, desired[key])}`;
  }
  return null;
}

/** Topology implied by the agent's own flags/env, before any controller `nodeConfig`. */
function agentTopologyEnv() {
  const env = {};
  for (const key of [...TOPOLOGY_ENV_KEYS, ...INHERITED_ENV_KEYS]) {
    const value = envValue(key);
    if (value !== undefined) env[key] = value;
  }
  // The agent's own flags are its defaults; a controller `nodeConfig` overrides them
  // later because it is authoritative for the topology of the deployed stack.
  env.SJS_IMPL = cfg.impl;
  env.SJS_PATH = cfg.path;
  return env;
}

/** Validate `nodeConfig` and return only the accepted topology overrides. */
function parseNodeConfig(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('nodeConfig 必须是一个对象（部分环境变量），例如 {SJS_STORE:"shared"}'), { status: 400 });
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (AGENT_OWNED_ENV_KEYS.includes(key)) {
      throw Object.assign(
        new Error(
          `nodeConfig 不能包含 ${key}：节点端口/ID/绑定地址由 agent 的 --node-port / --node-id / --bind-host 决定`,
        ),
        { status: 400 },
      );
    }
    if (!TOPOLOGY_ENV_KEYS.includes(key)) {
      throw Object.assign(new Error(`nodeConfig 不支持 ${key}；允许的键：${TOPOLOGY_ENV_KEYS.join(', ')}`), {
        status: 400,
      });
    }
    if (value === undefined || value === null || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

function nodeSpawnEnv(port, topologyEnv) {
  return {
    SJS_PORT: String(port),
    SJS_NODE_ID: cfg.nodeId,
    SJS_BIND_HOST: cfg.bindHost,
    ...topologyEnv,
  };
}

/** Verify the node really came up with the requested topology (never trust the flag). */
function describeHealthMismatch(health, topologyEnv) {
  const desired = normalizeTopology(topologyEnv);
  const problems = [];
  if (health?.impl !== desired.SJS_IMPL) problems.push(`impl=${health?.impl} ≠ ${desired.SJS_IMPL}`);
  const wantAdapter = desired.SJS_ADAPTER === '1';
  if (Boolean(health?.adapterEnabled) !== wantAdapter) {
    problems.push(`adapter=${health?.adapterEnabled ? 'on' : 'off'} ≠ ${wantAdapter ? 'on' : 'off'}`);
  }
  // impl=real derives storeMode from the OT database, so only the mirror's store mode
  // is a direct function of SJS_STORE.
  if (desired.SJS_IMPL === 'mirror' && health?.storeMode !== desired.SJS_STORE) {
    problems.push(`store=${health?.storeMode} ≠ ${desired.SJS_STORE}`);
  }
  if (Boolean(health?.otEnabled) !== (desired.SJS_OT === '1')) {
    problems.push(`ot=${health?.otEnabled ? 'on' : 'off'} ≠ ${desired.SJS_OT === '1' ? 'on' : 'off'}`);
  }
  if (Boolean(health?.presenceEnabled) !== (desired.SJS_PRESENCE === '1')) {
    problems.push(`presence=${health?.presenceEnabled ? 'on' : 'off'} ≠ ${desired.SJS_PRESENCE === '1' ? 'on' : 'off'}`);
  }
  return problems.length ? problems.join('，') : null;
}

/**
 * Make the node run with exactly `topologyEnv`: reuse it when the effective config
 * matches, restart it when it does not, start it when it is not running.
 *
 * @returns {{node: object, restarted: boolean}}
 */
async function ensureNode(port, topologyEnv) {
  if (nodeChild && isAlive(nodeChild.pid) && nodeChild.port === port) {
    const health = await getJson(nodeHealthUrl(port), STATUS_PROBE_TIMEOUT_MS).catch(() => null);
    if (health?.ok && health.body?.ok) {
      const diff = describeTopologyDiff(nodeChild.topologyEnv, topologyEnv);
      if (!diff) {
        log(`node 配置一致，复用 pid ${nodeChild.pid}`);
        return { node: nodeChild, restarted: false };
      }
      log(`node 配置不一致（${diff}），按 controller 配置重启`);
      await stopNode();
    } else {
      log('node 无响应，重新启动');
      await stopNode();
    }
  } else if (nodeChild) {
    if (nodeChild.port !== port) log(`node 端口变更 :${nodeChild.port} -> :${port}，重启节点`);
    await stopNode();
  }

  // A colliding --node-port is a launch error (DEV-CONTRACT §12). Anything answering
  // here is a real configuration conflict: the node supervisor makes a leaked node
  // impossible on every normal exit path, so there is nothing legitimate to adopt.
  if ((await probeTcp(port)) === 'responding') {
    const existing = await getJson(nodeHealthUrl(port), STATUS_PROBE_TIMEOUT_MS).catch(() => null);
    const who = existing?.body?.nodeId ? `（nodeId=${existing.body.nodeId}）` : '';
    throw Object.assign(
      new Error(
        `节点端口 ${port} 已被其它进程占用${who}。请用 --node-port=<空闲端口> 启动 agent，或先停止占用该端口的进程。`,
      ),
      { status: 502 },
    );
  }

  const spawnEnv = nodeSpawnEnv(port, topologyEnv);
  const logFile = nodeLogFile(port);
  let child;
  try {
    // The supervisor is an ordinary child of this agent: `killTree(agent.pid)` /
    // `taskkill /T /F` reaps it AND the node, and its parent watchdog covers a
    // SIGKILL of the agent. A plain detached node child would leak the port.
    child = spawnBackground(
      process.execPath,
      [
        NODE_SUPERVISOR_SCRIPT,
        `--parent-pid=${process.pid}`,
        '--',
        NODE_SCRIPT,
        `--port=${port}`,
        `--node-id=${cfg.nodeId}`,
      ],
      { logFile, env: spawnEnv, cwd: LAB_ROOT },
    );
  } catch (err) {
    throw new Error(`无法启动协同节点（${NODE_SCRIPT}）：${err.message}`);
  }

  let health;
  try {
    health = await waitForJson(nodeHealthUrl(port), {
      timeoutMs: NODE_START_TIMEOUT_MS,
      label: `协同节点 :${port}`,
      validate: (body) => body?.ok === true && body.nodeId === cfg.nodeId,
    });
  } catch (err) {
    // The node may have exited immediately (invalid config, Redis unreachable,
    // real impl without license). Its log is the only place with the real reason.
    killTree(child.pid);
    const tail = readTail(logFile);
    throw Object.assign(
      new Error(
        `协同节点 :${port} 在 ${NODE_START_TIMEOUT_MS / 1000}s 内没有就绪（nodeId=${cfg.nodeId}）：${err.message}\n` +
          `--- ${logFile}（末尾）---\n${tail}\n` +
          `提示：端口冲突请用 --node-port=<空闲端口>；impl=real 需要授权；SJS_ADAPTER=1 需要可达的 Redis。`,
      ),
      { status: 502 },
    );
  }

  const mismatch = describeHealthMismatch(health, topologyEnv);
  if (mismatch) {
    killTree(child.pid);
    await waitPortFree(port, NODE_STOP_TIMEOUT_MS);
    throw Object.assign(
      new Error(`节点 :${port} 已启动但实际配置与期望不一致：${mismatch}（nodeId=${cfg.nodeId}）`),
      { status: 502 },
    );
  }

  const effective = normalizeTopology(topologyEnv);
  nodeChild = {
    pid: child.pid,
    port,
    nodeId: cfg.nodeId,
    logFile: child.logFile,
    startedAt: Date.now(),
    topologyEnv: { ...topologyEnv },
  };
  log(`node :${port} ready (nodeId=${cfg.nodeId}, pid ${child.pid}, impl=${effective.SJS_IMPL}, store=${effective.SJS_STORE})`);
  return { node: nodeChild, restarted: true };
}

/** Stop the node child: control-plane shutdown → OS kill → verify. Bounded. */
async function stopNode() {
  const child = nodeChild;
  nodeChild = null;
  if (!child) return { stopped: false, graceful: false };
  let graceful = false;
  if (isAlive(child.pid)) {
    const res = await postJson(`http://127.0.0.1:${child.port}/shutdown`, null, 1_500);
    graceful = res.status === 200 || res.status === 202;
    if (graceful) await waitPortFree(child.port, NODE_STOP_TIMEOUT_MS);
    const deadline = Date.now() + NODE_STOP_TIMEOUT_MS;
    while (isAlive(child.pid) && Date.now() < deadline) await sleep(100);
    if (isAlive(child.pid)) killTree(child.pid);
    for (let i = 0; i < 30 && isAlive(child.pid); i++) await sleep(100);
  }
  const alive = isAlive(child.pid);
  if (alive) logWarn(`node :${child.port} (pid ${child.pid}) 仍在运行，可能需要在系统层面停止它`);
  else log(`node :${child.port} stopped (graceful=${graceful})`);
  return { stopped: !alive, graceful, port: child.port };
}

// --------------------------------------------------------------------- LB helpers
function withTimeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function fetchJson(url, { method = 'GET', body, token, timeoutMs } = {}) {
  const { signal, done } = withTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { 'x-lab-token': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    return { status: res.status, ok: res.ok, body: payload };
  } finally {
    done();
  }
}

/** Turn an LB admin failure into the one sentence that tells the operator what to fix. */
function describeLbFailure(action, lbUrl, errOrRes) {
  if (errOrRes?.status) {
    const { status, body } = errOrRes;
    // Keep both machine-readable fields: `admin-disabled` is the error code and the
    // detail names the env var; dropping either makes the message unsearchable.
    const detail = [body?.error, body?.detail].filter(Boolean).join(' - ');
    const hint =
      status === 403
        ? 'LB 未启用管理 API：controller 侧启动 LB 时必须设置 SJS_LB_ADMIN_TOKEN。'
        : status === 401
          ? 'token 与 LB 的 SJS_LB_ADMIN_TOKEN 不一致；检查 agent 的 --token 是否与 controller 的 --agent-token 相同。'
          : status === 404
            ? 'LB 上没有 /__lb/upstreams（版本不一致？agent 与 controller 必须使用同一个 commit）。'
            : '';
    return `${action} 失败：${lbUrl} 返回 HTTP ${status}${detail ? `（${detail}）` : ''}。${hint}`;
  }
  const message = errOrRes?.name === 'AbortError' ? '调用超时' : errOrRes?.message ?? String(errOrRes);
  return `${action} 失败：无法连接 ${lbUrl}（${message}）。检查 --lb 地址、网络与防火墙。`;
}

async function registerUpstream({ lbUrl, token, nodeUrl }) {
  let res;
  try {
    res = await fetchJson(`${lbUrl}/__lb/upstreams`, {
      method: 'POST',
      body: { url: nodeUrl },
      token,
      timeoutMs: ATTACH_TIMEOUT_MS,
    });
  } catch (err) {
    // The agent is healthy; the LB (an upstream dependency) failed. 502 tells the
    // controller "not our config, retry the LB" and keeps the message actionable.
    throw Object.assign(new Error(describeLbFailure('注册 upstream', lbUrl, err)), { status: 502 });
  }
  if (!res.ok) throw Object.assign(new Error(describeLbFailure('注册 upstream', lbUrl, res)), { status: 502 });
  return res.body;
}

async function deregisterUpstream({ lbUrl, token, nodeUrl }) {
  let res;
  try {
    res = await fetchJson(`${lbUrl}/__lb/upstreams?url=${encodeURIComponent(nodeUrl)}`, {
      method: 'DELETE',
      token,
      timeoutMs: DETACH_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, error: describeLbFailure('注销 upstream', lbUrl, err) };
  }
  if (!res.ok) return { ok: false, error: describeLbFailure('注销 upstream', lbUrl, res) };
  return { ok: true, body: res.body };
}

// -------------------------------------------------------------------- agent logic
function nodeUrlFor(port) {
  return `http://${cfg.publicHost}:${port}`;
}

function effectiveLbUrl(bodyLbUrl) {
  return normalizeUrl(bodyLbUrl ?? cfg.lbUrl, 'lbUrl');
}

async function attach({ lbUrl, token, nodePort, nodeConfig }) {
  let targetLb;
  try {
    targetLb = effectiveLbUrl(lbUrl);
  } catch (err) {
    throw Object.assign(new Error(`lbUrl 无效：${err.message}`), { status: 400 });
  }
  if (!targetLb) throw Object.assign(new Error('attach 需要 lbUrl（body.lbUrl 或启动参数 --lb）'), { status: 400 });
  const lbToken = token || cfg.token;
  if (!lbToken) {
    throw Object.assign(
      new Error('attach 需要 LB 管理员 token（body.token 或启动参数 --token / SJS_LB_ADMIN_TOKEN），否则 LB 会拒绝注册'),
      { status: 400 },
    );
  }
  // `nodeConfig` is authoritative for the topology; the agent's own flags/env are
  // only the defaults when the controller does not send one (DEV-CONTRACT §12).
  const topologyEnv = { ...agentTopologyEnv(), ...parseNodeConfig(nodeConfig) };
  const port = nodePort ? toPort(nodePort, 'body.nodePort') : nodeChild?.port ?? cfg.nodePort;
  const { node, restarted } = await ensureNode(port, topologyEnv);
  const nodeUrl = nodeUrlFor(node.port);
  // A node moved to another port (or registered with another LB) must not leave a
  // stale upstream behind: the LB would keep routing to a URL nothing serves.
  if (attachment && attachment.nodeUrl !== nodeUrl) {
    const previous = attachment;
    const removed = await deregisterUpstream({ lbUrl: previous.lbUrl, token: lbToken, nodeUrl: previous.nodeUrl });
    if (removed.ok) log(`attach: dropped stale upstream ${previous.nodeUrl} (${previous.lbUrl})`);
    else logWarn(`attach: could not deregister previous upstream ${previous.nodeUrl}: ${removed.error}`);
    attachment = null;
  }
  const upstreams = await registerUpstream({ lbUrl: targetLb, token: lbToken, nodeUrl });
  attachment = { lbUrl: targetLb, nodeUrl, nodeId: node.nodeId, attachedAt: Date.now() };
  log(`attached ${nodeUrl} -> ${targetLb} (nodeId=${node.nodeId})`);
  return {
    ok: true,
    nodeUrl,
    nodeId: node.nodeId,
    host: cfg.publicHost,
    nodePort: node.port,
    restarted,
    upstreams: Array.isArray(upstreams?.upstreams) ? upstreams.upstreams : undefined,
  };
}

async function detach({ lbUrl, token }) {
  const registered = attachment;
  let targetLb;
  try {
    targetLb = normalizeUrl(lbUrl ?? registered?.lbUrl ?? cfg.lbUrl, 'lbUrl');
  } catch (err) {
    throw Object.assign(new Error(`lbUrl 无效：${err.message}`), { status: 400 });
  }
  const lbToken = token || cfg.token;

  let deregistered = false;
  let warning = null;
  if (registered) {
    if (!targetLb) {
      warning = '没有 lbUrl，跳过 deregister（节点仍会被停止）';
    } else if (!lbToken) {
      warning = '没有 LB 管理员 token，跳过 deregister（节点仍会被停止）';
    } else {
      // Only the exact URL this agent registered is ever removed (DEV-CONTRACT §12).
      const result = await deregisterUpstream({ lbUrl: targetLb, token: lbToken, nodeUrl: registered.nodeUrl });
      deregistered = result.ok;
      if (!result.ok) warning = result.error;
      if (result.ok) log(`deregistered ${registered.nodeUrl} from ${targetLb}`);
    }
    attachment = null;
  }
  const stopped = await stopNode();
  if (warning) logWarn(`detach: ${warning}`);
  return {
    ok: true,
    nodeUrl: registered?.nodeUrl ?? null,
    deregistered,
    nodeStopped: stopped.stopped,
    ...(warning ? { warning } : {}),
  };
}

/** Health of the local node, or null when it is not running (never throws). */
async function localNodeHealth() {
  if (!nodeChild) return null;
  try {
    const res = await getJson(nodeHealthUrl(nodeChild.port), STATUS_PROBE_TIMEOUT_MS);
    return res.ok ? res.body : null;
  } catch {
    return null;
  }
}

function loadSnapshot() {
  if (!activeLoad) return { running: false, users: 0 };
  return {
    running: true,
    users: activeLoad.users,
    startedAt: activeLoad.startedAt,
    elapsedMs: Date.now() - activeLoad.startedAt,
    progress: activeLoad.progress,
  };
}

async function statusBody() {
  const node = await localNodeHealth();
  return {
    ok: true,
    host: cfg.publicHost,
    hostname: os.hostname(),
    port: cfg.port,
    nodePort: nodeChild?.port ?? cfg.nodePort,
    nodeId: nodeChild?.nodeId ?? null,
    node,
    attached: attachment ? { lbUrl: attachment.lbUrl, nodeUrl: attachment.nodeUrl, since: attachment.attachedAt } : null,
    load: loadSnapshot(),
    impl: cfg.impl,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    defaultLbUrl: cfg.lbUrl,
    token: cfg.token ? 'SET' : 'MISSING',
  };
}

/** One load at a time; the agent is a load generator, not a scheduler. */
async function runLoadRequest(body) {
  if (activeLoad) {
    const busy = Object.assign(new Error('busy'), { status: 409, load: loadSnapshot() });
    throw busy;
  }
  const url =
    normalizeUrl(body?.lbUrl, 'body.lbUrl') ??
    cfg.lbUrl ??
    (nodeChild ? `http://127.0.0.1:${nodeChild.port}` : null);
  if (!url) {
    throw Object.assign(
      new Error('load 需要 lbUrl（body.lbUrl、启动参数 --lb，或一个正在运行的本地节点）'),
      { status: 400 },
    );
  }
  const options = {
    url,
    path: body?.path ?? cfg.path,
    users: body?.users ?? 10,
    opIntervalMs: body?.opIntervalMs ?? 1_000,
    durationMs: body?.durationMs ?? 5_000,
    rooms: body?.rooms ?? 1,
    roomPrefix: body?.roomPrefix ?? 'agent-load',
  };
  const controller = new AbortController();
  activeLoad = { controller, startedAt: Date.now(), users: Number(options.users) || 0, progress: null, promise: null };
  try {
    const stats = await runLoad({
      ...options,
      signal: controller.signal,
      onProgress: (progress) => {
        if (activeLoad) activeLoad.progress = progress;
      },
    });
    log(
      `load done: url=${url} users=${stats?.users} ops=${stats?.ops} ` +
        `p95=${stats?.ackMs?.p95 ?? '-'}ms cancelled=${Boolean(stats?.cancelled)}`,
    );
    return stats;
  } finally {
    activeLoad = null;
  }
}

function cancelLoad() {
  if (!activeLoad) return { ok: true, cancelled: false, detail: '没有正在运行的负载' };
  try {
    activeLoad.controller.abort();
  } catch {
    /* already settled */
  }
  return { ok: true, cancelled: true };
}

// ------------------------------------------------------------------- HTTP plumbing
function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Read and parse a JSON body with a hard size cap. */
function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolvePromise({});
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400 }));
        }
        resolvePromise(parsed);
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', (err) => reject(Object.assign(err, { status: 400 })));
  });
}

/** True when the request carries the configured agent token. */
function authorized(req) {
  if (!cfg.token) return false;
  const header = req.headers['x-lab-token'];
  return typeof header === 'string' && header.length > 0 && header === cfg.token;
}

const ROUTES = {
  '/health': { methods: ['GET'], auth: false },
  '/agent/status': { methods: ['GET'], auth: true },
  '/agent/attach': { methods: ['POST'], auth: true },
  '/agent/detach': { methods: ['POST'], auth: true },
  '/agent/load': { methods: ['POST'], auth: true },
  '/agent/load/cancel': { methods: ['POST'], auth: true },
  '/agent/shutdown': { methods: ['POST'], auth: true },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://agent.local');
  const route = ROUTES[url.pathname];
  if (!route) {
    sendJson(res, 404, { error: 'not-found', detail: `${req.method} ${url.pathname} 不存在；见 /health 与 DEV-CONTRACT §12` });
    return;
  }
  if (!route.methods.includes(req.method)) {
    sendJson(res, 405, {
      error: 'method-not-allowed',
      detail: `${url.pathname} 只接受 ${route.methods.join('/')}`,
    });
    return;
  }
  if (route.auth && !authorized(req)) {
    sendJson(res, 401, {
      error: 'unauthorized',
      detail: cfg.token
        ? '缺少或错误的 x-lab-token（必须与 agent 启动时的 --token 相同）'
        : 'agent 启动时没有配置 --token，控制面不可用',
    });
    return;
  }

  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, role: 'agent', host: cfg.publicHost, port: cfg.port });
      return;
    }
    if (url.pathname === '/agent/status' && req.method === 'GET') {
      sendJson(res, 200, await statusBody());
      return;
    }

    const body = await readJsonBody(req);

    if (url.pathname === '/agent/attach' && req.method === 'POST') {
      const result = await attach({
        lbUrl: body.lbUrl,
        token: body.token,
        nodePort: body.nodePort,
        nodeConfig: body.nodeConfig,
      });
      sendJson(res, 200, result);
      return;
    }
    if (url.pathname === '/agent/detach' && req.method === 'POST') {
      sendJson(res, 200, await detach({ lbUrl: body.lbUrl, token: body.token }));
      return;
    }
    if (url.pathname === '/agent/load' && req.method === 'POST') {
      sendJson(res, 200, await runLoadRequest(body));
      return;
    }
    if (url.pathname === '/agent/load/cancel' && req.method === 'POST') {
      sendJson(res, 200, cancelLoad());
      return;
    }
    if (url.pathname === '/agent/shutdown' && req.method === 'POST') {
      // Answer before cleaning up: the controller must get its 200 even though the
      // process disappears shortly afterwards.
      sendJson(res, 200, { ok: true, nodePort: nodeChild?.port ?? cfg.nodePort });
      setTimeout(() => {
        cleanup('POST /agent/shutdown').finally(() => process.exit(0));
      }, 150);
      return;
    }
  } catch (err) {
    const status = Number(err?.status) || (err?.code === 'TOO_MANY_CLIENTS' ? 400 : 500);
    sendJson(res, status, {
      ...(err?.status === 409 ? { error: 'busy' } : { error: status === 400 ? 'bad-request' : 'agent-operation-failed' }),
      detail: err?.message ?? String(err),
      ...(err?.load ? { load: err.load } : {}),
    });
  }
});

// ------------------------------------------------------------------------ shutdown
/**
 * Deregister, stop the node, close the server. Shared by `/agent/shutdown` and
 * SIGINT/SIGTERM; safe to call twice.
 */
async function cleanup(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${reason}: cleaning up`);
  if (activeLoad) {
    try {
      activeLoad.controller.abort();
    } catch {
      /* already gone */
    }
  }
  if (attachment) {
    const registered = attachment;
    const lbToken = cfg.token;
    if (lbToken) {
      const result = await deregisterUpstream({
        lbUrl: registered.lbUrl,
        token: lbToken,
        nodeUrl: registered.nodeUrl,
      }).catch((err) => ({ ok: false, error: err.message }));
      if (!result.ok) logWarn(`shutdown: deregister 失败（继续停止节点）：${result.error}`);
      else log(`shutdown: deregistered ${registered.nodeUrl}`);
    } else {
      logWarn('shutdown: 没有 token，跳过 deregister');
    }
    attachment = null;
  }
  await stopNode().catch((err) => logWarn(`shutdown: 停止节点失败：${err.message}`));
  await new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  });
  log('shutdown complete');
}

let exitArmed = false;
function armForcedExit() {
  if (exitArmed) return;
  exitArmed = true;
  // Cleanup must never be the thing that hangs a stop.
  const timer = setTimeout(() => {
    logWarn('cleanup 超时，强制退出');
    process.exit(0);
  }, 10_000);
  timer.unref?.();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) {
      process.exit(0);
      return;
    }
    armForcedExit();
    cleanup(signal)
      .catch((err) => logError(`cleanup failed: ${err.message}`))
      .finally(() => process.exit(0));
  });
}
process.on('uncaughtException', (err) => logError(`uncaughtException: ${err.stack ?? err.message}`));
process.on('unhandledRejection', (err) => {
  logError(`unhandledRejection: ${err?.stack ?? err}`);
});

// --------------------------------------------------------------------------- start
server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    logError(
      `agent 端口 ${cfg.port} 已被占用。请用 --port=<空闲端口> 启动（controller 端同时要改用新的 --agents 地址），` +
        '或先停止占用该端口的进程。',
    );
    await stopNode().catch(() => {});
    process.exit(2);
  }
  if (err.code === 'EACCES') {
    logError(`agent 端口 ${cfg.port} 需要更高权限；请改用 1024 以上的 --port=`);
    process.exit(2);
  }
  logError(`agent HTTP server error: ${err.message}`);
});

/**
 * Startup is node-first on purpose: DEV-CONTRACT §12 locks eager start in, so a
 * successful `GET /health` on the agent is a promise that `/agent/attach` can
 * register a live node immediately, and a `--node-port` collision is a launch error
 * instead of a surprise on the first attach.
 */
async function main() {
  log(
    `starting: agent-port=${cfg.port} node-port=${cfg.nodePort} public-host=${cfg.publicHost} ` +
      `impl=${cfg.impl} token=${cfg.token ? 'SET' : 'MISSING'} default-lb=${cfg.lbUrl ?? 'none'}`,
  );
  if ((await probeTcp(cfg.port)) === 'responding') {
    logError(
      `agent 端口 ${cfg.port} 已被占用。请用 --port=<空闲端口>（controller 的 --agents 同时指向新端口），或先停止占用它的进程。`,
    );
    process.exit(2);
  }
  try {
    await ensureNode(cfg.nodePort, agentTopologyEnv());
  } catch (err) {
    logError(err.message);
    process.exit(2);
  }
  server.listen(cfg.port, cfg.bindHost, () => {
    log(`agent listening http://${cfg.bindHost}:${cfg.port} (public-host=${cfg.publicHost}, token=${cfg.token ? 'SET' : 'MISSING'})`);
    if (cfg.lbUrl) log(`default LB: ${cfg.lbUrl}`);
    else logWarn('未配置 --lb：attach 时必须由 controller 在请求体里传 lbUrl');
    if (!cfg.token) logWarn('未配置 --token：所有 /agent/* 控制端点将返回 401（这是有意的，不做开放控制面）');
  });
}

main().catch((err) => {
  logError(`fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});
