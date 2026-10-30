/**
 * The one place that generates collaboration load.
 *
 * Three callers share it on purpose — `check`'s load phase, `bench`, and the remote
 * agent's `/agent/load`. If each grew its own loop, "2 000 users on two machines"
 * would mean three different measurements, and the numbers in the report would not
 * be comparable with the numbers in the README.
 *
 * What it measures is what a browser would experience: one socket per user, edits at
 * a fixed interval, ACK latency per write, and the delivery lag of `lab:op` frames
 * arriving at the other members (the broadcast path, which is what actually saturates
 * a collaboration server).
 */
import { setTimeout as delay } from 'node:timers/promises';
import { openClient, closeAll } from '../checks/mirror-client.mjs';
import { modelScenario, roomIndexForUser } from '../lab/scenario.mjs';

/** Hard ceiling for one process: beyond this the generator itself is the bottleneck. */
export const MAX_CLIENTS_PER_PROCESS = 20000;
/** How many raw ACK samples travel in stats (for cross-participant percentile merging). */
export const ACK_SAMPLE_CAP = 500;
export const CONNECTION_CONCURRENCY = 10;
/** Bounded socket setup allowance; large slices must not inherit a 30s HTTP cap. */
export function connectionBudgetMs(users) {
  return Math.min(180_000, 30_000 + Math.max(0, Number(users) || 0) * 20);
}

/** Idempotent lifecycle gate. Abort and timeout always release its waiter. */
export function createLoadGate(timeoutMs = 240_000, label = 'load coordination') {
  let released = false;
  const waiters = new Set();
  return {
    release() {
      released = true;
      for (const done of waiters) done();
    },
    wait({ signal } = {}) {
      if (released || signal?.aborted) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(done);
          signal?.removeEventListener('abort', done);
        };
        const done = () => { cleanup(); resolve(); };
        const timer = setTimeout(() => {
          cleanup();
          reject(Object.assign(new Error(`${label} exceeded ${timeoutMs}ms`), { code: 'LOAD_GATE_TIMEOUT' }));
        }, timeoutMs);
        waiters.add(done);
        signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted) done();
      });
    },
  };
}

/** Empty slices finish immediately, so their finish gate must cover the full run. */
export function createLoadGates({ durationMs = 0, coordinationTimeoutMs = 240_000 } = {}) {
  const startTimeoutMs = Math.max(1, Math.min(240_000, Number(coordinationTimeoutMs) || 240_000));
  const finishTimeoutMs = Math.max(0, Math.min(600_000, Number(durationMs) || 0)) + startTimeoutMs;
  return {
    startGate: createLoadGate(startTimeoutMs, 'load start'),
    finishGate: createLoadGate(finishTimeoutMs, 'load release'),
    startTimeoutMs,
    finishTimeoutMs,
  };
}

export function stats(samples) {
  if (!samples.length) return { p50: null, p95: null, p99: null, max: null, samples: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))];
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1], samples: sorted.length };
}

/** Deterministic thinning that keeps the distribution shape (no averaging of percentiles). */
export function sampleValues(values, max = ACK_SAMPLE_CAP) {
  if (values.length <= max) return values.slice();
  const step = values.length / max;
  return Array.from({ length: max }, (_, i) => values[Math.min(values.length - 1, Math.floor(i * step))]);
}

/** All throughput fields use the writing window, never socket establishment time. */
export function loadRates({ ops = 0, opsSent = 0, writingMs = 0, targetOpsPerSecond = 0, fanoutOps = 0, broadcastReceived = 0 }) {
  const rate = (count, digits = 2) => writingMs > 0 ? Number((count * 1000 / writingMs).toFixed(digits)) : 0;
  return {
    opsPerSecond: rate(ops),
    sentOpsPerSecond: rate(opsSent),
    targetOpsPerSecond,
    targetRateAchievement: targetOpsPerSecond > 0 && writingMs > 0 ? opsSent * 1000 / writingMs / targetOpsPerSecond : targetOpsPerSecond > 0 ? 0 : null,
    fanoutPerSecond: rate(fanoutOps, 0),
    broadcastReceivedPerSecond: rate(broadcastReceived),
  };
}

/** Actual connected membership, including empty global rooms on individual slices. */
export function roomDistribution(membersPerRoom = []) {
  const histogram = {};
  for (const members of membersPerRoom) histogram[members] = (histogram[members] ?? 0) + 1;
  return {
    rooms: membersPerRoom.length,
    occupiedRooms: membersPerRoom.filter((members) => members > 0).length,
    minMembers: membersPerRoom.length ? Math.min(...membersPerRoom) : 0,
    maxMembers: membersPerRoom.length ? Math.max(...membersPerRoom) : 0,
    histogram,
  };
}

async function wait(ms, signal) {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
}

/** A late successful connection is closed even when its caller already timed out. */
function connectBefore(pending, { signal, timeoutMs, close }) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(Object.assign(new Error('负载连接已取消'), { code: 'LOAD_CANCELLED' }));
    };
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(Object.assign(new Error(`连接阶段超出预算`), { code: 'LOAD_CONNECT_TIMEOUT' }));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(pending).then((client) => {
      if (finished) { close([client]); return; }
      finished = true;
      cleanup();
      resolve(client);
    }, (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    });
  });
}

/**
 * @param {object} options
 * @param {string} options.url              entry URL (LB when the topology has one)
 * @param {string} [options.path]           socket.io path
 * @param {number} options.users            concurrent users
 * @param {number} options.opIntervalMs     one edit per user every N ms
 * @param {number} options.durationMs       how long to write
 * @param {number} [options.rooms]          spread users over N rooms
 * @param {number} [options.totalUsers]     global users (distributed slices only)
 * @param {number} [options.totalRooms]     global rooms (defaults to rooms)
 * @param {number} [options.userOffset]     first global user index in this slice
 * @param {string} [options.roomPrefix]
 * @param {string} [options.labelPrefix]
 * @param {AbortSignal} [options.signal]    cancel (agent `/agent/load/cancel`)
 * @param {Function} [options.onProgress]   ({phase, opened, users, round})
 */
export async function runLoad({
  url,
  path = '/collaboration/',
  users,
  opIntervalMs,
  durationMs,
  rooms = 1,
  totalUsers: globalUsers,
  totalRooms: globalRooms,
  userOffset = 0,
  roomPrefix = 'load',
  labelPrefix = 'load',
  signal,
  onProgress,
  waitForStart,
  waitForFinish,
  connectTimeoutMs,
} = {}, { openClient: connect = openClient, closeAll: close = closeAll, sleep: pause = wait, now = Date.now } = {}) {
  const localUsers = users === 0 ? 0 : Math.max(1, Math.floor(Number(users) || 1));
  const totalUsers = globalUsers === undefined ? Math.max(1, localUsers) : Number(globalUsers);
  const offset = Number(userOffset);
  if (!Number.isInteger(totalUsers) || totalUsers < 1 || !Number.isInteger(offset) || offset < 0 || offset + localUsers > totalUsers) {
    throw Object.assign(new Error('负载分片需要合法的 totalUsers、userOffset 与 users 范围'), { code: 'BAD_LOAD_SLICE' });
  }
  if (localUsers > MAX_CLIENTS_PER_PROCESS) {
    throw Object.assign(
      new Error(`单个进程最多生成 ${MAX_CLIENTS_PER_PROCESS} 个客户端；${localUsers} 用户请用 --distribute 分摊到多台机器`),
      { code: 'TOO_MANY_CLIENTS' },
    );
  }
  const intervalMs = Math.max(1, Math.floor(Number(opIntervalMs) || 1000));
  const totalMs = Math.max(0, Math.floor(Number(durationMs) || 0));
  const totalRooms = Math.max(1, Math.min(Math.floor(Number(globalRooms ?? rooms) || 1), totalUsers));

  const roomOf = (index) => roomIndexForUser(offset + index, totalUsers, totalRooms);
  const roomIds = Array.from({ length: totalRooms }, (_, r) => `${roomPrefix}-r${r}`);
  const membersPerRoom = new Array(totalRooms).fill(0);

  const pool = [];
  const ackLatencies = [];
  const broadcastLatencies = [];
  const opsPerRoom = new Array(totalRooms).fill(0);
  let opsOk = 0;
  let opsFailed = 0;
  let opsSent = 0;
  let broadcastReceived = 0;
  let opened = 0;
  let connectionMs = 0;
  let writingAt = null;
  let writingEndedAt = null;
  let startWaitMs = 0;
  let finishWaitMs = 0;
  let receiveStartedAt = null;
  const connectionBudget = Math.max(1, Math.min(180_000, Number(connectTimeoutMs) || connectionBudgetMs(localUsers)));

  const startedAt = now();
  try {
    let nextUser = 0;
    let openingError = null;
    const openingController = new AbortController();
    const openingSignal = signal ? AbortSignal.any([signal, openingController.signal]) : openingController.signal;
    async function openWorker() {
      while (nextUser < localUsers && !signal?.aborted && !openingError) {
        const i = nextUser++;
        try {
          if (now() - startedAt > connectionBudget) throw Object.assign(new Error(`连接阶段超出 ${connectionBudget}ms 预算`), { code: 'LOAD_CONNECT_TIMEOUT' });
          const roomId = roomIds[roomOf(i)];
          const client = await connectBefore(connect({ url, path, roomId, label: `${labelPrefix}-${offset + i}` }), {
            signal: openingSignal, timeoutMs: Math.max(1, connectionBudget - (now() - startedAt)), close,
          });
          client.on('op', (op) => {
            if (receiveStartedAt === null) return;
            broadcastReceived += 1;
            if (typeof op?.ts === 'number' && broadcastLatencies.length < 200_000) {
              broadcastLatencies.push(now() - op.ts);
            }
          });
          client.roomIndex = roomOf(i);
          client.userIndex = offset + i;
          pool.push(client);
          membersPerRoom[client.roomIndex] += 1;
          opened += 1;
          onProgress?.({ phase: 'opening', opened, users: localUsers });
        } catch (error) {
          openingError ??= error;
          openingController.abort();
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONNECTION_CONCURRENCY, localUsers) }, () => openWorker()));
    connectionMs = now() - startedAt;
    if (openingError && !signal?.aborted) throw openingError;
    if (signal?.aborted) return buildResult({ cancelled: true });

    const readyAt = now();
    receiveStartedAt = readyAt;
    onProgress?.({ phase: 'ready', opened, users: localUsers });
    await waitForStart?.({ signal, users: opened });
    startWaitMs = now() - readyAt;
    if (signal?.aborted) return buildResult({ cancelled: true });

    writingAt = pool.length ? now() : null;
    const writingStart = now();
    const deadline = writingStart + totalMs;
    let round = 0;
    while (pool.length && now() < deadline && !signal?.aborted) {
      const roundStarted = now();
      await Promise.all(
        pool.map(async (client) => {
          try {
            if (signal?.aborted) return;
            opsSent += 1;
            const ack = await client.setCell(client.userIndex, round, `load-${round}`, Math.min(60_000, Math.max(15_000, intervalMs * 4)));
            ackLatencies.push(ack.latencyMs);
            opsOk += 1;
            opsPerRoom[client.roomIndex] += 1;
          } catch {
            opsFailed += 1;
          }
        }),
      );
      round += 1;
      onProgress?.({ phase: 'running', opened, users: localUsers, round });
      const remaining = Math.min(intervalMs - (now() - roundStarted), deadline - now());
      if (remaining > 0 && !signal?.aborted) await pause(remaining, signal);
    }
    writingEndedAt = now();
    const completedAt = now();
    onProgress?.({ phase: 'completed', opened, users: localUsers, round });
    if (!signal?.aborted) await waitForFinish?.({ signal, users: opened });
    finishWaitMs = now() - completedAt;
    return buildResult({ cancelled: Boolean(signal?.aborted) });
  } finally {
    close(pool);
  }

  function buildResult({ cancelled }) {
    const endedAt = now();
    const elapsedMs = Math.max(0, endedAt - startedAt);
    const writingMs = writingAt === null ? 0 : Math.max(0, (writingEndedAt ?? endedAt) - writingAt);
    const receiveWindowMs = receiveStartedAt === null ? 0 : Math.max(0, endedAt - receiveStartedAt);
    const perNode = {};
    for (const client of pool) {
      const key = client.nodeId ?? 'unknown';
      perNode[key] = (perNode[key] ?? 0) + 1;
    }
    // Derived delivery count, NOT observed deliveries. Distributed merge recomputes
    // this using observed GLOBAL membership rather than a generator's local slice.
    const fanoutOps = opsPerRoom.reduce((sum, ops, room) => sum + ops * Math.max(0, membersPerRoom[room] - 1), 0);
    const model = modelScenario({ users: totalUsers, opIntervalMs: intervalMs, durationMs: totalMs, rooms: totalRooms });
    return {
      ok: !cancelled && opsFailed === 0 && (localUsers === 0 || opsOk > 0),
      cancelled,
      skipped: localUsers === 0,
      users: opened,
      requestedUsers: localUsers,
      totalUsers,
      totalRooms,
      userOffset: offset,
      rooms: totalRooms,
      membersPerRoom,
      roomDistribution: roomDistribution(membersPerRoom),
      opIntervalMs: intervalMs,
      durationMs: totalMs,
      elapsedMs,
      connectionMs,
      writingMs,
      startWaitMs,
      finishWaitMs,
      receiveWindowMs,
      broadcastReceiveBasis: 'ready-through-all-completed-release',
      connectionBudgetMs: connectionBudget,
      timingBasis: waitForStart ? 'coordinated-participant-writing-window' : 'participant-writing-window',
      ops: opsOk,
      opsSent,
      opsFailed,
      perRoom: opsPerRoom,
      fanoutOps,
      fanoutBasis: 'successful-writes-times-observed-room-membership',
      broadcastReceived,
      ...loadRates({ ops: opsOk, opsSent, writingMs, targetOpsPerSecond: localUsers * 1000 / intervalMs, fanoutOps, broadcastReceived }),
      broadcastReceivedPerSecond: receiveWindowMs > 0 ? Number((broadcastReceived * 1000 / receiveWindowMs).toFixed(2)) : 0,
      model,
      modelScope: 'global-scenario',
      ackMs: stats(ackLatencies),
      ackSamples: sampleValues(ackLatencies),
      broadcastMs: stats(broadcastLatencies),
      perNode,
    };
  }
}
