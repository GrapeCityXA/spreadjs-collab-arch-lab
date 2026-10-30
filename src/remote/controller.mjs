/**
 * Controller-side helpers for remote agent hosts (DEV-CONTRACT §12).
 *
 * The orchestrator, `bench --distribute` and the console all drive agent hosts over
 * the same HTTP surface; this module is the only place on the controller that knows
 * the wire shape. Keeping it side-effect free means it can be imported by the CLI,
 * the checks and the web server without starting anything.
 *
 * Every call is bounded. Failure messages name the agent URL, the HTTP status and
 * the action, and never include the token (it is passed as a header only).
 *
 * Exports:
 *   probeAgent(agentUrl, {token, timeoutMs})
 *   attachAgent(agentUrl, {token, lbUrl, nodePort})
 *   detachAgent(agentUrl, {token, lbUrl})
 *   shutdownAgent(agentUrl, {token})
 *   startLoad(agentUrl, {token, ...loadOptions})
 *   cancelLoad(agentUrl, {token})
 *   splitUsers(totalUsers, participants)
 *   mergeLoadStats(statsList)
 */
import { stats as ackStats, connectionBudgetMs, loadRates, roomDistribution } from '../bench/load.mjs';

/** DEV-CONTRACT §12 timeouts. */
export const ATTACH_TIMEOUT_MS = 30_000;
export const DETACH_TIMEOUT_MS = 10_000;
export const STATUS_TIMEOUT_MS = 3_000;
/** ACK/drain allowance, separate from bounded connection and coordination budgets. */
export const LOAD_EXTRA_MS = 90_000;
export const LOAD_COORDINATION_MS = 240_000;
const LOAD_CANCEL_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Error carrying the HTTP status/body, so callers can branch without parsing text. */
export class RemoteAgentError extends Error {
  constructor(message, { action, agentUrl, status = 0, body = null } = {}) {
    super(message);
    this.name = 'RemoteAgentError';
    this.action = action;
    this.agentUrl = agentUrl;
    this.status = status;
    this.body = body;
  }
}

/** Accept `h1:9100`, `http://h1:9100/` and `http://h1:9100` alike. */
export function normalizeAgentUrl(value, what = 'agentUrl') {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${what} is required (expected http://<host>:<port>)`);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`${what} is not a URL: ${JSON.stringify(value)}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${what} must be http(s): ${JSON.stringify(value)}`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function hostOf(agentUrl) {
  try {
    return new URL(normalizeAgentUrl(agentUrl)).hostname;
  } catch {
    return null;
  }
}

/**
 * One bounded JSON call. Throws RemoteAgentError for transport failures and any
 * non-2xx response; returns the parsed body otherwise.
 */
async function requestJson(action, agentUrl, path, { method = 'GET', token, body, timeoutMs, signal } = {}) {
  const base = normalizeAgentUrl(agentUrl);
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let response;
  let text;
  let abortBody;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { 'x-lab-token': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: requestSignal,
    });
    const bodyAborted = new Promise((_, reject) => {
      abortBody = () => reject(Object.assign(new Error('agent response body aborted'), { name: 'AbortError' }));
      requestSignal.addEventListener('abort', abortBody, { once: true });
      if (requestSignal.aborted) abortBody();
    });
    // Keep both the deadline and external cancellation alive through the body.
    // The explicit race also bounds custom/mock fetch implementations whose text()
    // ignores the request signal, rather than silently accepting an empty response.
    text = await Promise.race([response.text(), bodyAborted]);
  } catch (err) {
    const timedOut = controller.signal.aborted;
    const cancelled = signal?.aborted;
    throw new RemoteAgentError(
      cancelled ? `${action} 已取消：${url}` : timedOut
        ? `${action} 超时（>${timeoutMs}ms）：${url}。agent 可能卡在启动节点或 load 尚未结束；检查 agent 日志与网络。`
        : `${action} 无法连接 ${url}：${err?.message ?? err}。确认 agent 已启动、地址可从 controller 访问、防火墙放行。`,
      { action, agentUrl: base },
    );
  } finally {
    clearTimeout(timer);
    if (abortBody) requestSignal.removeEventListener('abort', abortBody);
  }

  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const detail = payload?.detail ?? payload?.error ?? (typeof payload === 'string' ? payload : '');
    const hint =
      response.status === 401
        ? ` token 与 agent 的 --token 不一致（或 agent 启动时没有 --token）。`
        : response.status === 403
          ? ` 该端点被拒绝；检查 token 与 agent 版本。`
          : response.status === 404
            ? ` agent 上没有这个端点：agent 与 controller 是否使用同一个 commit？`
            : '';
    throw new RemoteAgentError(
      `${action} 失败：${url} -> HTTP ${response.status}${detail ? `（${detail}）` : ''}。${hint}`,
      { action, agentUrl: base, status: response.status, body: payload },
    );
  }
  return payload;
}

/** `GET /agent/status` — used as the controller's attach wait / health probe. */
export async function probeAgent(agentUrl, { token, timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  const status = await requestJson('探测 agent', agentUrl, '/agent/status', { token, timeoutMs });
  if (!status || status.ok !== true) {
    throw new RemoteAgentError(`${normalizeAgentUrl(agentUrl)}/agent/status 没有返回 ok:true`, {
      action: '探测 agent',
      agentUrl,
      body: status,
    });
  }
  return status;
}

/**
 * Attach an agent: it starts/keeps its node and registers `http://<publicHost>:<port>`
 * in the LB. Returns the identity the orchestrator records in `state.remote`.
 *
 * `nodeConfig` is the partial env object from DEV-CONTRACT §12 (SJS_STORE, SJS_ADAPTER,
 * SJS_REDIS_URL, …). The agent applies it to its node, restarting it when the running
 * node's effective config differs — that is what keeps `shared`/`sharded` honest across
 * agent hosts instead of silently falling back to each node's local defaults.
 */
export async function attachAgent(agentUrl, { token, lbUrl, nodePort, nodeConfig } = {}) {
  const base = normalizeAgentUrl(agentUrl);
  const body = { lbUrl, token, ...(nodePort === undefined ? {} : { nodePort }) };
  if (nodeConfig !== undefined && nodeConfig !== null) {
    if (typeof nodeConfig !== 'object' || Array.isArray(nodeConfig)) {
      throw new Error('attachAgent nodeConfig must be a plain object of SJS_* env values');
    }
    body.nodeConfig = { ...nodeConfig };
  }
  const result = await requestJson('attach agent', base, '/agent/attach', {
    method: 'POST',
    token,
    body,
    timeoutMs: ATTACH_TIMEOUT_MS,
  });
  if (!result?.ok || !result?.nodeUrl || !result?.nodeId) {
    throw new RemoteAgentError(`attach ${base} 返回了不完整的响应：需要 {ok, nodeUrl, nodeId}`, {
      action: 'attach agent',
      agentUrl: base,
      body: result,
    });
  }
  return {
    agentUrl: base,
    nodeUrl: result.nodeUrl,
    nodeId: result.nodeId,
    host: result.host ?? hostOf(base),
  };
}

/** Detach: the agent deregisters its exact upstream and stops its node. */
export async function detachAgent(agentUrl, { token, lbUrl } = {}) {
  const base = normalizeAgentUrl(agentUrl);
  return requestJson('detach agent', base, '/agent/detach', {
    method: 'POST',
    token,
    body: { lbUrl, token },
    timeoutMs: DETACH_TIMEOUT_MS,
  });
}

/** Shut the agent process down (deregisters + stops its node first). */
export async function shutdownAgent(agentUrl, { token } = {}) {
  const base = normalizeAgentUrl(agentUrl);
  return requestJson('shutdown agent', base, '/agent/shutdown', {
    method: 'POST',
    token,
    body: {},
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
}

/**
 * Run load on one agent. The response body is the shared `runLoad` stats object
 * (DEV-CONTRACT §12) — returned as-is so local and distributed numbers stay
 * comparable.
 */
export async function startLoad(agentUrl, { token, signal, ...loadOptions } = {}) {
  const body = {};
  for (const key of ['lbUrl', 'path', 'users', 'opIntervalMs', 'durationMs', 'rooms', 'totalUsers', 'totalRooms', 'userOffset', 'roomPrefix', 'coordinated', 'loadId', 'coordinationTimeoutMs']) {
    if (loadOptions[key] !== undefined) body[key] = loadOptions[key];
  }
  const durationMs = Number(body.durationMs ?? 0);
  const timeoutMs = (Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0) + LOAD_EXTRA_MS +
    connectionBudgetMs(body.users) + (body.coordinated ? 2 * LOAD_COORDINATION_MS : 0);
  const stats = await requestJson('agent load', agentUrl, '/agent/load', {
    method: 'POST',
    token,
    body,
    timeoutMs,
    signal,
  });
  if (!stats || typeof stats !== 'object') {
    throw new RemoteAgentError(`agent load 没有返回 stats 对象`, {
      action: 'agent load',
      agentUrl,
      body: stats,
    });
  }
  return stats;
}

/** Abort the load currently running on the agent. */
export async function cancelLoad(agentUrl, { token } = {}) {
  return requestJson('cancel agent load', agentUrl, '/agent/load/cancel', {
    method: 'POST',
    token,
    body: {},
    timeoutMs: LOAD_CANCEL_TIMEOUT_MS,
  });
}

export async function startPreparedLoad(agentUrl, { token, loadId } = {}) {
  return requestJson('start prepared agent load', agentUrl, '/agent/load/start', {
    method: 'POST', token, body: { loadId }, timeoutMs: STATUS_TIMEOUT_MS,
  });
}

export async function releaseLoad(agentUrl, { token, loadId } = {}) {
  return requestJson('release completed agent load', agentUrl, '/agent/load/release', {
    method: 'POST', token, body: { loadId }, timeoutMs: STATUS_TIMEOUT_MS,
  });
}

/**
 * Two barriers without cross-host clocks: all sockets ready → start; all writers
 * completed → release sockets. Any failure cancels everyone, including gate waiters.
 * Hooks are injectable so the exact coordination path is testable without listeners.
 */
export async function coordinateLoads(participants, hooks, { timeoutMs = LOAD_COORDINATION_MS, completedTimeoutMs = timeoutMs, pollMs = 50 } = {}) {
  let failure;
  const states = participants.map(() => ({ settled: false, result: null }));
  const jobs = participants.map((participant, index) => Promise.resolve().then(() => hooks.launch(participant, index)).then(
    (result) => { states[index] = { settled: true, result }; return result; },
    (error) => { failure ??= error; throw error; },
  ));
  // Attach rejection handlers before any polling can throw, preventing unhandled jobs.
  const settled = Promise.allSettled(jobs);
  async function barrier(phase) {
    const budget = phase === 'completed' ? completedTimeoutMs : timeoutMs;
    const deadline = Date.now() + budget;
    while (true) {
      if (failure) throw failure;
      const reports = await Promise.all(participants.map((participant, index) => hooks[phase](participant, index)));
      if (failure) throw failure;
      for (let index = 0; index < states.length; index++) {
        if (states[index].settled) throw new Error(`负载参与者 ${index} 在 ${phase} 屏障释放前结束`);
      }
      if (reports.every(Boolean)) return;
      if (Date.now() >= deadline) throw Object.assign(new Error(`负载协调 ${phase} 超出 ${budget}ms`), { code: 'LOAD_COORDINATION_TIMEOUT' });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  try {
    await barrier('ready');
    await Promise.all(participants.map((participant, index) => hooks.start(participant, index)));
    await barrier('completed');
    await Promise.all(participants.map((participant, index) => hooks.release(participant, index)));
    return await Promise.all(jobs);
  } catch (error) {
    await Promise.allSettled(participants.map((participant, index) => hooks.cancel(participant, index)));
    await settled;
    throw error;
  }
}

/**
 * Split `totalUsers` evenly across participants; the remainder goes to the earlier
 * entries (so 10 users / 3 participants = 4,3,3 — never 3,3,4).
 *
 * Participants may be given as `'local'`, `'http://h1:9100'` or `{kind, target}`.
 *
 * @returns {{kind: 'local'|'agent', target: string, users: number, userOffset: number}[]}
 */
export function splitUsers(totalUsers, participants = []) {
  const total = Number(totalUsers);
  if (!Number.isInteger(total) || total < 1) {
    throw new Error(`totalUsers must be a positive integer, got ${JSON.stringify(totalUsers)}`);
  }
  const list = (Array.isArray(participants) ? participants : []).map(normalizeParticipant);
  if (!list.length) {
    throw new Error('splitUsers needs at least one participant ("local" and/or http://<agent>:<port>)');
  }
  const base = Math.floor(total / list.length);
  const remainder = total % list.length;
  let userOffset = 0;
  return list.map((participant, index) => {
    const users = base + (index < remainder ? 1 : 0);
    const slice = { kind: participant.kind, target: participant.target, users, userOffset };
    userOffset += users;
    return slice;
  });
}

function normalizeParticipant(participant) {
  if (typeof participant === 'string') {
    const text = participant.trim();
    if (!text) throw new Error('participant must not be empty');
    if (text === 'local' || text === 'localhost') return { kind: 'local', target: 'local' };
    return { kind: 'agent', target: normalizeAgentUrl(text, 'participant') };
  }
  if (participant && typeof participant === 'object') {
    const kind = participant.kind ?? (participant.target === 'local' ? 'local' : 'agent');
    if (!['local', 'agent'].includes(kind)) {
      throw new Error(`participant.kind must be local|agent, got ${JSON.stringify(participant.kind)}`);
    }
    if (kind === 'local') return { kind: 'local', target: 'local' };
    const target = participant.target ?? participant.url ?? participant.agentUrl;
    return { kind: 'agent', target: normalizeAgentUrl(target, 'participant.target') };
  }
  throw new Error(`invalid participant: ${JSON.stringify(participant)}`);
}

/**
 * Merge per-participant load stats into one aggregate for the report.
 *
 * Percentiles estimate the concatenated retained `ackSamples`, capped per generator.
 * They are neither averaged percentiles nor a percentile weighted by total successful
 * operations. The report must not present them as an exact global ACK distribution.
 * Rates are normalized to the longest participant WRITING window; connection time
 * is separate. This avoids comparing wall clocks across hosts or assuming that
 * sequential socket setup finished at the same instant on every generator.
 */
export function mergeLoadStats(statsList = []) {
  const list = (Array.isArray(statsList) ? statsList : []).filter((stat) => stat && typeof stat === 'object');
  const sum = (pick) => list.reduce((total, stat) => total + (Number(pick(stat)) || 0), 0);

  const users = sum((stat) => stat.users);
  const requestedUsers = sum((stat) => stat.requestedUsers ?? stat.users);
  const ops = sum((stat) => stat.ops);
  // `runLoad` currently reports failed acks as `opsFailed`; accept both so the
  // aggregate keeps its contract field name (`errors`) whichever lands.
  const errors = sum((stat) => stat.errors ?? stat.opsFailed);
  const opsSent = sum((stat) => stat.opsSent ?? ((Number(stat.ops) || 0) + (Number(stat.errors ?? stat.opsFailed) || 0)));
  const elapsedMs = list.reduce((max, stat) => Math.max(max, Number(stat.elapsedMs) || 0), 0);
  const connectionMs = list.reduce((max, stat) => Math.max(max, Number(stat.connectionMs) || 0), 0);
  // Older agents lack writingMs; preserve compatibility but expose that fallback.
  const writingMs = list.reduce((max, stat) => Math.max(max, Number(stat.writingMs ?? stat.elapsedMs) || 0), 0);
  const targetOpsPerSecond = sum((stat) => stat.targetOpsPerSecond ?? ((Number(stat.requestedUsers ?? stat.users) || 0) * 1000 / (Number(stat.opIntervalMs) || 1000)));
  const rooms = list.reduce((max, stat) => Math.max(max, stat.membersPerRoom?.length ?? 0, stat.perRoom?.length ?? 0), 0);
  const membersPerRoom = Array.from({ length: rooms }, (_, room) => sum((stat) => stat.membersPerRoom?.[room]));
  const perRoom = Array.from({ length: rooms }, (_, room) => sum((stat) => stat.perRoom?.[room]));
  const fanoutOps = perRoom.reduce((total, writes, room) => total + writes * Math.max(0, membersPerRoom[room] - 1), 0);
  const broadcastReceived = sum((stat) => stat.broadcastReceived);
  const receiveWindowMs = list.reduce((max, stat) => Math.max(max, Number(stat.receiveWindowMs) || 0), 0);

  const samples = [];
  for (const stat of list) {
    if (Array.isArray(stat.ackSamples)) {
      for (const value of stat.ackSamples) {
        if (typeof value === 'number' && Number.isFinite(value)) samples.push(value);
      }
    }
  }

  const perNode = {};
  for (const stat of list) {
    for (const [nodeId, clients] of Object.entries(stat.perNode ?? {})) {
      perNode[nodeId] = (perNode[nodeId] ?? 0) + (Number(clients) || 0);
    }
  }

  return {
    users,
    requestedUsers,
    ops,
    opsSent,
    elapsedMs,
    connectionMs,
    writingMs,
    timingBasis: list.every((stat) => Number.isFinite(stat.writingMs) &&
      (stat.writingMs > 0 || (stat.writingMs === 0 && stat.skipped === true && stat.users === 0)) &&
      !String(stat.timingBasis ?? '').includes('legacy')) ? 'longest-participant-writing-window' : 'legacy-elapsed-fallback',
    rooms,
    membersPerRoom,
    roomDistribution: roomDistribution(membersPerRoom),
    perRoom,
    fanoutOps,
    fanoutBasis: 'global-room-membership',
    broadcastReceived,
    ...loadRates({ ops, opsSent, writingMs, targetOpsPerSecond, fanoutOps, broadcastReceived }),
    receiveWindowMs,
    broadcastReceiveBasis: 'longest-participant-ready-through-release-window',
    broadcastReceivedPerSecond: receiveWindowMs > 0 ? Number((broadcastReceived * 1000 / receiveWindowMs).toFixed(2)) : 0,
    errors,
    opsFailed: errors,
    cancelled: list.some((stat) => stat.cancelled),
    ackMs: { ...ackStats(samples), note: '参与者保留样本合并的分位估计，非按全部成功操作数加权' },
    perNode,
    participants: list.length,
  };
}
