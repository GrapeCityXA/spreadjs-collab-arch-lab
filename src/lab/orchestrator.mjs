/**
 * Stack lifecycle: start, stop, inspect.
 *
 * One call to `up()` produces exactly one topology described by `src/lab/modes.mjs`:
 * optional Redis, N collaboration nodes, optional load balancer, optional web
 * console. Everything the lab starts is recorded in `.lab/state.json`, which is what
 * makes `down` safe: it only kills pids it created.
 *
 * Startup is intentionally sequential and health-gated. Two reasons, both learned
 * the hard way in this project:
 *   - nodes sharing a SQLite file must not race their first write (SQLITE_BUSY in
 *     the middle of WAL setup kills the process, not the request);
 *   - a node that is up but rejected its config would quietly answer on the port
 *     while the user looks at a broken topology.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { expandConfig, describeConfig } from './modes.mjs';
import {
  LAB_ROOT,
  LOG_DIR,
  DATA_DIR,
  loadLabConfig,
  STATE_DIR,
} from './paths.mjs';
import { readState, writeState, clearState, isAlive } from './state.mjs';
import { spawnBackground, killTree } from './proc.mjs';
import { waitForJson, getJson, assertPortFree, sleep, probeTcp, postJson, waitPortFree } from './ports.mjs';
import { resolveRedis, stopOwnedRedis, pingRedis } from './redis.mjs';
import { resolveLicense } from '../server/config.mjs';

const NODE_SCRIPT = resolve(LAB_ROOT, 'src/server/node-server.mjs');
const LB_SCRIPT = resolve(LAB_ROOT, 'src/lb/load-balancer.mjs');
const WEB_SCRIPT = resolve(LAB_ROOT, 'src/web/server.mjs');

/** Pick the load-balancer strategy implied by the mode. */
export function lbStrategyFor(cfg) {
  if (!cfg.lb) return null;
  if (cfg.mode === 'sharded') return cfg.affinity === 'room' ? 'room-affinity' : 'rr';
  return 'least-conn';
}

function readTail(file, lines = 25) {
  try {
    const text = readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '(没有日志)';
  }
}

function nodeEnv(cfg, { port, redisUrl, config }) {
  return {
    SJS_PORT: String(port),
    SJS_NODE_ID: `node-${port}`,
    SJS_IMPL: cfg.impl,
    SJS_ADAPTER: cfg.adapter ? '1' : '0',
    SJS_REDIS_URL: redisUrl,
    SJS_PATH: config.wsPath,
    SJS_BIND_HOST: config.bindHost,
    SJS_STORE: cfg.store,
    SJS_STORE_FILE: resolve(DATA_DIR, 'lab-store.sqlite'),
    SJS_OT: cfg.impl === 'real' ? '1' : '0',
    SJS_OT_DB: cfg.store === 'shared' ? 'sqlite' : 'memory',
    SJS_OT_DB_FILE: resolve(DATA_DIR, 'ot.sqlite'),
    SJS_PRESENCE: cfg.presence && cfg.impl === 'real' ? '1' : '0',
  };
}

/**
 * The subset of the node environment a REMOTE agent needs, so the remote node runs
 * the same topology (same store mode/file, same adapter decision, same Redis) instead
 * of silently defaulting to its own local settings. Port, node id and bind host stay
 * the agent's business: it owns its own address.
 */
function remoteNodeEnv(cfg, config, redisUrl) {
  const env = nodeEnv(cfg, { port: 0, redisUrl, config });
  delete env.SJS_PORT;
  delete env.SJS_NODE_ID;
  delete env.SJS_BIND_HOST;
  return env;
}

function isLoopbackHost(host) {
  const text = String(host ?? '').toLowerCase();
  return text === 'localhost' || text === '::1' || text === '[::1]' || text === '0.0.0.0' || /^127\./.test(text);
}

export function nodePorts(cfg, config) {
  return Array.from({ length: cfg.nodes }, (_, i) => config.nodeBasePort + i);
}

/** `http://host:9100/` → `http://host:9100`; validates that it looks like an agent URL. */
export function normalizeAgentUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (!url.port) url.port = '9100';
    return `${url.protocol}//${url.host}`;
  } catch {
    throw new Error(`agent 地址不合法：${raw}（示例：http://10.0.0.5:9100）`);
  }
}

function hostOfUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

function portOfUrl(rawUrl) {
  try {
    return Number(new URL(rawUrl).port) || null;
  } catch {
    return null;
  }
}

/** Agent lifecycle lives in `src/remote/controller.mjs`; imported lazily on use. */
async function agentHelpers() {
  return import('../remote/controller.mjs');
}

function rollback(started, log) {
  for (const node of started.nodes ?? []) {
    if (node?.pid) killTree(node.pid);
  }
  if (started.lb?.pid) killTree(started.lb.pid);
  if (started.web?.pid) killTree(started.web.pid);
  if (started.redis) stopOwnedRedis(started.redis, log);
  for (const remote of started.remote ?? []) {
    agentHelpers()
      .then(({ detachAgent }) => detachAgent(remote.agentUrl, { token: started.agentToken, lbUrl: remote.lbUrl }))
      .catch(() => {});
  }
}

/**
 * Start a topology.
 *
 * @param {{mode?: string, variant?: string|null, overrides?: object, withWeb?: boolean,
 *          agents?: string[], agentToken?: string|null, log?: object}} options
 */
export async function up({
  mode = 'single',
  variant = null,
  overrides = {},
  withWeb = true,
  agents = [],
  agentToken = null,
  log = console,
} = {}) {
  const config = loadLabConfig();
  const remoteAgents = (Array.isArray(agents) ? agents : []).map(normalizeAgentUrl).filter(Boolean);
  const cfg = expandConfig({ mode, variant, ...overrides, remoteNodes: remoteAgents.length });
  // A load balancer is the whole point of multi-machine: without one, extra nodes on
  // other hosts are just unreachable servers.
  if (remoteAgents.length && !cfg.lb) {
    throw new Error(
      '当前拓扑没有负载均衡，远端节点无处注册。多机测试请用 --mode=sharded 或 --mode=shared；' +
        '--nodes 只计算主控本地节点，可以为 1。single 模式不支持接入 agent。',
    );
  }
  if (remoteAgents.length) {
    const hosts = remoteAgents.map((url) => hostOfUrl(url));
    const crossHost = hosts.some((host) => host && !isLoopbackHost(host));
    // The demo's "shared" document store is a SQLite FILE. A file on the controller's
    // disk is not the agents' disk: each remote node would create its own local file and
    // the topology would silently degrade to broken-adapter-only. Refuse loudly instead.
    if (cfg.store === 'shared' && crossHost) {
      throw new Error(
        'shared 模式的演示文档库是 SQLite 文件，无法跨主机共享（每台机器会各建一份，结果就是“有适配器但文档不共享”）。' +
          '跨机请：① 用 --mode=sharded（不需要共享文档）；或 ② 把 agent 跑在本机 127.0.0.1 上做同机模拟；' +
          '或 ③ 换成生产用的 PostgreSQL 共享库（见 docs/06-production.md）。',
      );
    }
    if (cfg.adapter && crossHost) {
      const redisHost = new URL(config.redisUrl).hostname;
      if (isLoopbackHost(redisHost)) {
        log.warn?.(
          `! Redis 地址 ${config.redisUrl} 只在 controller 本机可达，远端 agent 节点连不上适配器。` +
            '跨机请设置 SJS_LAB_REDIS_URL=redis://<controller-ip>:6379（并确认防火墙放行）。',
        );
      }
    }
  }
  const adminToken = agentToken || process.env.SJS_LAB_AGENT_TOKEN || `lab-${randomBytes(9).toString('hex')}`;

  const existing = readState();
  if (existing) {
    const alive =
      (existing.nodes ?? []).some((n) => isAlive(n.pid)) || isAlive(existing.lb?.pid) || isAlive(existing.web?.pid);
    if (alive) {
      throw new Error(
        `已有一个 stack 在运行（${existing.config?.mode ?? '?'}）。先执行 \`npm run down\` 再启动新的拓扑。`,
      );
    }
    clearState();
  }

  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });

  if (cfg.impl === 'real') {
    const license = resolveLicense();
    if (!license.status.server) {
      throw new Error(
        'impl=real 需要 server 授权。填写 config/license.json 的 server.serverLicenseKey，或设置 SJS_SERVER_LICENSE_KEY；' +
          '或先使用默认的 mirror 实现（无需授权）。',
      );
    }
  }

  const started = { nodes: [], lb: null, web: null, redis: null, remote: [], agentToken: null };

  try {
    // ---------------------------------------------------------------- Redis
    if (cfg.requires.redis) {
      started.redis = await resolveRedis({ url: config.redisUrl, port: config.redisPort, log });
    }

    // ---------------------------------------------------------------- nodes
    const ports = nodePorts(cfg, config);
    for (const port of ports) await assertPortFree(port, '协同节点');

    for (const port of ports) {
      const logFile = `logs/node-${port}.log`;
      const child = spawnBackground(process.execPath, [NODE_SCRIPT, `--port=${port}`], {
        logFile,
        env: nodeEnv(cfg, { port, redisUrl: started.redis?.url ?? config.redisUrl, config }),
        cwd: LAB_ROOT,
      });
      started.nodes.push({ id: `node-${port}`, port, pid: child.pid, logFile: child.logFile });
      log.info?.(`协同节点 :${port} 启动中 (pid ${child.pid})`);
    }

    for (const node of started.nodes) {
      try {
        await waitForJson(`http://127.0.0.1:${node.port}/health`, {
          timeoutMs: 45000,
          label: `节点 :${node.port}`,
          validate: (body) =>
            body?.ok === true &&
            body.nodeId === node.id &&
            body.impl === cfg.impl &&
            body.adapterEnabled === cfg.adapter,
        });
      } catch (err) {
        const tail = readTail(node.logFile);
        throw new Error(`${err.message}\n--- logs/node-${node.port}.log（末尾）---\n${tail}`);
      }
      log.info?.(`协同节点 :${node.port} 就绪`);
    }

    // ------------------------------------------------------------- balancer
    if (cfg.lb) {
      await assertPortFree(config.lbPort, '负载均衡');
      const strategy = lbStrategyFor(cfg);
      const upstreams = started.nodes.map((n) => `127.0.0.1:${n.port}`).join(',');
      const child = spawnBackground(
        process.execPath,
        [
          LB_SCRIPT,
          `--listen=${config.lbPort}`,
          `--host=${config.bindHost}`,
          `--nodes=${upstreams}`,
          `--strategy=${strategy}`,
          `--admin-token=${adminToken}`,
        ],
        { logFile: 'logs/lb.log', cwd: LAB_ROOT, env: { ...process.env, SJS_LB_ADMIN_TOKEN: adminToken } },
      );
      started.lb = { port: config.lbPort, pid: child.pid, strategy, logFile: child.logFile, adminToken, publicUrl: config.lbPublicUrl };
      try {
        await waitForJson(`http://127.0.0.1:${config.lbPort}/healthz`, {
          timeoutMs: 20000,
          label: '负载均衡器',
          validate: (body) => body === 'ok' || body?.ok === true,
        });
      } catch (err) {
        throw new Error(`${err.message}\n--- logs/lb.log（末尾）---\n${readTail(child.logFile)}`);
      }
      log.info?.(`负载均衡 :${config.lbPort} 就绪（策略 ${strategy}）`);

      // ------------------------------------------------------- remote agents
      if (remoteAgents.length) {
        const { attachAgent } = await agentHelpers();
        // Send the topology down to the agent: without this the remote node runs its
        // own defaults (local store) and a `shared` stack silently stops being shared.
        const nodeConfig = remoteNodeEnv(cfg, config, started.redis?.url ?? config.redisUrl);
        for (const agentUrl of remoteAgents) {
          const attached = await attachAgent(agentUrl, { token: adminToken, lbUrl: config.lbPublicUrl, nodeConfig });
          started.remote.push({
            agentUrl,
            lbUrl: config.lbPublicUrl,
            nodeUrl: attached.nodeUrl,
            nodeId: attached.nodeId,
            host: attached.host ?? hostOfUrl(attached.nodeUrl) ?? hostOfUrl(agentUrl),
          });
          log.info?.(`远端节点 ${attached.nodeId} 已接入（${attached.nodeUrl}，agent ${agentUrl}）`);
        }
        started.agentToken = adminToken;
      }
    }

    // ------------------------------------------------------------------ web
    if (withWeb) {
      await assertPortFree(config.webPort, '控制台');
      const child = spawnBackground(process.execPath, [WEB_SCRIPT, `--port=${config.webPort}`], {
        logFile: 'logs/web.log',
        cwd: LAB_ROOT,
      });
      started.web = { port: config.webPort, pid: child.pid, logFile: child.logFile };
      try {
        await waitForJson(`http://127.0.0.1:${config.webPort}/api/stack`, {
          timeoutMs: 20000,
          label: '控制台',
          validate: (body) => body?.running !== undefined,
        });
      } catch (err) {
        throw new Error(`${err.message}\n--- logs/web.log（末尾）---\n${readTail(child.logFile)}`);
      }
      log.info?.(`控制台 http://127.0.0.1:${config.webPort}/ 就绪`);
    }

    const localNodes = started.nodes.map((node) => ({ ...node, base: `http://127.0.0.1:${node.port}`, remote: false, host: null }));
    const remoteNodes = started.remote.map((entry) => ({
      id: entry.nodeId,
      port: portOfUrl(entry.nodeUrl),
      base: entry.nodeUrl,
      remote: true,
      host: entry.host,
      agentUrl: entry.agentUrl,
    }));
    const state = {
      startedAt: Date.now(),
      config: cfg,
      describe: describeConfig(cfg),
      lbStrategy: lbStrategyFor(cfg),
      process: {
        label: `${cfg.mode}${cfg.variant ? `/${cfg.variant}` : ''}`,
      },
      // Local nodes first: the probes use nodes[0]/nodes[1] as "the two nodes", and a
      // local node is the cheapest one to compare against a remote one.
      nodes: [...localNodes, ...remoteNodes],
      remote: started.remote,
      lb: started.lb,
      redis: started.redis
        ? { url: started.redis.url, mode: started.redis.mode, owned: started.redis.owned, pid: started.redis.pid }
        : null,
      web: started.web,
      ports: { lb: config.lbPort, web: config.webPort, wsPath: config.wsPath },
      room: config.defaultRoom,
      agentToken: started.remote.length ? started.agentToken : null,
    };
    writeState(state);
    return state;
  } catch (err) {
    rollback(started, log);
    clearState();
    throw err;
  }
}

/**
 * Stop one recorded service.
 *
 * Order: graceful HTTP `POST /shutdown` → OS kill → verify. The HTTP step matters
 * because process-level kills are not always permitted (sandboxes, containers, a
 * process started from another user session): when the kill is denied the service
 * keeps its port and the next `up` fails with a confusing "port in use" error.
 */
async function stopService(entry, label) {
  if (!entry?.pid) return null;
  const row = { pid: entry.pid, port: entry.port ?? null, label, graceful: false, alive: false };
  if (!isAlive(entry.pid)) return row;
  if (entry.port) {
    const res = await postJson(`http://127.0.0.1:${entry.port}/shutdown`, null, 1500);
    row.graceful = res.status === 200 || res.status === 202;
    if (row.graceful) await waitPortFree(entry.port, 3000);
  }
  if (isAlive(entry.pid)) killTree(entry.pid);
  for (let i = 0; i < 30 && isAlive(entry.pid); i++) await sleep(100);
  row.alive = isAlive(entry.pid);
  return row;
}

/** Stop everything recorded in the state file. Never touches foreign processes. */
export async function down({ log = console, stopAgents = false } = {}) {
  const state = readState();
  if (!state) {
    return { stopped: false, message: '没有正在运行的 stack。' };
  }

  // Remote nodes are detached through their agents (deregister + stop the node child).
  // Bounded and best-effort: an unreachable agent must not prevent the local cleanup.
  const remote = [];
  if (state.remote?.length) {
    let helpers = null;
    try {
      helpers = await agentHelpers();
    } catch (err) {
      log.warn?.(`! 无法加载 agent 控制器（${err.message}），跳过远端摘除`);
    }
    for (const entry of state.remote) {
      const host = entry.host ?? hostOfUrl(entry.nodeUrl) ?? entry.agentUrl;
      if (!helpers) {
        remote.push({ ...entry, detached: false, error: 'controller 模块不可用' });
        continue;
      }
      try {
        if (stopAgents) await helpers.shutdownAgent(entry.agentUrl, { token: state.agentToken, lbUrl: entry.lbUrl });
        else await helpers.detachAgent(entry.agentUrl, { token: state.agentToken, lbUrl: entry.lbUrl });
        remote.push({ ...entry, detached: true });
        log.info?.(`远端节点 ${entry.nodeId} 已摘除（${entry.nodeUrl}）`);
      } catch (err) {
        remote.push({ ...entry, detached: false, error: err.message });
        log.warn?.(
          `! agent ${host} 未能摘除：${err.message}（远端节点可能还在跑；确认：curl http://${host}:9100/health，再 npm run down -- --stop-agents）`,
        );
      }
    }
  }

  const nodes = [];
  for (const node of state.nodes ?? []) {
    if (node.remote) continue; // no pid to kill: it lives on the agent host
    const row = await stopService(node, `协同节点 :${node.port}`);
    if (row) nodes.push(row);
  }
  const lb = state.lb ? await stopService(state.lb, `负载均衡 :${state.lb.port}`) : null;
  const web = state.web ? await stopService(state.web, `控制台 :${state.web.port}`) : null;
  let redis = false;
  if (state.redis?.owned) {
    stopOwnedRedis(state.redis, log);
    redis = true;
  }

  const survivors = [...nodes, lb, web].filter((row) => row && row.alive);
  if (survivors.length) {
    // Keep the state file: a second `down` must be able to retry, and `up` should
    // refuse rather than silently start a half stack on top of the survivors.
    return {
      stopped: false,
      nodes,
      lb,
      web,
      redis,
      survivors,
      message: `还有 ${survivors.length} 个进程没有退出：${survivors
        .map((row) => `${row.label}（pid ${row.pid}）`)
        .join('，')}`,
    };
  }

  // Give the OS a moment to release the ports before the next `up`.
  for (let i = 0; i < 60; i++) {
    const busy = await Promise.all((state.nodes ?? []).filter((n) => !n.remote).map((n) => probeTcp(n.port)));
    if (!busy.includes('responding')) break;
    await sleep(150);
  }

  clearState();
  return { stopped: true, nodes, lb, web, redis, remote };
}

/** Live view of the stack: state file + health of every component. */
export async function status() {
  const state = readState();
  if (!state) return { running: false };
  const nodes = await Promise.all(
    (state.nodes ?? []).map(async (node) => {
      const base = node.base ?? `http://127.0.0.1:${node.port}`;
      const alive = node.remote ? true : isAlive(node.pid);
      let health = null;
      let detail = null;
      try {
        const res = await getJson(`${base}/health`);
        health = res.ok ? res.body : null;
      } catch (err) {
        detail = err.message;
      }
      return { ...node, base, alive, health, detail, remote: Boolean(node.remote), host: node.host ?? null };
    }),
  );
  let lb = null;
  if (state.lb) {
    let detail = null;
    try {
      const res = await getJson(`http://127.0.0.1:${state.lb.port}/__lb/state`);
      lb = res.ok ? res.body : null;
    } catch (err) {
      detail = err.message;
    }
    lb = { ...state.lb, alive: isAlive(state.lb.pid), detail, state: lb };
  }
  // Remote agents: their node health is already above; annotate with the LB's opinion
  // so a registered-but-broken node is visible without opening three terminals.
  const remote = (state.remote ?? []).map((entry) => {
    const upstream = (lb?.state?.upstreams ?? []).find((up) => up.url === entry.nodeUrl || up.url === `http://${entry.nodeUrl}`);
    return { ...entry, healthy: upstream ? upstream.healthy : null };
  });
  let web = null;
  if (state.web) {
    web = { ...state.web, alive: isAlive(state.web.pid) };
  }
  let redis = null;
  if (state.redis) {
    redis = { ...state.redis, alive: state.redis.owned ? isAlive(state.redis.pid) : await pingRedis(state.redis.url, 800) };
  }
  return {
    running: true,
    startedAt: state.startedAt,
    config: state.config,
    describe: state.describe,
    room: state.room,
    urls: {
      web: state.web ? `http://127.0.0.1:${state.web.port}/` : null,
      lb: state.lb ? `${state.lb.publicUrl ?? `ws://127.0.0.1:${state.lb.port}`}${state.ports.wsPath}` : null,
      lbHttp: state.lb ? state.lb.publicUrl ?? `http://127.0.0.1:${state.lb.port}` : null,
    },
    nodes,
    remote,
    lb,
    web,
    redis,
    ports: state.ports,
    agents: {
      count: remote.length,
      tokenSet: Boolean(state.agentToken),
    },
  };
}

/** A compact ASCII topology, used by the CLI and by the check report. */
export function topologyDiagram(state) {
  const cfg = state.config ?? {};
  const lines = [];
  const lbLine = state.lb
    ? `        客户端 ──▶ 负载均衡 :${state.lb.port} (${state.lb.strategy ?? lbStrategyFor(cfg)})`
    : '        客户端 ──▶ 直连唯一节点（无负载均衡）';
  lines.push(lbLine);
  if (state.lb) {
    const nodes = state.nodes ?? [];
    lines.push('                     │');
    const labels = nodes.map((n) => (n.remote ? `node:${n.port}@${n.host}` : `node:${n.port}`));
    lines.push(`                     ├─▶ ${labels.join('   ')}`);
    if (nodes.some((n) => n.remote)) {
      lines.push(`        多机：${nodes.filter((n) => n.remote).length} 个远端节点（agent 主机）`);
    }
  }
  const shared = cfg.store === 'shared' ? '共享文档库（所有节点读写同一份）' : '每节点本地文档库（互不可见）';
  lines.push(`        文档存储：${shared}`);
  if (cfg.adapter) lines.push('        跨节点消息：Redis Pub/Sub（Socket.IO 适配器）');
  else if ((state.nodes ?? []).length > 1) lines.push('        跨节点消息：无（节点之间互不可见）');
  return lines.join('\n');
}
