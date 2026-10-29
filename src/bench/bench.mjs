/**
 * Mini load test against the running mirror stack.
 *
 * This is the bridge between the lab and the capacity numbers in
 * `docs/05-performance.md`: instead of trusting someone else's laptop, run the same
 * experiment on yours — with **your** scenario (users × seconds-per-edit), optionally
 * spread over several machines when one generator cannot push enough.
 *
 * The generating loop lives in `src/bench/load.mjs` (shared with `check`'s load phase
 * and the remote agent), so a number printed here means the same thing everywhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPORT_DIR, loadLabConfig } from '../lab/paths.mjs';
import { readState } from '../lab/state.mjs';
import { runLoad } from './load.mjs';
import { BENCH_DEFAULTS, describeModel, describeScenario, modelScenario, normalizeScenario } from '../lab/scenario.mjs';

export function benchOutcome(ops, cancelled = false) {
  const writesPassed = !cancelled && ops.ok > 0 && ops.failed === 0;
  return {
    status: cancelled ? 'cancelled' : writesPassed ? 'completed' : 'failed',
    writesPassed,
    performance: 'not-evaluated',
    message: cancelled ? '负载已取消，结果不完整。' : writesPassed ?
      '负载已完成，本次写入没有报告失败；性能是否满足需求，请结合延迟、样本数和实际场景判断。' :
      '本次存在写入失败或没有成功写入，请检查失败数和日志。',
  };
}
import { timestampForFile } from '../checks/report.mjs';

/**
 * Load the controller-side helper lazily: `bench --distribute` is the only feature
 * that needs it, and a local-only bench must keep working even if that module is
 * broken mid-refactor.
 */
async function controllerHelpers() {
  return import('../remote/controller.mjs');
}

/**
 * Turn `--distribute` into concrete participants.
 * @returns {{kind:'local'|'agent', target:string, host:string|null}[]}
 */
export function resolveParticipants(distribute, stack) {
  const remoteAgents = (stack.remote ?? []).map((r) => r.agentUrl).filter(Boolean);
  if (distribute === true) {
    return [{ kind: 'local', target: 'local', host: null }, ...remoteAgents.map((url) => ({ kind: 'agent', target: url, host: hostOf(url) }))];
  }
  if (Array.isArray(distribute) && distribute.length) {
    const seen = new Set();
    const out = [];
    for (const raw of distribute) {
      const item = String(raw).trim();
      if (!item || seen.has(item)) continue;
      seen.add(item);
      if (item === 'local') out.push({ kind: 'local', target: 'local', host: null });
      else out.push({ kind: 'agent', target: item, host: hostOf(item) });
    }
    return out;
  }
  return [{ kind: 'local', target: 'local', host: null }];
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Broadcast lag across machines is a *per-machine* observation, so the honest
 * aggregate is the worst participant's percentile (never an average: one slow host
 * would disappear into the mean). `samples` is summed so the reader sees the weight.
 */
function mergeBroadcast(perParticipant, aggregate) {
  const rows = perParticipant.filter((p) => p.broadcastMs && p.broadcastMs.samples);
  if (!rows.length) {
    return aggregate.broadcastMs ?? { p50: null, p95: null, p99: null, max: null, samples: 0 };
  }
  const worst = (key) => Math.max(...rows.map((row) => Number(row.broadcastMs[key]) || 0));
  return {
    p50: worst('p50'),
    p95: worst('p95'),
    p99: worst('p99'),
    max: worst('max'),
    samples: rows.reduce((total, row) => total + (Number(row.broadcastMs.samples) || 0), 0),
    note: '多机取最差参与者',
  };
}

/**
 * Broadcast fan-out must be computed from the WHOLE scenario, not per participant:
 * distributed participants share the same room ids, so each one only knows its own
 * slice of the membership. Summing per-participant fan-out would under-report by a
 * factor of the participant count (2000 users over 3 generators would look like 666
 * recipients per write instead of 1999). Rooms are recomposed here by index.
 */
function measuredFanoutAcrossParticipants(statsList, elapsedMs) {
  const list = (Array.isArray(statsList) ? statsList : []).filter(Boolean);
  if (!list.length) return 0;
  const roomCount = Math.max(...list.map((stat) => (Array.isArray(stat.perRoom) ? stat.perRoom.length : 0)));
  let fanoutOps = 0;
  for (let room = 0; room < roomCount; room++) {
    const ops = list.reduce((sum, stat) => sum + (Number(stat.perRoom?.[room]) || 0), 0);
    const members = list.reduce((sum, stat) => sum + (Number(stat.membersPerRoom?.[room]) || 0), 0);
    fanoutOps += ops * Math.max(0, members - 1);
  }
  const seconds = Math.max(1, Number(elapsedMs) || 1) / 1000;
  return Number((fanoutOps / seconds).toFixed(0));
}

/**
 * @param {{scenario?: object, distribute?: boolean|string[], room?: string, log?: object}} options
 */
export async function runBench({ scenario, distribute = false, room = 'bench', log = console } = {}) {
  const stack = readState();
  if (!stack) {
    throw Object.assign(new Error('没有正在运行的 stack。先 `npm run up -- --mode=sharded`，再运行 bench。'), {
      code: 'NO_STACK',
    });
  }
  const cfg = stack.config ?? {};
  if (cfg.impl !== 'mirror') {
    throw new Error('bench 目前只支持 mirror 演示；官方实现请先用 npm run test:official 验证页面同步，容量测试需另行设计真实业务负载。');
  }
  const config = loadLabConfig();
  const lbBase = stack.lb ? stack.lb.base ?? `http://127.0.0.1:${stack.lb.port}` : null;
  const localEntry = lbBase ?? `http://127.0.0.1:${stack.nodes[0].port}`;
  // Remote participants must reach the LB through the controller's *public* address.
  const remoteEntry = config.lbPublicUrl || lbBase || localEntry;
  const path = stack.ports?.wsPath ?? config.wsPath;
  const sc = normalizeScenario(scenario ?? {}, BENCH_DEFAULTS);
  const model = modelScenario(sc, { presence: Boolean(cfg.presence) });
  const participants = resolveParticipants(distribute, stack);
  const token = stack.lb?.adminToken ?? null;

  log.info?.(`[lab] 压测：${describeScenario(sc)}（${describeModel(model)}）`);
  log.info?.(`[lab] 目标：${localEntry}${path}（${stack.lb ? `负载均衡 :${stack.lb.port}` : `节点 :${stack.nodes[0].port}`}）`);
  if (participants.length > 1) {
    log.info?.(`[lab] 分摊：${participants.map((p) => (p.kind === 'local' ? '本机' : p.target)).join(' + ')}（每份 ${Math.floor(sc.users / participants.length)} 用户）`);
  }

  const startedAt = Date.now();
  let aggregate;
  let perParticipant = [];

  if (participants.length === 1) {
    aggregate = await runLoad({
      url: localEntry,
      path,
      users: sc.users,
      opIntervalMs: sc.opIntervalMs,
      durationMs: sc.durationMs,
      rooms: sc.rooms,
      roomPrefix: `${room}-${Date.now().toString(36)}`,
      labelPrefix: 'bench',
    });
    // One participant row even when there is only one generator: a renderer should never
    // need to special-case "local-only" (the old shape had `participants: []`).
    perParticipant = [{ ...aggregate, kind: 'local', target: 'local', label: '本机', host: null }];
  } else {
    const { splitUsers, mergeLoadStats, startLoad, probeAgent } = await controllerHelpers();
    // Fail fast: a dead agent must not silently shrink the load (the numbers would lie).
    for (const participant of participants) {
      if (participant.kind !== 'agent') continue;
      try {
        await probeAgent(participant.target, { token });
      } catch (err) {
        throw Object.assign(
          new Error(`agent ${participant.target} 不可用：${err.message}。先在那台机器启动 npm run agent -- --lb=<controller> --token=<token>`),
          { code: 'AGENT_UNREACHABLE' },
        );
      }
    }
    const slices = splitUsers(sc.users, participants);
    const roomPrefix = `${room}-${Date.now().toString(36)}`;
    const results = await Promise.all(
      slices.map(async (slice) => {
        if (slice.kind === 'local') {
          const stats = await runLoad({
            url: localEntry,
            path,
            users: slice.users,
            opIntervalMs: sc.opIntervalMs,
            durationMs: sc.durationMs,
            rooms: sc.rooms,
            roomPrefix,
            labelPrefix: 'bench',
          });
          return { ...stats, kind: 'local', target: 'local', label: '本机', host: null };
        }
        const stats = await startLoad(slice.target, {
          token,
          // The agent must reach the LB too, so it gets the controller's public address.
          lbUrl: remoteEntry,
          path,
          users: slice.users,
          opIntervalMs: sc.opIntervalMs,
          durationMs: sc.durationMs,
          rooms: sc.rooms,
          roomPrefix,
        });
        return { ...stats, kind: 'agent', target: slice.target, label: `agent ${hostOf(slice.target)}`, host: hostOf(slice.target) };
      }),
    );
    perParticipant = results;
    aggregate = mergeLoadStats(results);
  }

  const fanoutBaseline = perParticipant.length ? perParticipant : [aggregate];
  const mergedFanoutPerSecond = measuredFanoutAcrossParticipants(fanoutBaseline, aggregate.elapsedMs);

  const summary = {
    generatedAt: new Date().toISOString(),
    engine: 'mirror',
    config: cfg,
    describe: stack.describe ?? null,
    scenario: {
      users: sc.users,
      opIntervalMs: sc.opIntervalMs,
      durationMs: sc.durationMs,
      rooms: sc.rooms,
      describe: describeScenario(sc),
      model,
    },
    distributed: participants.length > 1 ? { participants: participants.map((p) => p.target) } : null,
    participants: perParticipant.map((p) => ({
      kind: p.kind ?? 'local',
      label: p.label ?? '本机',
      target: p.target ?? 'local',
      host: p.host ?? null,
      users: p.users,
      ops: p.ops,
      opsFailed: p.opsFailed ?? p.errors ?? 0,
      opsPerSecond: p.opsPerSecond,
      fanoutPerSecond: p.fanoutPerSecond,
      ackMs: p.ackMs,
      errors: p.opsFailed ?? p.errors ?? 0,
    })),
    elapsedMs: Date.now() - startedAt,
    ops: {
      ok: aggregate.ops,
      failed: aggregate.errors ?? aggregate.opsFailed ?? 0,
      successRate: aggregate.ops + (aggregate.errors ?? aggregate.opsFailed ?? 0) ? aggregate.ops / (aggregate.ops + (aggregate.errors ?? aggregate.opsFailed ?? 0)) : 0,
    },
    opsPerSecond: aggregate.opsPerSecond,
    fanoutPerSecond: mergedFanoutPerSecond,
    // Per-participant `fanoutPerSecond` only sees that generator's slice; the aggregate
    // is recomposed from global room membership. Say which is which, so nobody divides
    // two numbers measured differently.
    fanoutBasis: 'global-room-membership',
    ackMs: aggregate.ackMs,
    broadcastMs: participants.length > 1 ? mergeBroadcast(perParticipant, aggregate) : (aggregate.broadcastMs ?? mergeBroadcast(perParticipant, aggregate)),
    perNode: aggregate.perNode ?? {},
    distributedSummary: participants.length > 1 ? { participants: aggregate.participants ?? perParticipant.length } : null,
    // Kept for the old readers: the aggregate sample count is what matters.
    clients: sc.users,
    intervalMs: sc.opIntervalMs,
    durationSec: Number((sc.durationMs / 1000).toFixed(1)),
    note:
      '本机数字只代表这台机器；多机分摊时每个参与者的数字只代表该参与者所在的主机。与 docs/05-performance.md 的实测口径对比时注意负载生成器与服务端是否在同一台机器上。',
  };

  summary.scope = 'mirror 消息转发、房间隔离与文档共享实验；不代表官方 OT 行为或 SpreadJS 容量。';
  summary.outcome = benchOutcome(summary.ops, perParticipant.some((p) => p.cancelled));
  mkdirSync(REPORT_DIR, { recursive: true });
  const file = resolve(REPORT_DIR, `bench-${timestampForFile()}.json`);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  summary.file = file;
  return summary;
}

export function renderBench(summary) {
  const s = summary;
  const lines = [];
  // Same sentence as the pre-run header, so "the line I saw" and "the line in the
  // result" are the same string (docs and logs can quote either).
  lines.push(`[lab] 压测：${s.scenario.describe}（${describeModel(s.scenario.model)}）`);
  lines.push(`[lab] 验证范围：${s.scope}`);
  lines.push(`[lab] 结果：${s.outcome.message}`);
  lines.push(`[lab] 写入：完成 ${s.ops.ok} / 失败 ${s.ops.failed}（成功率 ${(s.ops.successRate * 100).toFixed(1)}%）`);
  lines.push(
    `[lab] ACK 延迟：p50 ${s.ackMs.p50}ms / p95 ${s.ackMs.p95}ms / p99 ${s.ackMs.p99}ms / max ${s.ackMs.max}ms`,
  );
  lines.push(
    `[lab] 广播到达：p50 ${s.broadcastMs.p50}ms / p95 ${s.broadcastMs.p95}ms / p99 ${s.broadcastMs.p99}ms（样本 ${s.broadcastMs.samples}${s.broadcastMs.note ? `，${s.broadcastMs.note}` : ''}）`,
  );
  lines.push(
    `[lab] 吞吐：${s.opsPerSecond} op/s，扇出 ${s.fanoutPerSecond} 条/秒（${s.durationSec}s` +
      `${s.fanoutBasis === 'global-room-membership' && s.participants.length > 1 ? '，扇出按全局房间成员重算' : ''}）`,
  );
  if (s.participants.length > 1) {
    lines.push('[lab] 参与者：');
    for (const p of s.participants) {
      lines.push(
        `       ${p.label.padEnd(28)} ${String(p.users).padStart(5)} 用户  ${String(p.ops).padStart(6)} ops  ` +
          `p50 ${String(p.ackMs.p50).padStart(4)}ms  p95 ${String(p.ackMs.p95).padStart(4)}ms  失败 ${p.errors}`,
      );
    }
  }
  lines.push(`[lab] 节点分布：${Object.entries(s.perNode).map(([k, v]) => `${k}×${v}`).join(' / ') || '—'}`);
  lines.push(`[lab] 报告：${s.file}`);
  lines.push(`[lab] 注意：${s.note}`);
  return lines.join('\n');
}
