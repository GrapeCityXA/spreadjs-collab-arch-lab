/**
 * Check runner: measure, then judge against what the topology promised.
 *
 * The split matters. `probes.mjs` only observes; this file decides whether an
 * observation is a pass, a defect, or an expected demonstration of a known
 * anti-pattern. That way the same measurements can honestly describe either
 * "your deployment is broken" or "this is what the broken variant is supposed to
 * look like".
 */
import { MODES, VARIANTS, expectations } from '../lab/modes.mjs';
import { readState } from '../lab/state.mjs';
import { loadLabConfig } from '../lab/paths.mjs';
import { getJson } from '../lab/ports.mjs';
import { CHECK_DEFAULTS, describeScenario, formatCores, modelScenario, normalizeScenario } from '../lab/scenario.mjs';
import { runLoad } from '../bench/load.mjs';
import { runMirrorProbes } from './probes.mjs';
import { writeReport } from './report.mjs';

const VERSION = '1.1.0';

/** The check's load phase is a sample, not a benchmark: cap it so `check` stays usable. */
const DEFAULT_MAX_LOAD_CLIENTS = 300;

/** User-facing advice for each failure mode. Keep it actionable, not generic. */
const ADVICE = {
  'nodes.health': '有节点或负载均衡没有起来。看 logs/node-<端口>.log 与 logs/lb.log；端口冲突时先 npm run down 再试。',
  'topology.config':
    '运行中的进程配置与所选拓扑不一致（常见原因：上一次的 stack 没清理干净，或手动改了环境变量）。先 npm run down，再重新 up。若诊断里只点名“远端”节点，说明 agent 的节点没有按 controller 的配置启动：升级后重启 agent，或检查 attach 是否带上了 nodeConfig。',
  'lb.distribution':
    '连接都落在同一个节点上。检查负载均衡的 upstream 列表与策略；如果是 room-affinity，用不同房间测试才有意义。',
  'room.placement':
    '分区模式要求“同一房间永远落到同一节点”，但负载均衡把同一房间拆到了多个节点。给 LB 加房间亲和（按 roomId 做一致性哈希/粘性）——做不到的话，说明你需要的是 shared 模式，而不是 sharded。',
  'realtime.sameNode': '同节点都收不到编辑，先确认服务端是否正常、房间是否一致；这通常不是架构问题而是链路故障。',
  'realtime.crossNode':
    '跨节点消息没有在限定时间内到达。检查每个节点是否都注入了同一个 Socket.IO Redis 适配器（SJS_ADAPTER=1，Redis 可连通）。缺适配器时消息会静默丢失，不会报错。',
  'join.consistency':
    '在另一个节点加入房间时拿不到文档。说明文档库不是共享的：共享 room 模式必须让所有节点读写同一份文档存储（生产用 PostgreSQL；演示用共享 SQLite）。只有 Redis 适配器是不够的。',
  'store.consistency':
    '各节点上的文档版本不一致。共享 room 模式要求所有节点读写同一个文档库；每个节点各存一份会造成“实时看起来通、换个人加入就是空文档”。',
  'isolation.rooms': '不同房间之间发生了消息泄漏，这是严重的正确性缺陷，应先停止上线。',
  'ack.latency': '',
  'load.scenario':
    '这是你给的场景下实测出来的数字，不是通过/失败项。ACK p95 明显偏高或失败数 > 0 时：降低 users、拉长 interval，或用 `npm run bench -- --distribute=local,http://<agent>:9100` 把负载分摊到多台机器（单机的 CPU/网卡先成为瓶颈时，测到的是生成器不是服务端）。',
  'eventual.mask':
    '这是最危险的组合：实时协同是断的，但重新加载/重新加入后数据看起来是对的。只比对最终快照会“验收通过”，上线后用户感受到的却是协同不生效。必须按有界时间验证投递。',
};

function classifyOne(item, cfg, exp, predicts) {
  const expected = exp[item.id] ?? 'n/a';
  let status;
  switch (expected) {
    case 'n/a':
    case 'not-required':
      status = 'n/a';
      break;
    case 'record':
      status = 'record';
      break;
    case 'colocated':
      status = item.pass === true ? 'pass' : item.pass === false ? 'fail' : 'n/a';
      break;
    case 'not-dangerous':
      status = item.pass === false ? 'fail' : item.pass === null ? 'n/a' : 'pass';
      break;
    default:
      status = item.pass === true ? 'pass' : item.pass === false ? 'fail' : 'n/a';
      break;
  }
  let note = null;
  if (expected === 'not-required') {
    note = '该拓扑不承诺这一项（分区语义：跨节点的房间本来就不共享）';
  }
  if (status === 'fail' && predicts.includes(item.id)) {
    status = 'expected-failure';
    note = VARIANTS[cfg.variant]?.teachingNote ?? null;
  }
  return {
    id: item.id,
    label: item.label,
    expected,
    status,
    detail: note ? `${item.detail}${item.detail ? '。' : ''}${note}` : item.detail,
    metrics: item.metrics ?? {},
    advice: status === 'fail' || status === 'expected-failure' ? ADVICE[item.id] ?? null : null,
  };
}

function classify(rawResults, cfg) {
  const exp = expectations(cfg);
  const predicts = cfg.variant ? (VARIANTS[cfg.variant]?.predicts ?? []) : [];
  return rawResults.map((item) => classifyOne(item, cfg, exp, predicts));
}

export { classify as classifyChecks };

function buildTopology(stack, liveNodes) {
  const cfg = stack.config ?? {};
  return {
    mode: cfg.mode,
    variant: cfg.variant ?? null,
    nodes: liveNodes.map((n) => ({
      id: n.id,
      port: n.port,
      impl: n.health?.impl ?? null,
      adapter: n.health?.adapterEnabled ?? null,
      store: n.health?.storeMode ?? n.health?.store ?? null,
      clients: n.clients?.length ?? 0,
      remote: Boolean(n.remote),
      host: n.host ?? null,
    })),
    lb: stack.lb ? { port: stack.lb.port, strategy: stack.lb.strategy } : null,
    redis: stack.redis ? { url: stack.redis.url, mode: stack.redis.mode } : null,
    store: cfg.store ?? null,
  };
}

function summarize(checks, cfg) {
  const failures = checks.filter((c) => c.status === 'fail');
  const expectedFailures = checks.filter((c) => c.status === 'expected-failure');
  const promisedButMissing = checks.filter(
    (c) =>
      c.status === 'n/a' &&
      ['pass', 'colocated', 'not-dangerous'].includes(c.expected),
  );

  let status = 'healthy';
  if (failures.length) status = 'broken';
  else if (expectedFailures.length) status = 'expected-broken';
  else if (promisedButMissing.length) status = 'degraded';

  const modeLabel = MODES[cfg.mode]?.label ?? cfg.mode;
  let headline;
  if (status === 'expected-broken') {
    headline = `反模式已被复现：${VARIANTS[cfg.variant]?.label ?? cfg.variant} —— 这正是要避免的配置。`;
  } else if (status === 'broken') {
    headline = `当前部署没有兑现“${modeLabel}”的承诺：${failures.map((c) => c.label).join('、')}。`;
  } else if (status === 'degraded') {
    headline = `拓扑基本可用，但有 ${promisedButMissing.length} 项承诺的检查在本机无法验证（原因见明细）。`;
  } else if (cfg.mode === 'shared') {
    headline = '共享 room 拓扑按承诺工作：任意节点的客户端都能实时互见，文档在各节点一致。';
  } else if (cfg.mode === 'sharded') {
    headline = '分区拓扑按承诺工作：同一房间被亲和到同一节点，房间内实时协同正常；跨节点的房间本来就不共享（设计如此）。';
  } else {
    headline = '单机拓扑正常：所有客户端都在同一个进程内协同。';
  }

  const advice = [...new Set(checks.filter((c) => c.advice).map((c) => c.advice))];
  return { status, headline, advice, failures: failures.length, expectedFailures: expectedFailures.length };
}

async function liveNodeDetails(stack) {
  const out = [];
  for (const node of stack.nodes ?? []) {
    const base = node.base ?? `http://127.0.0.1:${node.port}`;
    const row = {
      id: node.id,
      port: node.port,
      pid: node.pid,
      base,
      remote: Boolean(node.remote),
      host: node.host ?? null,
      health: null,
      clients: [],
      docs: [],
      error: null,
    };
    try {
      const health = await getJson(`${base}/health`);
      row.health = health.ok ? health.body : null;
      const state = await getJson(`${base}/state`);
      if (state.ok && state.body) {
        row.clients = state.body.clients ?? [];
        row.docs = state.body.docs ?? [];
      }
    } catch (err) {
      row.error = err.message;
    }
    out.push(row);
  }
  return out;
}

function pickMetrics(checks) {
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  return {
    ackMs: byId['ack.latency']?.metrics?.ackMs ?? null,
    crossNodeMs: byId['realtime.crossNode']?.metrics?.latencyMs ?? null,
    sameNodeMs: byId['realtime.sameNode']?.metrics?.latencyMs ?? null,
    join: byId['join.consistency']?.metrics ?? null,
    store: byId['store.consistency']?.metrics ?? null,
    placement: byId['room.placement']?.metrics ?? null,
    load: byId['load.scenario']?.metrics ?? null,
  };
}

/**
 * Run the architecture check against the RUNNING stack.
 *
 * @param {{stack?: object, onProgress?: Function, persist?: boolean, outputDir?: string, scenario?: object}} options
 */
export async function runCheck({ stack = readState(), onProgress, persist = true, outputDir, scenario } = {}) {
  if (!stack) {
    throw Object.assign(
      new Error('没有正在运行的 stack。先执行 `npm run up -- --mode=single|sharded|shared`，再运行体检。'),
      { code: 'NO_STACK' },
    );
  }
  const cfg = stack.config;
  if (!cfg) throw Object.assign(new Error('状态文件缺少 config 字段，请先 npm run down 再 up。'), { code: 'NO_STACK' });

  if (cfg.impl === 'real') {
    throw Object.assign(
      new Error(
        '官方实现（impl=real）的端到端体检需要真实浏览器驱动官方协同客户端，请用 `npm run test:official`。' +
          '本命令的 mirror 检查覆盖消息投递、房间隔离与文档共享，不能代替官方 OT 行为或容量验证。',
      ),
      { code: 'REAL_ENGINE_UNSUPPORTED' },
    );
  }

  const labConfig = loadLabConfig();
  const nodes = (stack.nodes ?? []).map((n) => ({
    nodeId: n.id,
    port: n.port,
    base: n.base ?? `http://127.0.0.1:${n.port}`,
    remote: Boolean(n.remote),
    host: n.host ?? null,
  }));
  const lb = stack.lb
    ? { port: stack.lb.port, base: stack.lb.base ?? `http://127.0.0.1:${stack.lb.port}`, strategy: stack.lb.strategy }
    : null;
  const roomId = `check-${Date.now().toString(36)}`;

  // The user's scenario is part of the measurement, not a detail of the UI. Validate
  // it before touching the stack so a typo does not look like a topology failure.
  const sc = normalizeScenario(scenario ?? {}, CHECK_DEFAULTS);
  const model = modelScenario(sc, { presence: Boolean(cfg.presence) });

  // Expectation depends on how many nodes are REALLY running: a 2-local + 2-agent
  // stack is multi-node even though `config.nodes` only counts the local ones.
  const judgeCfg = { ...cfg, nodes: nodes.length };
  const exp = expectations(judgeCfg);
  const predicts = cfg.variant ? (VARIANTS[cfg.variant]?.predicts ?? []) : [];
  const liveNodes = await liveNodeDetails(stack);
  const ctx = {
    cfg,
    stack,
    nodes,
    lb,
    path: stack.ports?.wsPath ?? labConfig.wsPath,
    roomId,
    scenario: sc,
    model,
    // Raw progress for phases that are not probes yet (the load phase): the console
    // shows a "running" row so an 8 s sample does not look like a hung request.
    emitProgress: onProgress ? (item) => onProgress(item) : undefined,
    // Report the CLASSIFIED status, not the raw observation: a sharded stack that
    // observes "cross-node not delivered" is not a failure, it is out of contract.
    progress: onProgress
      ? (item) => {
          const check = classifyOne(item, judgeCfg, exp, predicts);
          onProgress({ id: check.id, label: check.label, status: check.status, detail: check.detail });
        }
      : undefined,
  };

  const raw = await runMirrorProbes(ctx);

  // ---- scenario load phase ------------------------------------------------------
  // Runs through the topology entry (LB first) so it measures the path a browser
  // takes, and it is capped: a check must remain a check, not a benchmark.
  const entry = lb?.base ?? nodes[0]?.base;
  const maxClients = Number(process.env.SJS_LAB_MAX_LOAD_CLIENTS ?? DEFAULT_MAX_LOAD_CLIENTS) || DEFAULT_MAX_LOAD_CLIENTS;
  const loadUsers = Math.max(1, Math.min(sc.users, maxClients));
  const capped = loadUsers < sc.users;
  let loadItem = null;
  if (entry) {
    ctx.emitProgress?.({
      id: 'load.scenario',
      label: '按你的场景加压（用户数 × 编辑间隔）',
      status: 'running',
      detail: `${loadUsers} 个客户端 · 每 ${sc.opIntervalMs}ms 一次编辑 · ${sc.durationMs / 1000} 秒`,
    });
    const loadStarted = Date.now();
    const load = await runLoad({
      url: entry,
      path: ctx.path,
      users: loadUsers,
      opIntervalMs: sc.opIntervalMs,
      durationMs: sc.durationMs,
      rooms: sc.rooms,
      roomPrefix: `${roomId}-load`,
      labelPrefix: 'scenario',
    });
    const ack = load.ackMs;
    loadItem = {
      id: 'load.scenario',
      label: '按你的场景加压（用户数 × 编辑间隔）',
      pass: null, // expectation is `record` in every mode: this is a number, not a promise
      detail:
        `${loadUsers} 个客户端${capped ? `（场景 ${sc.users}，按上限收敛）` : ''} · ` +
        `${load.ops} 次编辑成功 / ${load.opsFailed} 失败 · ` +
        `ACK p95 ${ack.p95 ?? '—'}ms · 实测扇出 ${load.fanoutPerSecond} 条/s · ` +
        `模型预测 ${formatCores(model.predictedCores)} 核`,
      metrics: {
        clients: loadUsers,
        requestedUsers: sc.users,
        capped,
        ops: load.ops,
        opsFailed: load.opsFailed,
        opsPerSecond: load.opsPerSecond,
        fanoutPerSecond: load.fanoutPerSecond,
        ack,
        broadcastMs: load.broadcastMs,
        predictedCores: model.predictedCores,
        modelOpsPerSecond: model.opsPerSecond,
        modelFanoutPerSecond: model.fanoutPerSecond,
        elapsedMs: load.elapsedMs || Date.now() - loadStarted,
      },
    };
    raw.push(loadItem);
  }

  const checks = raw.map((item) => classifyOne(item, judgeCfg, exp, predicts));
  const summary = summarize(checks, judgeCfg);

  const result = {
    generatedAt: new Date().toISOString(),
    labVersion: VERSION,
    engine: 'mirror',
    scope: 'mirror 消息转发、房间隔离与文档共享实验；不代表官方 OT 行为或 SpreadJS 容量。',
    mode: cfg.mode,
    variant: cfg.variant ?? null,
    describe: stack.describe ?? null,
    config: cfg,
    room: roomId,
    scenario: {
      users: sc.users,
      opIntervalMs: sc.opIntervalMs,
      durationMs: sc.durationMs,
      rooms: sc.rooms,
      notes: sc.notes ?? [],
      describe: describeScenario(sc),
      model,
      load: loadItem
        ? {
            clients: loadItem.metrics.clients,
            capped,
            ops: loadItem.metrics.ops,
            opsFailed: loadItem.metrics.opsFailed,
            opsPerSecond: loadItem.metrics.opsPerSecond,
            fanoutPerSecond: loadItem.metrics.fanoutPerSecond,
            ackMs: loadItem.metrics.ack,
          }
        : null,
    },
    expectations: exp,
    checks,
    summary,
    metrics: pickMetrics(checks),
    topology: buildTopology(stack, liveNodes),
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      lbStrategy: stack.lb?.strategy ?? null,
      localNodes: (stack.nodes ?? []).filter((n) => !n.remote).length,
      remoteNodes: (stack.nodes ?? []).filter((n) => n.remote).length,
      totalNodes: nodes.length,
    },
  };

  let files = null;
  if (persist) {
    files = writeReport(result, outputDir);
    result.files = files;
  }
  return { result, files };
}

/** Exit code contract documented in README (0/1/2/3). */
export function exitCodeFor(result) {
  switch (result.summary.status) {
    case 'healthy':
    case 'expected-broken':
      return 0;
    case 'degraded':
      return 3;
    default:
      return 1;
  }
}
