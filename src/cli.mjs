#!/usr/bin/env node
/**
 * The lab CLI.
 *
 * One command per question a user has:
 *   doctor   what can this machine run?
 *   up/down  give me one topology
 *   status   what is running, and is it healthy?
 *   check    does the running topology deliver what it promises?
 *   compare  run all three topologies and show the difference
 *   bench    how much fan-out can this machine take?
 *   web      one page that drives all of the above
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { up, down, status, topologyDiagram } from './lab/orchestrator.mjs';
import { publicJsonReplacer } from './lab/public-json.mjs';
import { runCheck, exitCodeFor } from './checks/runner.mjs';
import { renderCliMatrix } from './checks/report.mjs';
import { runDoctor, renderDoctor } from './lab/doctor.mjs';
import { runBench, renderBench } from './bench/bench.mjs';
import { runCompare, renderCompareCli, comparisonExitCode } from './checks/compare.mjs';
import { createLabServer } from './web/server.mjs';
import { MODE_IDS, VARIANT_IDS, MODES, VARIANTS, describeConfig } from './lab/modes.mjs';
import { loadLabConfig } from './lab/paths.mjs';
import {
  BENCH_DEFAULTS,
  CHECK_DEFAULTS,
  describeModel,
  describeScenario,
  modelScenario,
  scenarioFromFlags,
} from './lab/scenario.mjs';

const log = {
  info: (message) => process.stdout.write(`${message}\n`),
  warn: (message) => process.stderr.write(`${message}\n`),
  error: (message) => process.stderr.write(`${message}\n`),
};

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[arg.slice(2)] = next;
        i += 1;
      } else {
        flags[arg.slice(2)] = true;
      }
    }
  }
  return { flags, positional };
}

function parseBool(value, fallback = true) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (value === false) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function overridesFromFlags(flags) {
  const overrides = {};
  if (flags.nodes !== undefined) overrides.nodes = Number(flags.nodes);
  if (flags.impl !== undefined) overrides.impl = String(flags.impl);
  if (flags.store !== undefined) overrides.store = String(flags.store);
  if (flags.adapter !== undefined) overrides.adapter = parseBool(flags.adapter);
  if (flags.affinity !== undefined) overrides.affinity = String(flags.affinity);
  if (flags.presence !== undefined) overrides.presence = parseBool(flags.presence);
  return overrides;
}

function validateMode(mode, variant) {
  if (variant) {
    if (!VARIANT_IDS.includes(variant)) {
      throw new Error(`未知变体 "${variant}"。可选：${VARIANT_IDS.join(', ')}`);
    }
    return;
  }
  if (!MODE_IDS.includes(mode)) {
    throw new Error(`未知模式 "${mode}"。可选：${MODE_IDS.join(', ')}`);
  }
  if (mode !== 'single' && mode !== 'sharded' && mode !== 'shared') {
    throw new Error(`未知模式 "${mode}"`);
  }
}

/** `--agents=http://h1:9100,http://h2:9100` (or several `--agent=` flags) → URL list. */
function agentsFromFlags(flags) {
  const raw = [];
  for (const key of ['agents', 'agent']) {
    const value = flags[key];
    if (value === undefined || value === true) continue;
    raw.push(...String(value).split(','));
  }
  return raw.map((item) => item.trim()).filter(Boolean);
}

/** `--distribute` / `--distribute=local,http://h1:9100` → boolean | string[]. */
function distributeFromFlags(flags) {
  const value = flags.distribute;
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  const text = String(value).trim();
  if (!text || text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const HELP = `
SpreadJS 协同架构验证实验室

用法：node src/cli.mjs <命令> [选项]

命令
  up        启动一个拓扑（默认 single）
  down      停止当前拓扑
  status    查看当前拓扑与健康状态
  web       只启动控制台（可在页面上启动/停止/体检）
  check     对当前运行的拓扑做架构体检，产出报告
  compare   依次跑三种拓扑，产出对比报告
  bench     对当前拓扑做小规模压测（仅 mirror 引擎）
  doctor    环境自检：这台机器能跑哪几种拓扑
  agent     （在其它机器上）启动受控节点，供 controller 用 --agents 接入
            直接运行：npm run agent -- --port=9100 --lb=http://<controller>:3000 --token=<token> --public-host=<本机IP>

up 选项
  --mode=single|sharded|shared     架构模式（默认 single）
  --variant=broken-sharded|broken-adapter-only|broken-no-adapter
                                   复现反模式（会覆盖 mode）
  --nodes=N                        本机节点数（默认取模式预设）
  --agents=http://h1:9100,...      接入多机节点（在其它机器上先跑 npm run agent）
  --agent-token=TOKEN              多机 admin token（不给则自动生成并记录在 .lab/state.json）
  --impl=mirror|real               mirror=零授权参考实现；real=官方实现（需 server 授权）
  --store=local|shared             文档库：每节点本地 / 共享
  --adapter=0|1                    是否注入 Socket.IO Redis 适配器
  --affinity=room|none             负载均衡路由：按房间亲和 / 轮询
  --no-web                         不启动控制台
  --json                           输出机器可读 JSON

down 选项
  --stop-agents                    同时关闭远端 agent 进程（默认只摘除节点、保留 agent）

check 选项
  --users=N                并发用户数（默认 20）
  --interval=秒            每个用户多久编辑一次（默认 2，支持 0.5）
  --duration=秒            加压时长（默认 8）
  --rooms=N                房间数（默认 1）
  --max-load-clients=N     单进程最多生成多少客户端（默认 300；更大用 bench --distribute）
  --json                   输出 JSON
  --out-dir=DIR            报告输出目录（默认 reports/）
  --fail-on-degraded       把“degraded（有承诺项本机无法验证）”也当作失败（退出码 1）

compare 选项
  --modes=single,sharded,shared   要对比的模式（默认全部）
  --variants                      额外跑三个反模式变体
  --users=N --interval=秒 --duration=秒 --rooms=N   三种拓扑用同一个场景

bench 选项
  --users=N            并发用户数（默认 50）
  --interval=秒        每个用户多久编辑一次（默认 0.6）
  --duration=秒        压测时长（默认 20）
  --rooms=N            房间数（默认 1）
  --distribute[=local,http://h1:9100]
                       把用户分摊到多台机器（本机 + agent），用于单机压不动的场景

示例
  npm run doctor
  npm run up -- --mode=sharded
  npm run check -- --users=200 --interval=2
  npm run bench -- --users=2000 --interval=2 --distribute=local,http://10.0.0.5:9100
  npm run compare -- --variants
  npm run down
`;

async function commandUp(flags) {
  const variant = flags.variant ? String(flags.variant) : null;
  const mode = String(flags.mode ?? 'single');
  validateMode(mode, variant);
  const state = await up({
    mode,
    variant,
    overrides: overridesFromFlags(flags),
    withWeb: !flags['no-web'],
    agents: agentsFromFlags(flags),
    agentToken: flags['agent-token'] ? String(flags['agent-token']) : null,
    log: flags.json ? { ...log, info: log.warn } : log,
  });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(state, publicJsonReplacer, 2)}\n`);
    return 0;
  }

  log.info(`[lab] 拓扑 ${state.config.mode} 已启动 · ${describeConfig(state.config)}`);
  if (state.config.variant) {
    log.info(`[lab] 变体：${VARIANTS[state.config.variant].label}`);
    log.info(`[lab] 说明：${VARIANTS[state.config.variant].teachingNote}`);
  }
  for (const node of state.nodes) {
    const where = node.remote ? `  远端 ${node.base}（agent ${node.agentUrl ?? '?'}）` : `  (pid ${node.pid})`;
    log.info(`[lab] ✓ ${node.id}  :${node.port}${where}`);
  }
  if (state.lb) log.info(`[lab] ✓ 负载均衡 :${state.lb.port}  (策略 ${state.lb.strategy})`);
  if (state.redis) log.info(`[lab] ✓ Redis ${state.redis.url}  (${state.redis.mode})`);
  if (state.web) log.info(`[lab] 控制台 → http://127.0.0.1:${state.web.port}/`);
  if (state.remote?.length) {
    const total = state.nodes.length;
    log.info(
      `[lab] 多机：${state.remote.length} 个远端节点 + ${total - state.remote.length} 个本机节点` +
        `（admin token 已写入 .lab/state.json，down 时需要）`,
    );
  }
  log.info('[lab] 下一步：npm run check    停止：npm run down');
  return 0;
}

async function commandDown(flags) {
  const result = await down({ log: flags.json ? { ...log, info: log.warn } : log, stopAgents: parseBool(flags['stop-agents'], false) });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.stopped || !result.survivors?.length ? 0 : 1;
  }
  if (!result.stopped) {
    log.info('[lab] 没有正在运行的 stack。');
    if (result.message && result.survivors?.length) {
      log.warn(`[lab] ${result.message}`);
      for (const survivor of result.survivors) {
        log.warn(`  ✗ ${survivor.label}  pid ${survivor.pid}${survivor.port ? `  :${survivor.port}` : ''}`);
      }
      log.warn('[lab] 状态文件已保留：结束这些进程后再运行一次 npm run down。');
      return 1;
    }
    return 0;
  }
  const parts = [];
  if (result.nodes.length) parts.push(`节点 ${result.nodes.map((n) => `:${n.port}`).join(' ')}`);
  if (result.lb) parts.push('负载均衡');
  if (result.web) parts.push('控制台');
  if (result.redis) parts.push('Redis');
  log.info(`[lab] 已停止：${parts.length ? parts.join('，') : '无'}`);
  for (const entry of result.remote ?? []) {
    if (entry.detached) log.info(`[lab] ✓ 远端节点 ${entry.nodeId} 已摘除（${entry.nodeUrl}）`);
    else log.warn(`[lab] ! 远端节点 ${entry.nodeId} 未能摘除：${entry.error ?? '未知原因'}`);
  }
  return 0;
}

async function commandStatus(flags) {
  const current = await status();
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(current, publicJsonReplacer, 2)}\n`);
    return 0;
  }
  if (!current.running) {
    log.info('[lab] 没有正在运行的 stack。');
    log.info('[lab] 先运行：npm run up -- --mode=single|sharded|shared');
    return 0;
  }
  log.info(
    `[lab] 运行中 · ${current.config.mode}${current.config.variant ? `/${current.config.variant}` : ''} · ${current.describe}`,
  );
  for (const node of current.nodes) {
    const health = node.health ?? {};
    const where = node.remote ? `  远端 ${node.base}（${node.host ?? '?'}）` : '';
    log.info(
      `[lab] ${node.alive ? '✓' : '✗'} ${node.id}  :${node.port}  impl=${health.impl ?? '?'} ` +
        `adapter=${health.adapterEnabled ?? '?'} store=${health.storeMode ?? health.store ?? '?'}${where}`,
    );
  }
  if (current.lb) {
    log.info(`[lab] ${current.lb.alive ? '✓' : '✗'} 负载均衡 :${current.lb.port}  策略=${current.lb.strategy}`);
  }
  if (current.agents?.count) {
    log.info(
      `[lab] 多机：${current.agents.count} 个远端 agent` +
        (current.remote ?? [])
          .map((entry) => ` · ${entry.host ?? '?'}${entry.healthy === false ? '（LB 判定 unhealthy）' : ''}`)
          .join(''),
    );
  }
  log.info(`[lab] ${current.redis ? `✓ Redis ${current.redis.url} (${current.redis.mode})` : '– 未使用 Redis'}`);
  if (current.urls?.web) log.info(`[lab] 控制台 → ${current.urls.web}`);
  log.info('');
  log.info(topologyDiagram({ config: current.config, nodes: current.nodes, lb: current.lb }));
  return 0;
}

async function commandCheck(flags) {
  const progressLog = flags.json ? { ...log, info: log.warn } : log;
  // Scenario first, so a bad --users/--interval fails before we touch the stack.
  const scenario = scenarioFromFlags(flags, CHECK_DEFAULTS);
  const model = modelScenario(scenario);
  if (flags['max-load-clients'] !== undefined) {
    const limit = flags['max-load-clients'];
    if (typeof limit === 'boolean' || !Number.isInteger(Number(limit)) || Number(limit) < 1) {
      throw Object.assign(new Error('--max-load-clients 需要是正整数'), { code: 'BAD_ARGS' });
    }
    process.env.SJS_LAB_MAX_LOAD_CLIENTS = String(Number(limit));
  }
  progressLog.info(`[lab] 场景：${describeScenario(scenario)}`);
  progressLog.info(`[lab] 模型：${describeModel(model)}`);
  progressLog.info('[lab] 正在体检当前运行的拓扑…');
  const { result, files } = await runCheck({
    scenario,
    onProgress: (item) => {
      const mark = { pass: '✓', 'expected-failure': '⚠', fail: '✗', record: '·', running: '…' }[item.status] ?? '·';
      progressLog.info(`  ${mark} ${item.label}`);
    },
    outputDir: flags['out-dir'],
  });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    log.info('');
    log.info(`[lab] 拓扑：${result.describe ?? result.mode}`);
    // The scenario was already announced before the run (and is in the report); printing it
    // again here just repeats two lines above the matrix.
    log.info('');
    log.info(renderCliMatrix(result));
    log.info('');
    log.info(`[lab] 结论：${result.summary.status} — ${result.summary.headline}`);
    for (const advice of result.summary.advice ?? []) log.info(`[lab] 建议：${advice}`);
    if (files) {
      log.info(`[lab] 报告：${files.markdown}`);
      log.info(`[lab] 原始数据：${files.json}`);
    }
  }

  const code = exitCodeFor(result);
  // Opt-in: treat "degraded" (a promised check could not be verified) as failure.
  if (parseBool(flags['fail-on-degraded'], false) && result.summary.status === 'degraded') {
    if (!flags.json) log.info('[lab] --fail-on-degraded：把 degraded 视为失败（退出码 1）。');
    return 1;
  }
  return code;
}

async function commandCompare(flags) {
  const modes = flags.modes ? String(flags.modes).split(',').map((m) => m.trim()) : ['single', 'sharded', 'shared'];
  for (const mode of modes) validateMode(mode, null);
  const scenario = scenarioFromFlags(flags, CHECK_DEFAULTS);
  log.info(`[lab] 依次启动并体检：${modes.join(' → ')}${parseBool(flags.variants, false) ? '（含反模式变体）' : ''}`);
  log.info(`[lab] 场景（三种拓扑共用）：${describeScenario(scenario)}（${describeModel(modelScenario(scenario))}）`);
  log.info('[lab] 每种拓扑都会真实启动一次，大约需要 1-3 分钟。');
  const { results, files } = await runCompare({
    modes,
    includeVariants: parseBool(flags.variants, false),
    scenario,
    log,
  });
  log.info('');
  log.info(renderCompareCli(results));
  log.info('');
  log.info(`[lab] 对比报告：${files.markdown}`);
  log.info(`[lab] 原始数据：${files.json}`);
  return comparisonExitCode(results);
}

async function commandBench(flags) {
  const scenario = scenarioFromFlags(flags, BENCH_DEFAULTS);
  const summary = await runBench({
    scenario,
    distribute: distributeFromFlags(flags),
    room: flags.room ? String(flags.room) : 'bench',
    log,
  });
  log.info('');
  log.info(renderBench(summary));
  return summary.outcome.writesPassed ? 0 : 1;
}

async function commandDoctor(flags) {
  const result = await runDoctor();
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.blockers.length ? 1 : 0;
  }
  log.info('SpreadJS 协同架构验证实验室 · 环境自检');
  log.info(renderDoctor(result));
  log.info('');
  if (result.blockers.length) {
    log.info('[lab] 阻塞项：');
    for (const blocker of result.blockers) log.info(`  ✗ ${blocker}`);
  }
  if (result.warnings.length) {
    log.info('[lab] 注意：');
    for (const warning of result.warnings) log.info(`  ! ${warning}`);
  }
  log.info('');
  log.info('[lab] 可用模式：');
  const env = result.environment;
  log.info('  ✓ single   — 不需要任何外部组件');
  log.info('  ✓ sharded  — 不需要任何外部组件');
  log.info(
    env.redis.available
      ? `  ✓ shared   — Redis ${env.redis.running ? '已连通' : `可用（${env.redis.mode}）`}`
      : '  ✗ shared   — 缺少 Redis（安装 Redis / Docker，或把 redis-server 放进 tools/redis/）',
  );
  log.info(env.license.server ? '  ✓ impl=real — 已配置 server 授权' : '  ✗ impl=real — 缺少 server 授权（mirror 模式仍可验证架构差异）');
  if (env.machineId) log.info(`[lab] 机器码（server 授权绑定用）：${env.machineId}`);
  log.info('');
  return result.blockers.length ? 1 : 0;
}

async function commandWeb(flags) {
  const config = loadLabConfig();
  const port = Number(flags.port ?? config.webPort);
  const host = String(flags.host ?? '127.0.0.1');
  const app = createLabServer({ port, host });
  const url = await app.listen();
  log.info(`[web] 控制台已启动 ${url}`);
  log.info('[web] 未运行任何拓扑时页面会显示“未运行”，可在页面上直接启动。Ctrl+C 退出。');
  const shutdown = async () => {
    log.info('[web] 正在关闭…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise(() => {});
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? (flags.help ? 'help' : 'help');

  if (flags.help || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  switch (command) {
    case 'up':
      return commandUp(flags);
    case 'down':
      return commandDown(flags);
    case 'status':
      return commandStatus(flags);
    case 'check':
      return commandCheck(flags);
    case 'compare':
      return commandCompare(flags);
    case 'bench':
      return commandBench(flags);
    case 'doctor':
      return commandDoctor(flags);
    case 'web':
      return commandWeb(flags);
    default:
      log.error(`[lab] 未知命令 "${command}"`);
      process.stdout.write(HELP);
      return 2;
  }
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((err) => {
      log.error(`[lab] ${err.message}`);
      if (process.env.SJS_LAB_DEBUG) log.error(err.stack ?? '');
      // 2 = the user asked for something impossible (bad scenario / no stack / bad
      // topology flags); 1 = the command ran and the lab failed.
      process.exitCode = err.code === 'NO_STACK' || err.code === 'BAD_SCENARIO' || err.code === 'BAD_ARGS' ? 2 : 1;
    });
}

export { main };
