/** Pure load-contract regressions: no listeners, child processes or real sockets. */
import assert from 'node:assert/strict';
import { createLoadGate, createLoadGates, runLoad } from '../src/bench/load.mjs';
import { coordinateLoads, mergeLoadStats, probeAgent, splitUsers, startLoad } from '../src/remote/controller.mjs';

function simulatedClients({ connectMs = 0, failWrites = false, writeMs = 0 } = {}) {
  let clock = 0;
  const clients = [];
  const writes = [];
  return {
    clients,
    writes,
    dependencies: {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      openClient: async (options) => {
        clock += connectMs;
        const client = {
          ...options,
          nodeId: 'simulation',
          on() {},
          async setCell(row, col) {
            clock += writeMs;
            writes.push({ roomId: options.roomId, label: options.label, row, col });
            if (failWrites) throw new Error('simulated ACK failure');
            return { latencyMs: writeMs };
          },
          close() { this.closed = true; },
        };
        clients.push(client);
        return client;
      },
      closeAll: (pool) => pool.forEach((client) => client.close()),
    },
  };
}

async function pairedRooms(users, rooms) {
  const slices = splitUsers(users, ['local', 'http://agent-a:9100', 'http://agent-b:9100']);
  const results = [];
  const clients = [];
  for (const slice of slices) {
    const simulation = simulatedClients({ connectMs: 5 });
    const result = await runLoad({
      users: slice.users, totalUsers: users, totalRooms: rooms, rooms,
      userOffset: slice.userOffset, opIntervalMs: 100, durationMs: 200,
      roomPrefix: 'paired', labelPrefix: 'global-user',
    }, simulation.dependencies);
    results.push(result);
    clients.push(...simulation.clients);
    assert.equal(result.membersPerRoom.length, rooms, 'slices retain all global room slots');
    assert.equal(result.writingMs, 200);
    assert.equal(result.targetRateAchievement, 1, 'connection time does not dilute achieved send rate');
    assert.ok(simulation.writes.every((write) => write.label === `global-user-${write.row}`), 'writes retain global user indices');
    assert.ok(simulation.clients.every((client) => client.closed));
  }
  const actualRooms = new Map();
  for (const client of clients) {
    const members = actualRooms.get(client.roomId) ?? [];
    members.push(Number(client.label.slice('global-user-'.length)));
    actualRooms.set(client.roomId, members);
  }
  assert.equal(actualRooms.size, rooms);
  for (let room = 0; room < rooms; room++) {
    assert.deepEqual(actualRooms.get(`paired-r${room}`).sort((a, b) => a - b), [room * 2, room * 2 + 1]);
  }
  const merged = mergeLoadStats(results);
  assert.deepEqual(merged.membersPerRoom, Array(rooms).fill(2));
  assert.deepEqual(merged.roomDistribution.histogram, { 2: rooms });
  assert.equal(merged.ops, users * 2);
  assert.equal(merged.opsSent, users * 2);
  assert.equal(merged.opsPerSecond, users * 10);
  assert.equal(merged.fanoutPerSecond, users * 10, 'each write has exactly one recipient globally');
  assert.equal(merged.fanoutOps, merged.ops);
  assert.equal(merged.targetRateAchievement, 1);
  assert.equal(merged.timingBasis, 'longest-participant-writing-window');
}

await pairedRooms(12, 6);
await pairedRooms(4000, 2000);

// Original local-only mapping and defaults remain usable, including uneven rooms.
const local = simulatedClients({ connectMs: 1000 });
const localResult = await runLoad({ users: 2, rooms: 1, opIntervalMs: 100, durationMs: 300 }, local.dependencies);
assert.equal(localResult.connectionMs, 2000);
assert.equal(localResult.writingMs, 300);
assert.equal(localResult.elapsedMs, 2300);
assert.equal(localResult.ops, 6);
assert.equal(localResult.opsPerSecond, 20);
assert.equal(localResult.sentOpsPerSecond, 20);
assert.equal(localResult.targetRateAchievement, 1);
const uneven = simulatedClients();
assert.deepEqual((await runLoad({ users: 10, rooms: 3, durationMs: 0 }, uneven.dependencies)).membersPerRoom, [4, 3, 3]);

// Failed ACKs are still attempted sends; they cannot masquerade as successful writes.
const failing = simulatedClients({ failWrites: true });
const failed = await runLoad({ users: 2, rooms: 1, opIntervalMs: 100, durationMs: 300 }, failing.dependencies);
assert.equal(failed.opsSent, 6);
assert.equal(failed.opsFailed, 6);
assert.equal(failed.opsPerSecond, 0);
assert.equal(failed.sentOpsPerSecond, 20);
assert.equal(failed.targetRateAchievement, 1);
assert.equal(failed.ok, false);
assert.equal(failed.fanoutPerSecond, 0);

const slices = splitUsers(2, ['local', 'http://agent-a', 'http://agent-b']);
assert.deepEqual(slices.map(({ users, userOffset }) => [users, userOffset]), [[1, 0], [1, 1], [0, 2]]);
const empty = simulatedClients();
const skipped = await runLoad({ users: 0, totalUsers: 2, totalRooms: 2, userOffset: 2, durationMs: 1000 }, empty.dependencies);
assert.equal(empty.clients.length, 0, 'zero-user slices must not invent one client');
assert.equal(skipped.skipped, true);
assert.equal(skipped.writingMs, 0);
assert.equal(skipped.targetRateAchievement, null);
assert.deepEqual(skipped.membersPerRoom, [0, 0]);

for (const stopAt of [0, 2]) {
  const cancellation = new AbortController();
  if (!stopAt) cancellation.abort();
  const simulation = simulatedClients({ connectMs: 10 });
  const result = await runLoad({ users: 4, rooms: 2, durationMs: 1000, signal: cancellation.signal,
    onProgress: ({ opened }) => { if (opened === stopAt) cancellation.abort(); },
  }, simulation.dependencies);
  assert.equal(result.cancelled, true);
  assert.equal(result.users, simulation.clients.length, 'in-flight opens settle before cleanup');
  assert.equal(result.membersPerRoom.reduce((sum, members) => sum + members, 0), result.users, 'membership records actual opened clients');
  assert.equal(result.writingMs, 0);
  assert.equal(result.opsSent, 0);
  assert.ok(simulation.clients.every((client) => client.closed));
}
const cancellation = new AbortController();
const interrupted = simulatedClients({ writeMs: 20 });
const partial = await runLoad({ users: 1, durationMs: 1000, signal: cancellation.signal,
  onProgress: ({ phase }) => { if (phase === 'running') cancellation.abort(); },
}, interrupted.dependencies);
assert.equal(partial.cancelled, true);
assert.equal(partial.writingMs, 20);
assert.equal(partial.opsSent, 1);
assert.equal(partial.ok, false);

// A timed-out or cancelled in-flight connection can still resolve later. It must
// be closed instead of entering an orphaned pool after runLoad already returned.
for (const abort of [false, true]) {
  let lateClosed = false;
  const stop = new AbortController();
  if (abort) setTimeout(() => stop.abort(), 5);
  const pending = runLoad({ users: 1, durationMs: 100, connectTimeoutMs: abort ? 100 : 5, signal: stop.signal }, {
    openClient: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { on() {}, close() { lateClosed = true; } };
    },
  });
  if (abort) assert.equal((await pending).cancelled, true);
  else await assert.rejects(pending, { code: 'LOAD_CONNECT_TIMEOUT' });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(lateClosed, true);
}

const combined = mergeLoadStats([
  { users: 2, requestedUsers: 2, ops: 20, opsSent: 20, writingMs: 1000, connectionMs: 10000, elapsedMs: 11000,
    targetOpsPerSecond: 20, perRoom: [20, 0], membersPerRoom: [2, 0] },
  { users: 2, requestedUsers: 2, ops: 20, opsSent: 20, writingMs: 1000, connectionMs: 1000, elapsedMs: 2000,
    targetOpsPerSecond: 20, perRoom: [0, 20], membersPerRoom: [0, 2] },
  skipped,
]);
assert.equal(combined.opsPerSecond, 40);
assert.equal(combined.sentOpsPerSecond, 40);
assert.equal(combined.fanoutPerSecond, 40);
assert.equal(combined.connectionMs, 10000);
assert.equal(combined.writingMs, 1000);
assert.equal(combined.elapsedMs, 11000);
assert.equal(combined.targetRateAchievement, 1);
assert.equal(mergeLoadStats([]).opsPerSecond, 0);
assert.equal(mergeLoadStats([{ ops: 1, elapsedMs: 1000 }]).timingBasis, 'legacy-elapsed-fallback');
const remergedLegacy = mergeLoadStats([mergeLoadStats([{ ops: 1, elapsedMs: 1000 }])]);
assert.equal(remergedLegacy.writingMs, 1000);
assert.equal(remergedLegacy.timingBasis, 'legacy-elapsed-fallback', 'a synthesized writingMs cannot erase legacy provenance');
assert.equal(mergeLoadStats([{ users: 1, ops: 1, elapsedMs: 1000, writingMs: 1000,
  timingBasis: 'legacy-elapsed-fallback' }]).timingBasis, 'legacy-elapsed-fallback');
assert.equal(mergeLoadStats([localResult, skipped]).timingBasis, 'longest-participant-writing-window', 'legitimate empty slices do not contaminate timing provenance');
for (const writingMs of [0, -1, NaN, Infinity, '1000']) {
  assert.equal(mergeLoadStats([{ users: 1, writingMs, elapsedMs: 1000 }]).timingBasis, 'legacy-elapsed-fallback');
}

// Exercise the real coordination loop with a slow participant and real async waits.
// All sockets must coexist before any edit; fast writers must retain sockets until
// the slow writer finishes. Each lifecycle gate contributes no throughput time.
async function coordinatedCase({ failConnect = false, timeoutReady = false } = {}) {
  const controls = Array.from({ length: 3 }, () => ({ start: createLoadGate(2000), finish: createLoadGate(2000),
    abort: new AbortController(), ready: false, completed: false, clients: [] }));
  let edits = 0;
  const pending = coordinateLoads(controls, {
    launch: async (control, index) => runLoad({ users: 2, totalUsers: 6, totalRooms: 3, userOffset: index * 2,
      durationMs: index === 2 ? 90 : 40, opIntervalMs: 20, signal: control.abort.signal,
      waitForStart: async ({ signal }) => { control.ready = true; await control.start.wait({ signal }); },
      waitForFinish: async ({ signal }) => { control.completed = true; await control.finish.wait({ signal }); },
    }, {
      openClient: async () => {
        if (index === 2) await new Promise((resolve) => setTimeout(resolve, timeoutReady ? 70 : 20));
        if (index === 2 && failConnect) throw new Error('slow connection failed');
        const client = { on() {}, async setCell() {
          assert.ok(controls.every((item) => item.ready), 'no edits before ALL participants ready');
          assert.ok(controls.every((item) => item.clients.length === 2 && item.clients.every((member) => !member.closed)), 'all participants overlap during writing');
          edits++;
          return { latencyMs: 1 };
        } };
        control.clients.push(client);
        return client;
      },
      closeAll: (clients) => {
        if (!failConnect && !control.abort.signal.aborted) assert.ok(controls.every((item) => item.completed), 'fast participants cannot close early');
        clients.forEach((client) => { client.closed = true; });
      },
    }),
    ready: (control) => control.ready,
    completed: (control) => control.completed,
    start: (control) => control.start.release(),
    release: (control) => control.finish.release(),
    cancel: (control) => { control.abort.abort(); control.start.release(); control.finish.release(); },
  }, { timeoutMs: timeoutReady ? 15 : 2000, pollMs: 1 });
  if (failConnect || timeoutReady) {
    await assert.rejects(pending, failConnect ? /slow connection failed/ : /负载协调 ready/);
    assert.ok(controls.every((control) => control.abort.signal.aborted));
  } else {
    const results = await pending;
    assert.ok(edits > 0);
    assert.ok(results.every((result) => result.timingBasis === 'coordinated-participant-writing-window'));
    assert.ok(results.slice(0, 2).every((result) => result.finishWaitMs > 10), 'fast participants wait for slow writer');
    assert.ok(results.every((result) => result.elapsedMs >= result.writingMs + result.connectionMs));
  }
  assert.ok(controls.every((control) => control.clients.every((client) => client.closed)), 'errors and success close all clients');
}
await coordinatedCase();
await coordinatedCase({ failConnect: true });
await coordinatedCase({ timeoutReady: true });

// A legal long run may contain an empty participant. Its completed gate starts
// before the writers run, so a coordination-only deadline would time out early.
{
  const durationMs = 100;
  const allowanceMs = 60;
  const controls = Array.from({ length: 3 }, () => ({ ...createLoadGates({ durationMs, coordinationTimeoutMs: allowanceMs }),
    abort: new AbortController(), ready: false, completed: false, closed: false }));
  assert.equal(controls[2].startTimeoutMs, allowanceMs);
  assert.equal(controls[2].finishTimeoutMs, durationMs + allowanceMs);
  const results = await coordinateLoads(controls, {
    launch: (control, index) => runLoad({ users: index === 2 ? 0 : 1, totalUsers: 2, totalRooms: 2, userOffset: index,
      durationMs, opIntervalMs: 20, signal: control.abort.signal,
      waitForStart: async ({ signal }) => { control.ready = true; await control.startGate.wait({ signal }); },
      waitForFinish: async ({ signal }) => { control.completed = true; await control.finishGate.wait({ signal }); },
    }, {
      openClient: async () => ({ on() {}, async setCell() { return { latencyMs: 0 }; } }),
      closeAll: () => { control.closed = true; },
    }),
    ready: (control) => control.ready,
    completed: (control) => control.completed,
    start: (control) => control.startGate.release(),
    release: (control) => control.finishGate.release(),
    cancel: (control) => { control.abort.abort(); control.startGate.release(); control.finishGate.release(); },
  }, { timeoutMs: 2000, pollMs: 1 });
  assert.equal(results[2].skipped, true);
  assert.equal(results[2].writingMs, 0);
  assert.ok(results[2].finishWaitMs >= durationMs - 10, 'empty slice waits through writers instead of timing out at the allowance');
  assert.ok(controls.every((control) => control.closed));
}

// HTTP start releases are near-simultaneous, not clock synchronized. An early
// writer and a late writer still deliver to each other's retained ready sockets.
{
  const controls = Array.from({ length: 2 }, () => ({ start: createLoadGate(2000), finish: createLoadGate(2000),
    abort: new AbortController(), ready: false, completed: false, client: null }));
  let delivered = 0;
  const result = await coordinateLoads(controls, {
    launch: (control, index) => runLoad({ users: 1, totalUsers: 2, totalRooms: 1, userOffset: index,
      durationMs: 20, opIntervalMs: 10, signal: control.abort.signal,
      waitForStart: async ({ signal }) => { control.ready = true; await control.start.wait({ signal }); },
      waitForFinish: async ({ signal }) => { control.completed = true; await control.finish.wait({ signal }); },
    }, {
      openClient: async () => {
        control.client = { on(_event, listener) { this.receive = listener; }, async setCell() {
          for (const other of controls) if (other !== control) { other.client.receive({ ts: Date.now() }); delivered++; }
          return { latencyMs: 0 };
        } };
        return control.client;
      },
      closeAll: () => { control.closed = true; },
    }),
    ready: (control) => control.ready,
    completed: (control) => control.completed,
    start: async (control, index) => {
      if (index) await new Promise((resolve) => setTimeout(resolve, 80));
      control.start.release();
    },
    release: (control) => control.finish.release(),
    cancel: (control) => { control.abort.abort(); control.start.release(); control.finish.release(); },
  }, { timeoutMs: 2000, pollMs: 1 });
  assert.ok(delivered > 0);
  assert.equal(result.reduce((sum, stat) => sum + stat.broadcastReceived, 0), delivered, 'receive window includes early and late writes');
  assert.ok(result.every((stat) => stat.receiveWindowMs > stat.writingMs + 30));
  assert.ok(result.every((stat) => stat.broadcastReceiveBasis === 'ready-through-all-completed-release'));
  assert.ok(controls.every((control) => control.closed));
}

// Exercise the controller wire contract without creating an HTTP listener.
const originalFetch = globalThis.fetch;
try {
  let received;
  globalThis.fetch = async (_url, options) => {
    received = JSON.parse(options.body);
    return { ok: true, text: async () => JSON.stringify({ users: 1333, ops: 1 }) };
  };
  await startLoad('http://agent-a:9100', { users: 1333, totalUsers: 4000, totalRooms: 2000,
    rooms: 2000, userOffset: 1334, durationMs: 1000 });
  assert.equal(received.totalUsers, 4000);
  assert.equal(received.totalRooms, 2000);
  assert.equal(received.userOffset, 1334);

  // A server can send headers and then stall or truncate its response body. Both
  // the deadline and explicit cancellation must cover text(), never return {}.
  globalThis.fetch = async () => ({ ok: true, text: () => new Promise(() => {}) });
  await assert.rejects(probeAgent('http://agent-a:9100', { timeoutMs: 10 }), /超时/);
  const abortBody = new AbortController();
  const request = startLoad('http://agent-a:9100', { users: 1, durationMs: 1000, signal: abortBody.signal });
  setTimeout(() => abortBody.abort(), 10);
  await assert.rejects(request, /已取消/);
  globalThis.fetch = async () => ({ ok: true, text: async () => { throw new Error('truncated body'); } });
  await assert.rejects(probeAgent('http://agent-a:9100'), /truncated body/);
} finally {
  globalThis.fetch = originalFetch;
}

process.stdout.write('PASS global room slices (4000/2000/3 and 12/6/3), writing-window rates, coordinated overlap, offset start broadcasts, cancellation/timeout cleanup, empty slices and agent wire fields\n');
