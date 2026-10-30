/**
 * Framework load experiment against the running mirror stack.
 *
 * Exercises message forwarding, room isolation and shared document state with a
 * synthetic scenario (users × seconds-per-edit), optionally using several load
 * generators. It does not drive a real SpreadJS workbook or measure the official
 * collaboration implementation, so its results cannot establish hardware capacity.
 *
 * The generating loop lives in `src/bench/load.mjs` (shared with `check`'s load phase
 * and the remote agent), so a number printed here means the same thing everywhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPORT_DIR, loadLabConfig } from '../lab/paths.mjs';
import { readState } from '../lab/state.mjs';
import { createLoadGates, runLoad } from './load.mjs';
import { BENCH_DEFAULTS, describeScenario, modelScenario, normalizeScenario } from '../lab/scenario.mjs';

export function benchOutcome(ops, cancelled = false) {
  const writesPassed = !cancelled && ops.ok > 0 && ops.failed === 0;
  return {
    status: cancelled ? 'cancelled' : writesPassed ? 'completed' : 'failed',
    writesPassed,
    performance: 'not-evaluated',
    message: cancelled ? '负载已取消，结果不完整。' : writesPassed ?
      'mirror 框架负载实验已完成，本次合成写入没有报告失败；本次未评估生产硬件容量。' :
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
    throw new Error('bench 仅支持 mirror 框架负载实验。硬件评估必须使用真实 SpreadJS、官方协同服务和业务负载；test:official 只验证页面同步，切换 impl=real 不会让 bench 支持官方负载。');
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

  log.info?.(`[lab] mirror 框架负载实验：${describeScenario(sc)}（目标编辑 ${model.opsPerSecond} 次/s · 推算投递 ${model.fanoutPerSecond} 条/s）`);
  log.info?.(`[lab] 目标：${localEntry}${path}（${stack.lb ? `负载均衡 :${stack.lb.port}` : `节点 :${stack.nodes[0].port}`}）`);
  if (participants.length > 1) {
    log.info?.(`[lab] 分摊：${participants.map((p) => (p.kind === 'local' ? '本机' : p.target)).join(' + ')}（每份 ${Math.floor(sc.users / participants.length)} 用户）`);
  }

  const startedAt = Date.now();
  let aggregate;
  let perParticipant = [];

  if (participants.length === 1 && participants[0].kind === 'local') {
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
    const { splitUsers, mergeLoadStats, startLoad, probeAgent, startPreparedLoad, releaseLoad, cancelLoad,
      coordinateLoads } = await controllerHelpers();
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
    const loadId = roomPrefix;
    const controls = slices.map(() => ({ ...createLoadGates({ durationMs: sc.durationMs }),
      controller: new AbortController(), ready: false, completed: false }));
    const results = await coordinateLoads(slices, {
      launch: async (slice, index) => {
        if (slice.kind === 'local') {
          const control = controls[index];
          const stats = await runLoad({
            url: localEntry,
            path,
            users: slice.users,
            totalUsers: sc.users,
            totalRooms: sc.rooms,
            userOffset: slice.userOffset,
            opIntervalMs: sc.opIntervalMs,
            durationMs: sc.durationMs,
            rooms: sc.rooms,
            roomPrefix,
            labelPrefix: 'bench',
            signal: control.controller.signal,
            waitForStart: async ({ signal }) => { control.ready = true; await control.startGate.wait({ signal }); },
            waitForFinish: async ({ signal }) => { control.completed = true; await control.finishGate.wait({ signal }); },
          });
          return { ...stats, kind: 'local', target: 'local', label: '本机', host: null };
        }
        const stats = await startLoad(slice.target, {
          token,
          signal: controls[index].controller.signal,
          // The agent must reach the LB too, so it gets the controller's public address.
          lbUrl: remoteEntry,
          path,
          users: slice.users,
          totalUsers: sc.users,
          totalRooms: sc.rooms,
          userOffset: slice.userOffset,
          opIntervalMs: sc.opIntervalMs,
          durationMs: sc.durationMs,
          rooms: sc.rooms,
          roomPrefix,
          loadId,
          coordinated: true,
        });
        return { ...stats, kind: 'agent', target: slice.target, label: `agent ${hostOf(slice.target)}`, host: hostOf(slice.target) };
      },
      ready: async (slice, index) => {
        if (slice.kind === 'local') return controls[index].ready;
        const status = await probeAgent(slice.target, { token });
        return status.load?.loadId === loadId && status.load?.ready === true;
      },
      completed: async (slice, index) => {
        if (slice.kind === 'local') return controls[index].completed;
        const status = await probeAgent(slice.target, { token });
        return status.load?.loadId === loadId && status.load?.completed === true;
      },
      start: async (slice, index) => slice.kind === 'local' ? controls[index].startGate.release() : startPreparedLoad(slice.target, { token, loadId }),
      release: async (slice, index) => slice.kind === 'local' ? controls[index].finishGate.release() : releaseLoad(slice.target, { token, loadId }),
      cancel: async (slice, index) => {
        controls[index].controller.abort();
        controls[index].startGate.release();
        controls[index].finishGate.release();
        if (slice.kind === 'agent') await cancelLoad(slice.target, { token });
      },
    }, { completedTimeoutMs: sc.durationMs + 90_000 });
    perParticipant = results;
    aggregate = mergeLoadStats(results);
    if (aggregate.timingBasis !== 'legacy-elapsed-fallback') {
      aggregate.timingBasis = 'coordinated-longest-participant-writing-window';
    }
  }

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
      requestedUsers: p.requestedUsers,
      userOffset: p.userOffset,
      membersPerRoom: p.membersPerRoom,
      roomDistribution: p.roomDistribution,
      perRoom: p.perRoom,
      ops: p.ops,
      opsSent: p.opsSent,
      opsFailed: p.opsFailed ?? p.errors ?? 0,
      opsPerSecond: p.opsPerSecond,
      sentOpsPerSecond: p.sentOpsPerSecond,
      targetOpsPerSecond: p.targetOpsPerSecond,
      targetRateAchievement: p.targetRateAchievement,
      connectionMs: p.connectionMs,
      writingMs: p.writingMs,
      elapsedMs: p.elapsedMs,
      startWaitMs: p.startWaitMs,
      finishWaitMs: p.finishWaitMs,
      connectionBudgetMs: p.connectionBudgetMs,
      receiveWindowMs: p.receiveWindowMs,
      broadcastReceiveBasis: p.broadcastReceiveBasis,
      cancelled: p.cancelled,
      skipped: p.skipped,
      fanoutPerSecond: p.fanoutPerSecond,
      fanoutBasis: p.fanoutBasis,
      broadcastReceived: p.broadcastReceived,
      broadcastReceivedPerSecond: p.broadcastReceivedPerSecond,
      ackMs: p.ackMs,
      errors: p.opsFailed ?? p.errors ?? 0,
    })),
    elapsedMs: aggregate.elapsedMs,
    connectionMs: aggregate.connectionMs,
    writingMs: aggregate.writingMs,
    timingBasis: aggregate.timingBasis,
    coordination: aggregate.timingBasis === 'coordinated-longest-participant-writing-window' ? {
      allReadyBeforeWriting: true,
      allCompletedBeforeClosing: true,
      note: '全部连接 ready 后释放写入，全部写入 completed 后释放连接；各主机无需时钟同步，写入窗口取最长参与者。',
    } : null,
    controllerElapsedMs: Date.now() - startedAt,
    ops: {
      ok: aggregate.ops,
      failed: aggregate.errors ?? aggregate.opsFailed ?? 0,
      successRate: aggregate.ops + (aggregate.errors ?? aggregate.opsFailed ?? 0) ? aggregate.ops / (aggregate.ops + (aggregate.errors ?? aggregate.opsFailed ?? 0)) : 0,
    },
    opsPerSecond: aggregate.opsPerSecond,
    opsSent: aggregate.opsSent,
    sentOpsPerSecond: aggregate.sentOpsPerSecond,
    targetOpsPerSecond: aggregate.targetOpsPerSecond,
    targetRateAchievement: aggregate.targetRateAchievement,
    membersPerRoom: aggregate.membersPerRoom,
    roomDistribution: aggregate.roomDistribution,
    perRoom: aggregate.perRoom,
    fanoutOps: aggregate.fanoutOps,
    fanoutPerSecond: aggregate.fanoutPerSecond,
    broadcastReceived: aggregate.broadcastReceived,
    broadcastReceivedPerSecond: aggregate.broadcastReceivedPerSecond,
    receiveWindowMs: aggregate.receiveWindowMs,
    broadcastReceiveBasis: aggregate.broadcastReceiveBasis,
    // Derived from successful writes and actual connected global membership; the
    // independently observed delivery count is `broadcastReceived`.
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

  summary.scope = 'mirror 框架负载实验，验证消息转发、房间隔离与文档共享。硬件评估必须使用真实 SpreadJS、官方协同服务和业务负载；当前 bench 尚未提供官方负载测试。';
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
  lines.push(`[lab] mirror 框架负载实验：${s.scenario.describe}（目标编辑 ${s.scenario.model.opsPerSecond} 次/s · 推算投递 ${s.scenario.model.fanoutPerSecond} 条/s）`);
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
    `[lab] 吞吐：成功 ${s.opsPerSecond} op/s，实际发送 ${s.sentOpsPerSecond} op/s，推算扇出 ${s.fanoutPerSecond} 条/秒（写入窗口 ${s.writingMs}ms` +
      `${s.fanoutBasis === 'global-room-membership' && s.participants.length > 1 ? '，扇出按全局房间成员重算' : ''}）`,
  );
  lines.push(`[lab] 时间：连接 ${s.connectionMs}ms / 写入 ${s.writingMs}ms / 总计 ${s.elapsedMs}ms（${s.timingBasis}）`);
  lines.push(`[lab] 目标发送速率：${s.targetOpsPerSecond} op/s；实际达成率 ${s.targetRateAchievement === null ? '—' : `${(s.targetRateAchievement * 100).toFixed(1)}%`}`);
  lines.push(`[lab] 实测房间分布：${Object.entries(s.roomDistribution?.histogram ?? {}).map(([members, count]) => `${members} 人 × ${count} 房间`).join(' / ') || '—'}；广播实收 ${s.broadcastReceived ?? 0} 条`);
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
