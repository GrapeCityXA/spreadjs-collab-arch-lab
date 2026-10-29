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
import { sleep } from '../lab/ports.mjs';
import { openClient, closeAll } from '../checks/mirror-client.mjs';
import { modelScenario } from '../lab/scenario.mjs';

/** Hard ceiling for one process: beyond this the generator itself is the bottleneck. */
export const MAX_CLIENTS_PER_PROCESS = 20000;
/** How many raw ACK samples travel in stats (for cross-participant percentile merging). */
export const ACK_SAMPLE_CAP = 500;

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

/**
 * @param {object} options
 * @param {string} options.url              entry URL (LB when the topology has one)
 * @param {string} [options.path]           socket.io path
 * @param {number} options.users            concurrent users
 * @param {number} options.opIntervalMs     one edit per user every N ms
 * @param {number} options.durationMs       how long to write
 * @param {number} [options.rooms]          spread users over N rooms
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
  roomPrefix = 'load',
  labelPrefix = 'load',
  signal,
  onProgress,
} = {}) {
  const totalUsers = Math.max(1, Math.floor(Number(users) || 1));
  if (totalUsers > MAX_CLIENTS_PER_PROCESS) {
    throw Object.assign(
      new Error(`单个进程最多生成 ${MAX_CLIENTS_PER_PROCESS} 个客户端；${totalUsers} 用户请用 --distribute 分摊到多台机器`),
      { code: 'TOO_MANY_CLIENTS' },
    );
  }
  const intervalMs = Math.max(1, Math.floor(Number(opIntervalMs) || 1000));
  const totalMs = Math.max(0, Math.floor(Number(durationMs) || 0));
  const totalRooms = Math.max(1, Math.min(Math.floor(Number(rooms) || 1), totalUsers));

  const roomOf = (index) => Math.min(totalRooms - 1, Math.floor((index * totalRooms) / totalUsers));
  const roomIds = Array.from({ length: totalRooms }, (_, r) => `${roomPrefix}-r${r}`);
  const membersPerRoom = new Array(totalRooms).fill(0);
  for (let i = 0; i < totalUsers; i++) membersPerRoom[roomOf(i)] += 1;

  const pool = [];
  const ackLatencies = [];
  const broadcastLatencies = [];
  const opsPerRoom = new Array(totalRooms).fill(0);
  let opsOk = 0;
  let opsFailed = 0;
  let opened = 0;

  const startedAt = Date.now();
  try {
    for (let i = 0; i < totalUsers; i++) {
      if (signal?.aborted) break;
      const roomId = roomIds[roomOf(i)];
      const client = await openClient({ url, path, roomId, label: `${labelPrefix}-${i}` });
      client.on('op', (op) => {
        if (typeof op?.ts === 'number' && broadcastLatencies.length < 200_000) {
          broadcastLatencies.push(Date.now() - op.ts);
        }
      });
      client.roomIndex = roomOf(i);
      pool.push(client);
      opened += 1;
      onProgress?.({ phase: 'opening', opened, users: totalUsers });
      if (i % 10 === 9) await sleep(10);
    }
    if (signal?.aborted) {
      return buildResult({ cancelled: true });
    }

    const writingAt = Date.now();
    const deadline = writingAt + totalMs;
    let round = 0;
    while (Date.now() < deadline && !signal?.aborted) {
      const roundStarted = Date.now();
      await Promise.all(
        pool.map(async (client, index) => {
          try {
            const ack = await client.setCell(index, round, `load-${round}`, Math.max(15_000, intervalMs * 4));
            ackLatencies.push(ack.latencyMs);
            opsOk += 1;
            opsPerRoom[client.roomIndex] += 1;
          } catch {
            opsFailed += 1;
          }
        }),
      );
      round += 1;
      onProgress?.({ phase: 'running', opened: totalUsers, users: totalUsers, round });
      const elapsed = Date.now() - roundStarted;
      if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
    }
    return buildResult({ cancelled: Boolean(signal?.aborted) });
  } finally {
    closeAll(pool);
  }

  function buildResult({ cancelled }) {
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    const elapsedSec = elapsedMs / 1000;
    const perNode = {};
    for (const client of pool) {
      const key = client.nodeId ?? 'unknown';
      perNode[key] = (perNode[key] ?? 0) + 1;
    }
    // Measured fan-out: every write is broadcast to the other members of its room.
    const fanoutOps = opsPerRoom.reduce((sum, ops, room) => sum + ops * Math.max(0, membersPerRoom[room] - 1), 0);
    const model = modelScenario({ users: totalUsers, opIntervalMs: intervalMs, durationMs: totalMs, rooms: totalRooms });
    return {
      ok: opsFailed === 0 && opsOk > 0,
      cancelled,
      users: opened,
      requestedUsers: totalUsers,
      rooms: totalRooms,
      membersPerRoom,
      opIntervalMs: intervalMs,
      durationMs: totalMs,
      elapsedMs,
      ops: opsOk,
      opsFailed,
      perRoom: opsPerRoom,
      opsPerSecond: Number((opsOk / elapsedSec).toFixed(2)),
      fanoutPerSecond: Number((fanoutOps / elapsedSec).toFixed(0)),
      model,
      ackMs: stats(ackLatencies),
      ackSamples: sampleValues(ackLatencies),
      broadcastMs: stats(broadcastLatencies),
      perNode,
    };
  }
}
