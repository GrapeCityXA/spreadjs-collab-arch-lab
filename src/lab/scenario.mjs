/**
 * The scenario: "how many users, one edit every N seconds".
 *
 * This is the second axis of the lab. The topology tells you what an architecture
 * *can* do; the scenario tells you what you *need* it to do. Both belong in every
 * report, otherwise two reports are not comparable.
 *
 * One formula lives here and nowhere else:
 *
 *   usersPerRoom    = users / rooms
 *   opsPerSecond    = users / (opIntervalMs / 1000)
 *   q = floor(users / rooms), r = users % rooms
 *   fanoutPerSecond = [r * (q + 1) * q + (rooms - r) * q * (q - 1)] / intervalSeconds
 *   predictedCores  = fanoutPerSecond / 12700 * (presence ? 1.17 : 1)
 *
 * Rooms are balanced: r rooms have q + 1 users and the others have q users.
 * The historical reference coefficient and presence CPU multiplier come from
 * docs/05-performance.md; this models broadcast CPU, not total system resources.
 * Presence does not change the edit fan-out count returned by this model.
 */

/** Check defaults: a short, honest load sample on top of the correctness probes. */
export const CHECK_DEFAULTS = Object.freeze({ users: 20, opIntervalMs: 2000, durationMs: 8000, rooms: 1 });

/** Bench defaults: the historical lab default, a bit heavier than check. */
export const BENCH_DEFAULTS = Object.freeze({ users: 50, opIntervalMs: 600, durationMs: 20000, rooms: 1 });

export const LIMITS = Object.freeze({
  minUsers: 1,
  maxUsers: 100000,
  minIntervalMs: 50,
  maxIntervalMs: 3_600_000,
  minDurationMs: 1000,
  maxDurationMs: 600_000,
  // A SaaS tenant can legitimately have thousands of documents open at once (e.g. 2 000
  // documents × 2 editors). The old cap of 1 000 was an arbitrary lab guard, not a
  // measured limit; 10 000 rooms still fits the 20 000-clients-per-process load generator.
  maxRooms: 10_000,
});

/** Broadcast messages per second that one CPU core sustained in the reference test. */
export const FANOUT_PER_CORE = 12700;
/** Historical presence allowance for broadcast CPU; not a measured message count. */
export const PRESENCE_FACTOR = 1.17;

function fail(message) {
  throw Object.assign(new Error(message), { code: 'BAD_SCENARIO' });
}

function number(value, label, integer = false) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' ||
      !Number.isFinite(Number(value)) || (integer && !Number.isInteger(Number(value)))) {
    fail(`${label}需要${integer ? '整数' : '有限数值'}，请检查输入`);
  }
  return Number(value);
}

/**
 * Accepts loose input (CLI flags, HTTP JSON, old `{clients, intervalMs}` callers) and
 * returns a fully populated, validated scenario. Never silently "fixes" a value
 * without saying so — `notes` carries what was clamped.
 *
 * @param {object} input
 * @param {{users?:number, opIntervalMs?:number, durationMs?:number, rooms?:number}} [defaults]
 * @returns {{users:number, opIntervalMs:number, durationMs:number, rooms:number, notes:string[], defaults:object}}
 */
export function normalizeScenario(input = {}, defaults = CHECK_DEFAULTS) {
  const notes = [];
  const raw = input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('场景需要包含用户数、间隔、时长和房间数的对象');
  // Alias resolution reads the CALLER's input, never the merged object: defaults already
  // contain `opIntervalMs`, and `{...defaults, ...input}` would make `interval: 1` lose
  // to the default 2000ms. That bug made a 1s scenario silently measured as 2s.
  const first = (...keys) => keys.find((key) => raw[key] !== undefined);
  const rawUsers = first('users', 'clients');
  const rawIntervalMs = first('opIntervalMs', 'intervalMs');
  const rawInterval = first('interval');
  const rawDurationMs = first('durationMs');
  const rawDuration = first('duration');
  const rawRooms = first('rooms');

  const users = number(rawUsers === undefined ? defaults.users : raw[rawUsers], '用户数', true);
  const opIntervalMs = rawIntervalMs !== undefined ? number(raw[rawIntervalMs], '编辑间隔') :
    rawInterval !== undefined ? number(raw[rawInterval], '编辑间隔') * 1000 : defaults.opIntervalMs;
  const durationMs = rawDurationMs !== undefined ? number(raw[rawDurationMs], '负载时长') :
    rawDuration !== undefined ? number(raw[rawDuration], '负载时长') * 1000 : defaults.durationMs;
  const rooms = number(rawRooms === undefined ? defaults.rooms : raw[rawRooms], '房间数', true);

  if (users < LIMITS.minUsers) fail(`用户数至少 ${LIMITS.minUsers}`);
  if (users > LIMITS.maxUsers) fail(`用户数最多 ${LIMITS.maxUsers}（再大就不是一台机器的实验了，参考 docs/09-multi-machine.md）`);
  if (opIntervalMs < LIMITS.minIntervalMs) fail(`编辑间隔至少 ${LIMITS.minIntervalMs}ms（每用户每秒最多 20 次编辑）`);
  if (opIntervalMs > LIMITS.maxIntervalMs) fail(`编辑间隔最多 ${LIMITS.maxIntervalMs / 1000} 秒`);
  if (durationMs < LIMITS.minDurationMs) fail(`压测时长至少 ${LIMITS.minDurationMs / 1000} 秒`);
  if (durationMs > LIMITS.maxDurationMs) fail(`压测时长最多 ${LIMITS.maxDurationMs / 1000} 秒`);
  if (rooms < 1) fail('房间数至少 1');
  if (rooms > LIMITS.maxRooms) fail(`房间数最多 ${LIMITS.maxRooms}`);
  if (rooms > users) fail('房间数不能大于用户数');
  return { users, opIntervalMs, durationMs, rooms, notes, defaults: { ...defaults } };
}

/** CLI flags → scenario input (seconds on the command line, ms internally). */
export function scenarioFromFlags(flags = {}, defaults = CHECK_DEFAULTS) {
  const input = {};
  if (flags.users !== undefined) input.users = flags.users;
  else if (flags.clients !== undefined) input.users = flags.clients;
  if (flags['interval-ms'] !== undefined) input.opIntervalMs = flags['interval-ms'];
  else if (flags.interval !== undefined) input.interval = flags.interval;
  if (flags.duration !== undefined) input.duration = flags.duration;
  if (flags.rooms !== undefined) input.rooms = flags.rooms;
  return normalizeScenario(input, defaults);
}

/** Global user index → balanced room index, shared by local and distributed loads. */
export function roomIndexForUser(userIndex, totalUsers, rooms) {
  if (!Number.isSafeInteger(totalUsers) || totalUsers < 1 ||
      !Number.isSafeInteger(rooms) || rooms < 1 || rooms > totalUsers ||
      !Number.isSafeInteger(userIndex) || userIndex < 0 || userIndex >= totalUsers) {
    fail('房间分配需要有效的全局用户序号、总用户数和房间数');
  }
  return Math.floor(userIndex * rooms / totalUsers);
}

/** The balanced-room model; CPU covers broadcast work only. */
export function modelScenario(scenario, { presence = false } = {}) {
  const users = Math.max(1, Math.floor(Number(scenario.users) || 1));
  const rooms = Math.max(1, Math.min(Math.floor(Number(scenario.rooms) || 1), users));
  const opIntervalMs = Math.max(1, Number(scenario.opIntervalMs) || 1000);
  const usersPerRoom = users / rooms;
  const usersPerRoomMin = Math.floor(usersPerRoom);
  const roomsWithExtraUser = users % rooms;
  const usersPerRoomMax = usersPerRoomMin + (roomsWithExtraUser ? 1 : 0);
  const opsPerSecond = users / (opIntervalMs / 1000);
  const recipientPairs = roomsWithExtraUser * usersPerRoomMax * (usersPerRoomMax - 1) +
    (rooms - roomsWithExtraUser) * usersPerRoomMin * (usersPerRoomMin - 1);
  const fanoutPerSecond = recipientPairs / (opIntervalMs / 1000);
  const predictedCores = (fanoutPerSecond / FANOUT_PER_CORE) * (presence ? PRESENCE_FACTOR : 1);
  return {
    usersPerRoom,
    usersPerRoomMin,
    usersPerRoomMax,
    roomsWithExtraUser,
    opsPerSecond,
    fanoutPerSecond,
    predictedCores,
    cpuScope: 'broadcast-only',
    presence,
  };
}

export function formatInterval(ms) {
  return ms >= 1000 ? `${Number((ms / 1000).toFixed(2))} 秒` : `${Math.round(ms)} 毫秒`;
}

/** Human line for reports/CLI: "20 用户 · 每 2 秒一次编辑 · 8 秒 · 1 个房间". */
export function describeScenario(scenario) {
  const users = Number(scenario.users) || 0;
  const rooms = Number(scenario.rooms) || 1;
  return `${users} 用户 · 每 ${formatInterval(Number(scenario.opIntervalMs))}一次编辑 · ${Number(scenario.durationMs) / 1000} 秒 · ${rooms} 个房间`;
}

/** One-line model summary used by the CLI header and the console. */
export function describeModel(model) {
  return `≈ ${Number(model.opsPerSecond.toFixed(2))} 次编辑/s · 扇出 ${Number(model.fanoutPerSecond.toFixed(2))} 条/s · 广播 CPU 模型预测 ${formatCores(model.predictedCores)} 核`;
}

/**
 * Sub-hundredth core counts are common for small scenarios; "0 核" reads like a bug.
 * One formatter so every surface prints the same thing.
 */
export function formatCores(value) {
  const cores = Number(value);
  if (!Number.isFinite(cores)) return '—';
  return cores > 0 && cores < 0.01 ? '<0.01' : String(Number(cores.toFixed(2)));
}

/** Web/CLI handedness: the defaults and hard limits, so no client hardcodes them. */
export function scenarioCatalogue() {
  return {
    defaults: { check: { ...CHECK_DEFAULTS }, bench: { ...BENCH_DEFAULTS } },
    limits: {
      users: { min: LIMITS.minUsers, max: LIMITS.maxUsers },
      opIntervalMs: { min: LIMITS.minIntervalMs, max: LIMITS.maxIntervalMs },
      durationMs: { min: LIMITS.minDurationMs, max: LIMITS.maxDurationMs },
      rooms: { min: 1, max: LIMITS.maxRooms },
    },
    formula: {
      usersPerRoom: 'users / rooms（均匀分配的平均人数）',
      opsPerSecond: 'users / (opIntervalMs / 1000)',
      roomDistribution: 'q = floor(users / rooms), r = users % rooms；r 个房间 q + 1 人，其余 q 人',
      fanoutPerSecond: '(r × (q + 1) × q + (rooms - r) × q × (q - 1)) / (opIntervalMs / 1000)',
      predictedCores: `fanoutPerSecond / ${FANOUT_PER_CORE} × (presence ? ${PRESENCE_FACTOR} : 1)`,
      cpuScope: '仅广播 CPU；零广播不代表零 CPU、内存、磁盘或网络成本',
      source: 'docs/05-performance.md（历史参考系数，原始标定产物未随仓库发布）',
    },
  };
}
