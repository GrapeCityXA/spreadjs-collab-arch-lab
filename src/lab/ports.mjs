/**
 * Port and HTTP helpers.
 *
 * A binding probe is unreliable on Windows: SO_REUSEADDR lets a second listener
 * bind a port that is already served, so "I could bind it" does not mean "it is
 * free". Every readiness/free check here is therefore made by *talking* to the
 * port and inspecting what answers.
 */
import net from 'node:net';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET a URL and parse JSON, with a hard timeout. Throws on anything unusual. */
export async function getJson(url, timeoutMs = 1500, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', ...headers } });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll `url` until `validate(body)` is truthy, or throw with the last error. */
export async function waitForJson(url, { timeoutMs = 30000, intervalMs = 250, label = url, validate } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await getJson(url);
      last = res;
      if (res.ok && (!validate || validate(res.body))) return res.body;
    } catch (err) {
      last = err;
    }
    await sleep(intervalMs);
  }
  const detail = last instanceof Error ? last.message : JSON.stringify(last);
  throw new Error(`${label} 在 ${timeoutMs}ms 内没有就绪（最后一次：${detail}）`);
}

/**
 * Classify a TCP port without binding it.
 *
 * @returns {Promise<'free'|'responding'|'unknown'>}
 *   `free`       nothing accepted a connection
 *   `responding` something accepted it (free check must then inspect the payload)
 */
export async function probeTcp(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs, () => done('free'));
    sock.once('connect', () => done('responding'));
    sock.once('error', () => done('free'));
  });
}

/** Is a port occupied by a service that is not ours? */
export async function assertPortFree(port, label, { waitMs = 3000, host = '127.0.0.1' } = {}) {
  // A process we just killed can hold its socket for a moment (half-closed
  // connections, TCP teardown). Retry briefly instead of failing the next `up`
  // in the same second as the previous `down`.
  const deadline = Date.now() + waitMs;
  for (;;) {
    if ((await probeTcp(port, host)) !== 'responding') return;
    if (Date.now() >= deadline) {
      throw new Error(
        `端口 ${port}（${label}）已被其它进程占用。请先停止占用它的进程，或在 config/lab.config.json 中改端口。`,
      );
    }
    await sleep(150);
  }
}

/** Wait until nothing accepts connections on `port`. Returns true when free. */
export async function waitPortFree(port, timeoutMs = 3000, host = '127.0.0.1') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await probeTcp(port, host)) !== 'responding') return true;
    if (Date.now() >= deadline) return false;
    await sleep(120);
  }
}

/** Minimal JSON POST. Never throws; used for the internal control plane. */
export async function postJson(url, body = null, timeoutMs = 1500, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...(body === null ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { ok: response.ok, status: response.status, body: parsed };
  } catch (err) {
    return { ok: false, status: 0, error: err.message, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/** JSON DELETE (used by the LB admin API to deregister a remote node). */
export async function deleteJson(url, timeoutMs = 3000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'DELETE', headers, signal: controller.signal });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { ok: response.ok, status: response.status, body: parsed };
  } catch (err) {
    return { ok: false, status: 0, error: err.message, body: null };
  } finally {
    clearTimeout(timer);
  }
}
