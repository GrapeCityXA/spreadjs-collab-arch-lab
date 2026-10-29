/**
 * The scenario: "how many users, one edit every N seconds".
 *
 * This is the second axis of the lab. The topology tells you what an architecture
 * *can* do; the scenario tells you what you *need* it to do. Both belong in every
 * report, otherwise two reports are not comparable.
 *
 * One formula lives here and nowhere else:
 *
 *   usersPerRoom    = ceil(users / rooms)
 *   opsPerSecond    = users / (opIntervalMs / 1000)
 *   fanoutPerSecond = opsPerSecond * (usersPerRoom - 1)
 *   predictedCores  = fanoutPerSecond / 12700 * (presence ? 1.17 : 1)
 *
 * The 12 700 broadcasts/s/core and the +17 % presence fan-out come from
 * docs/05-performance.md (measured on the reference workload); everything derived
 * here is a MODEL, and every surface that shows it must say so.
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
/** Presence adds fan-out (and a little latency): measured +17 % in the reference test. */
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

/**
 * The one model. Every number is derived from users/interval/rooms — do not
 * duplicate this arithmetic in the console, docs or tests.
 */
export function modelScenario(scenario, { presence = false } = {}) {
  const users = Math.max(1, Number(scenario.users) || 1);
  const rooms = Math.max(1, Math.min(Number(scenario.rooms) || 1, users));
  const opIntervalMs = Math.max(1, Number(scenario.opIntervalMs) || 1000);
  const usersPerRoom = Math.ceil(users / rooms);
  const opsPerSecond = users / (opIntervalMs / 1000);
  const fanoutPerSecond = opsPerSecond * (usersPerRoom - 1);
  const predictedCores = (fanoutPerSecond / FANOUT_PER_CORE) * (presence ? PRESENCE_FACTOR : 1);
  return {
    usersPerRoom,
    opsPerSecond: Number(opsPerSecond.toFixed(2)),
    fanoutPerSecond: Number(fanoutPerSecond.toFixed(0)),
    predictedCores: Number(predictedCores.toFixed(2)),
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
  return `≈ ${model.opsPerSecond} 次编辑/s · 扇出 ${model.fanoutPerSecond} 条/s · 模型预测 ${formatCores(model.predictedCores)} 核`;
}

/**
 * Sub-hundredth core counts are common for small scenarios; "0 核" reads like a bug.
 * One formatter so every surface prints the same thing.
 */
export function formatCores(value) {
  const cores = Number(value);
  if (!Number.isFinite(cores)) return '—';
  return cores < 0.01 ? '<0.01' : String(value);
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
      opsPerSecond: 'users / (opIntervalMs / 1000)',
      fanoutPerSecond: 'opsPerSecond × (ceil(users / rooms) - 1)',
      predictedCores: `fanoutPerSecond / ${FANOUT_PER_CORE} × (presence ? ${PRESENCE_FACTOR} : 1)`,
      source: 'docs/05-performance.md（实测口径：1000 用户 / 单文档 / 33.3k 广播/s ≈ 2.21 核）',
    },
  };
}
