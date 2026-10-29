#!/usr/bin/env node
/**
 * Capacity / cost estimate: from "how many people edit one document at once" to
 * "how many cores and nodes does that need".
 *
 * This is the bridge between the numbers in docs/05-performance.md and a user's own
 * scenario. It is a MODEL, not a promise: the domain fact behind it is that a
 * collaboration server's cost is dominated by broadcast fan-out, which grows with
 * the square of the number of concurrent editors in one room.
 *
 *   ops/s       = users / interval
 *   fan-out/s   = users * (users - 1) / interval        (every edit to every peer)
 *   cost        ≈ fan-out/s / 12,700 messages per second per core   (measured)
 *
 * Usage:
 *   npm run capacity -- --users=1000 --interval=600
 *   npm run capacity -- --users=200 --interval=600 --json
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { REPORT_DIR } from '../src/lab/paths.mjs';
// The model lives in exactly one place: src/lab/scenario.mjs. `check`, `bench`,
// `compare`, the console and this script must agree, or the numbers start to drift.
import { FANOUT_PER_CORE, PRESENCE_FACTOR, modelScenario } from '../src/lab/scenario.mjs';

const MESSAGES_PER_CORE_PER_SEC = FANOUT_PER_CORE; // measured on the reference hardware (docs/05)
const PRESENCE_FANOUT_FACTOR = PRESENCE_FACTOR; // presence adds ~17% fan-out, +115ms p95

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(hit.indexOf('=') + 1);
  return process.argv.includes(`--${name}`) ? NaN : fallback;
}

const users = Number(arg('users', 1000));
const intervalMs = Number(arg('interval', 600));
const roomCount = Number(arg('rooms', 1));
const nodeCores = Number(arg('node-cores', 4));
const withPresence = process.argv.includes('--presence');
const asJson = process.argv.includes('--json');

if (!Number.isSafeInteger(users) || users < 2) {
  process.stderr.write('[capacity] --users 需要是 >= 2 的整数\n');
  process.exit(2);
}
if (!Number.isFinite(intervalMs) || intervalMs < 50) {
  process.stderr.write('[capacity] --interval 需要 >= 50（毫秒）\n');
  process.exit(2);
}
if (!Number.isSafeInteger(roomCount) || roomCount < 1 || roomCount > users) {
  process.stderr.write('[capacity] --rooms 需要是 1 到用户数之间的整数\n');
  process.exit(2);
}
if (!Number.isSafeInteger(nodeCores) || nodeCores < 1) {
  process.stderr.write('[capacity] --node-cores 需要是正整数\n');
  process.exit(2);
}

const model = modelScenario({ users, opIntervalMs: intervalMs, durationMs: 1000, rooms: roomCount }, { presence: withPresence });
const usersPerRoom = model.usersPerRoom;
const editsPerSec = model.opsPerSecond;
const fanoutPerSec = model.fanoutPerSecond;
const fanoutWithPresence = fanoutPerSec;
const coresNeeded = model.predictedCores;
const nodesNeeded = Math.max(1, Math.ceil(coresNeeded / nodeCores));

/** If the user already ran `npm run bench`, compare the model to their machine. */
function latestBench() {
  try {
    const files = readdirSync(REPORT_DIR)
      .filter((f) => f.startsWith('bench-') && f.endsWith('.json'))
      .sort();
    if (!files.length) return null;
    return JSON.parse(readFileSync(resolve(REPORT_DIR, files[files.length - 1]), 'utf8'));
  } catch {
    return null;
  }
}

const bench = latestBench();
const lines = [];
lines.push('协同容量估算（模型，不是承诺）');
lines.push('');
lines.push(`输入：${users} 人 · 每人每 ${intervalMs}ms 编辑一次 · ${roomCount} 个房间 · presence ${withPresence ? '开启' : '关闭'}`);
lines.push(`本机 CPU：${cpus().length} 核（估算用的每节点核心数：${nodeCores}）`);
lines.push('范围：按历史官方测试系数进行模型估算，未运行负载，不能证明当前 SpreadJS 实现的容量。');
lines.push('');
lines.push(`每秒编辑数        ${editsPerSec.toFixed(1)} 次/秒`);
lines.push(`每秒广播消息数    ${Math.round(fanoutWithPresence).toLocaleString('en-US')} 条/秒`);
lines.push(
  `所需 CPU 核心     ≈ ${coresNeeded.toFixed(2)} 核（按每核 ${MESSAGES_PER_CORE_PER_SEC.toLocaleString('en-US')} 条/秒${withPresence ? '，presence ×1.17' : ''}）`,
);
lines.push(`所需节点数        ≈ ${nodesNeeded} 个（每节点 ${nodeCores} 核）`);
lines.push('');
lines.push('关键结论：');
lines.push(`  · 成本随“同一房间的并发人数”平方增长。当前 ${usersPerRoom.toFixed(0)} 人/房间，广播是编辑数的 ${(usersPerRoom - 1).toFixed(0)} 倍。`);
lines.push('  · 房间人数不是固定的容量安全线。请用真实工作簿、编辑频率与目标延迟实测，再决定是否扩容。');
lines.push('');
lines.push('同一批人、不同编辑频率下的扇出（编辑越频繁，成本涨得越快）：');
for (const ms of [600, 2000, 5000, 30_000]) {
  const f = (usersPerRoom * (usersPerRoom - 1) * roomCount) / (ms / 1000) * (withPresence ? PRESENCE_FANOUT_FACTOR : 1);
  lines.push(
    `  每 ${String(ms / 1000).padStart(5)}s 一次   ${Math.round(f).toLocaleString('en-US').padStart(12)} 条/秒   ≈ ${(f / MESSAGES_PER_CORE_PER_SEC).toFixed(1)} 核`,
  );
}
lines.push('  （docs/05 里 1000 人单文档的 33.3k 条/秒，对应的是“平均每 30 秒一次编辑”这一档。）');

if (bench) {
  const benchScenario = bench.scenario ?? null;
  const measuredFanout = bench.fanoutPerSecond ?? 0;
  const measuredAck = bench.ackMs?.p95 ?? null;
  const sameScenario =
    benchScenario &&
    benchScenario.users === users &&
    benchScenario.opIntervalMs === intervalMs &&
    benchScenario.rooms === roomCount;
  lines.push('');
  lines.push(`你上次 bench 的实测（${bench.generatedAt}）：`);
  if (benchScenario) {
    lines.push(
      `  · 场景：${benchScenario.describe ?? `${benchScenario.users} 用户 · 每 ${benchScenario.opIntervalMs}ms 一次编辑`}` +
        `${sameScenario ? '' : '（和上面的输入不同，仅作参考）'}`,
    );
  }
  const benchClients = benchScenario?.users ?? bench.clients ?? 0;
  const benchSeconds = benchScenario ? benchScenario.durationMs / 1000 : bench.durationSec ?? 0;
  lines.push(`  · ${benchClients} 客户端 / 房间，${benchSeconds}s，实测扇出 ${Math.round(measuredFanout).toLocaleString('en-US')} 条/秒，ACK p95 ${measuredAck}ms`);
  if (bench.distributed && (bench.participants ?? []).length > 1) {
    lines.push(`  · 分布式：${bench.participants.map((p) => `${p.label}(${p.users} 用户)`).join(' + ')}`);
  }
  if (measuredFanout > 0) {
    const ratio = fanoutWithPresence / measuredFanout;
    lines.push(`  · 目标的扇出是那次实测的 ${ratio.toFixed(2)} 倍${ratio > 1 ? '（超过实测规模，需要更多机器或降低同时编辑率）' : '（在实测规模之内）'}`);
  }
  lines.push('  · 注意：那次 bench 的客户端和服务端在同一台机器上时数字偏乐观；跨机部署请看 docs/05 的两种口径。');
} else {
  lines.push('');
  lines.push('还没有本机 bench 数据。可先运行 mirror 小负载，观察消息转发；它不能代替官方实现的容量测试：');
  lines.push('  npm run up -- --mode=shared');
  lines.push(`  npm run bench -- --users=${users} --interval=${intervalMs / 1000} --duration=20`);
}

lines.push('');
lines.push('未计入：网络往返（跨地域会显著抬高 ACK）、公式/图表的增量体积、快照与导入导出、');
lines.push('      每个房间的常驻内存、presence 的 UI 刷新频率。生产选型请再按 docs/06 做一次真实压测。');

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        scope: '历史参考模型估算，未运行负载；不代表当前 SpreadJS 实现的容量。',
        input: { users, intervalMs, rooms: roomCount, nodeCores, presence: withPresence },
        model: {
          messagesPerCorePerSec: MESSAGES_PER_CORE_PER_SEC,
          presenceFanoutFactor: withPresence ? PRESENCE_FANOUT_FACTOR : 1,
        },
        estimate: {
          usersPerRoom,
          editsPerSec: Number(editsPerSec.toFixed(2)),
          fanoutPerSec: Math.round(fanoutWithPresence),
          coresNeeded: Number(coresNeeded.toFixed(2)),
          nodesNeeded,
        },
        bench: bench
          ? {
              generatedAt: bench.generatedAt,
              scenario: bench.scenario
                ? { users: bench.scenario.users, opIntervalMs: bench.scenario.opIntervalMs, rooms: bench.scenario.rooms, durationMs: bench.scenario.durationMs }
                : null,
              clients: bench.scenario?.users ?? bench.clients ?? null,
              fanoutPerSecond: bench.fanoutPerSecond,
              ackP95: bench.ackMs?.p95 ?? null,
              distributed: Boolean(bench.distributed),
              participants: (bench.participants ?? []).length,
            }
          : null,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(`${lines.join('\n')}\n`);
}
