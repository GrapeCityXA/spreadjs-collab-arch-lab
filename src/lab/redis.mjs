/**
 * Redis resolution for the `shared` mode.
 *
 * The shared-room architecture needs a pub/sub bus between server processes. The
 * lab does not assume one is installed: it looks for the cheapest working option
 * in a fixed order and tells the user exactly which one it used.
 *
 *   1. an explicitly configured URL (SJS_REDIS_URL / SJS_LAB_REDIS_URL)
 *   2. something already answering on the configured port
 *   3. a locally bundled redis-server binary (dev convenience, `tools/redis/`)
 *   4. Docker (`docker run redis:7-alpine`)
 *   5. fail with instructions
 *
 * This is deliberate: silently running the shared mode without a bus would make
 * cross-node delivery fail in a way that looks like a collaboration bug.
 */
import { createClient } from 'redis';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, TOOL_SEARCH_DIRS } from './paths.mjs';
import { spawnBackground } from './proc.mjs';
import { sleep } from './ports.mjs';

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} 在 ${ms}ms 内没有响应`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Ping a Redis URL. Returns true/false, never throws. */
export async function pingRedis(url, timeoutMs = 1200) {
  const client = createClient({
    url,
    // RESP2 explicitly: node-redis negotiates RESP3 with HELLO, which Redis < 6
    // rejects ("ERR unknown command HELLO"). The bundled redis-server is 5.0.x, and
    // RESP2 is supported by every Redis version we accept, so pin it.
    RESP: 2,
    socket: { connectTimeout: timeoutMs, reconnectStrategy: false, keepAlive: false },
  });
  client.on('error', () => {});
  try {
    await withTimeout(client.connect(), timeoutMs, 'Redis 连接');
    const pong = await withTimeout(client.ping(), timeoutMs, 'Redis PING');
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    try {
      client.destroy();
    } catch {
      /* already closed */
    }
  }
}

/** Which executable name a bundled Redis would have on this platform. */
function bundledRedisNames() {
  return process.platform === 'win32'
    ? ['tools/redis/redis-server.exe', 'tools/redis/redis-server', 'redis/redis-server.exe']
    : ['tools/redis/redis-server', 'tools/redis/redis-server.exe'];
}

export function findBundledRedis() {
  if (process.env.SJS_REDIS_BIN && existsSync(process.env.SJS_REDIS_BIN)) return process.env.SJS_REDIS_BIN;
  for (const base of TOOL_SEARCH_DIRS) {
    for (const rel of bundledRedisNames()) {
      const candidate = resolve(base, rel);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function dockerAvailable() {
  const probe = spawnSync('docker', ['info'], { stdio: 'ignore', windowsHide: true, timeout: 8000 });
  return probe.status === 0;
}

/** Write a minimal, throwaway Redis config so a bundled binary does not persist state. */
function writeBundledRedisConf(port) {
  mkdirSync(DATA_DIR, { recursive: true });
  const dir = DATA_DIR.replace(/\\/g, '/');
  const conf = [
    `port ${port}`,
    'bind 127.0.0.1',
    'save ""',
    'appendonly no',
    'daemonize no',
    'logfile ""',
    `dir ${dir}`,
  ].join('\n');
  const file = resolve(DATA_DIR, 'redis.conf');
  writeFileSync(file, `${conf}\n`, 'utf8');
  return file;
}

async function waitForPing(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingRedis(url, 800)) return true;
    await sleep(250);
  }
  return false;
}

/**
 * @returns {Promise<{url: string, mode: 'external'|'bundled'|'docker', owned: boolean, pid: number|null}>}
 */
export async function resolveRedis({ url, port, log = console }) {
  const explicit = process.env.SJS_LAB_REDIS_URL || process.env.SJS_REDIS_URL;
  if (explicit) {
    if (!(await pingRedis(explicit))) {
      throw new Error(
        `已配置 Redis 地址 ${explicit}，但它没有响应。请启动 Redis，或取消该环境变量改用自动探测。`,
      );
    }
    log.info?.(`Redis: 使用外部实例 ${explicit}`);
    return { url: explicit, mode: 'external', owned: false, pid: null };
  }

  const configured = url || `redis://127.0.0.1:${port}`;
  if (await pingRedis(configured)) {
    log.info?.(`Redis: 使用已在运行的 ${configured}`);
    return { url: configured, mode: 'external', owned: false, pid: null };
  }

  const bundled = findBundledRedis();
  if (bundled) {
    const conf = writeBundledRedisConf(port);
    const child = spawnBackground(bundled, [conf], { logFile: 'logs/redis.log' });
    if (await waitForPing(configured)) {
      log.info?.(`Redis: 已用内置二进制启动 ${bundled} (pid ${child.pid})`);
      return { url: configured, mode: 'bundled', owned: true, pid: child.pid };
    }
    child.kill();
    throw new Error(`内置 Redis（${bundled}）启动失败，详见 logs/redis.log。`);
  }

  if (dockerAvailable()) {
    spawnSync('docker', ['rm', '-f', 'sjs-arch-lab-redis'], { stdio: 'ignore', windowsHide: true });
    const run = spawnSync(
      'docker',
      ['run', '-d', '--name', 'sjs-arch-lab-redis', '-p', `${port}:6379`, 'redis:7-alpine'],
      { stdio: 'ignore', windowsHide: true, timeout: 120000 },
    );
    if (run.status === 0 && (await waitForPing(configured, 30000))) {
      log.info?.(`Redis: 已用 Docker 启动 redis:7-alpine（端口 ${port}）`);
      return { url: configured, mode: 'docker', owned: true, pid: null };
    }
    throw new Error('Docker 启动 Redis 失败。可以手动执行：docker run -d -p 6379:6379 redis:7-alpine');
  }

  throw new Error(
    [
      '共享 room 模式需要 Redis，但这台机器上没找到可用的实例。三选一：',
      '  1) Windows 推荐 Docker Desktop（Linux containers），准备步骤见 docs/01-quickstart.md 的 Redis 小节',
      '  2) 已有 Redis 时，用 PowerShell 的 $env:SJS_LAB_REDIS_URL 配置可连接的地址',
      `  3) 把任意 redis-server 放到 tools/redis/ 下（或用 SJS_REDIS_BIN 指向它）`,
      '只想先体验架构差异？用 --mode=single 或 --mode=sharded，它们不需要 Redis。',
    ].join('\n'),
  );
}

/** Tear down a Redis the lab started itself. External instances are never touched. */
export function stopOwnedRedis(redisState, log = console) {
  if (!redisState || !redisState.owned) return;
  if (redisState.pid) {
    try {
      process.kill(redisState.pid, 'SIGTERM');
      log.info?.(`Redis: 已停止内置实例 (pid ${redisState.pid})`);
    } catch {
      /* already gone */
    }
    return;
  }
  spawnSync('docker', ['rm', '-f', 'sjs-arch-lab-redis'], { stdio: 'ignore', windowsHide: true });
  log.info?.('Redis: 已删除 Docker 容器 sjs-arch-lab-redis');
}
