/**
 * Configuration for one collaboration-server node.
 *
 * Everything the node needs to start is resolved here, once, from CLI flags and
 * environment (see DEV-CONTRACT §3). Keeping it in a pure module - no side effects,
 * no process.exit - is what lets the orchestrator, the checks and the tests import
 * the same resolution rules instead of re-implementing them.
 *
 * Resolution order per setting: CLI flag > environment variable > default.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root of the lab (`spreadjs-collab-arch-lab/`). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_DIR = resolve(ROOT, 'config');
export const DATA_DIR = resolve(ROOT, 'data');

/** Socket.IO path. Server, browser client and load balancer must agree on it. */
export const DEFAULT_PATH = '/collaboration/';
export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
export const DEFAULT_PORT = 8081;
/** Room a client lands in when it neither passes `?roomId=` nor SJS_ROOM is set. */
export const DEFAULT_ROOM = 'default-room';
/** Storage modes of the mirror document store (DEV-CONTRACT §4). */
export const STORE_MODES = ['local', 'shared'];
export const IMPL_IDS = ['mirror', 'real'];

export function boolEnv(name, fallback = false, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/**
 * Parse `--flag`, `--key=value` and `--key value` into a plain object.
 * Both spellings are accepted because users type both and the contract only
 * pins down `--port=`-style for the documented commands.
 */
export function parseArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/** Resolve a possibly-relative path against the lab root (not the cwd). */
export function resolveFromRoot(file) {
  return isAbsolute(file) ? resolve(file) : resolve(ROOT, file);
}

export function readJsonFile(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    // A malformed license file must not crash the node with a stack trace: the
    // operator needs to know which file to fix.
    throw new Error(`failed to parse ${file}: ${err.message}`);
  }
}

/**
 * Resolve the three GrapeCity license keys.
 *
 * They are validated by three different components and are NOT interchangeable:
 *   runtime  -> SpreadJS core in the browser
 *   designer -> SpreadJS Designer in the browser
 *   server   -> the js-collaboration server (machine-bound)
 *
 * Accepted shapes (nested is canonical, flat is accepted for older installs):
 *   { runtime:{licenseKey}, designer:{licenseKey}, server:{serverLicenseKey} }
 *   { licenseKey, designerLicenseKey, serverLicenseKey }
 *
 * The values never leave this object except into the server instance; only
 * SET/MISSING is ever logged (DEV-CONTRACT §0).
 */
export function resolveLicense(
  file = undefined,
  env = process.env,
) {
  const requestedFile = file ?? env.SJS_LICENSE_FILE;
  const licenseFile = resolveFromRoot(requestedFile || resolve(CONFIG_DIR, 'license.json'));
  const present = existsSync(licenseFile);
  if (requestedFile && !present) throw new Error(`指定的授权文件不存在：${licenseFile}`);
  let raw = {};
  if (present) {
    try {
      raw = readJsonFile(licenseFile);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid shape');
    } catch {
      throw new Error(`授权文件格式错误：${licenseFile}，请按 config/license.example.json 检查 JSON 格式。`);
    }
  }

  const runtimeFile = raw.runtime?.licenseKey ?? raw.licenseKey ?? '';
  const designerFile = raw.designer?.licenseKey ?? raw.designerLicenseKey ?? '';
  const serverFile = raw.server?.serverLicenseKey ?? raw.serverLicenseKey ?? '';

  const licenseKey = String(env.SJS_LICENSE_KEY || runtimeFile).trim();
  const designerLicenseKey = String(env.SJS_DESIGNER_LICENSE_KEY || designerFile).trim();
  const serverLicenseKey = String(env.SJS_SERVER_LICENSE_KEY || serverFile).trim();
  const anyEnv = Boolean(env.SJS_LICENSE_KEY || env.SJS_DESIGNER_LICENSE_KEY || env.SJS_SERVER_LICENSE_KEY);

  return {
    licenseKey,
    designerLicenseKey,
    serverLicenseKey,
    file: licenseFile,
    present,
    source: anyEnv ? 'env' : existsSync(licenseFile) ? relativeToRoot(licenseFile) : 'none',
    status: {
      runtime: Boolean(licenseKey),
      designer: Boolean(designerLicenseKey),
      server: Boolean(serverLicenseKey),
    },
  };
}

/** One line, no key material: what the operator needs to see at startup. */
export function describeLicense(license) {
  const flag = (present) => (present ? 'SET' : 'MISSING');
  return (
    `license: runtime.licenseKey=${flag(license.status.runtime)} ` +
    `designer.licenseKey=${flag(license.status.designer)} ` +
    `server.serverLicenseKey=${flag(license.status.server)} (source: ${license.source})`
  );
}

function relativeToRoot(file) {
  const path = relative(ROOT, resolve(file));
  // A license file may live outside the lab (SJS_LICENSE_FILE pointing at a
  // workspace-level config). Only shorten paths that are actually inside it.
  if (!path || path.startsWith('..') || isAbsolute(path)) return file;
  return path.replaceAll('\\', '/');
}

function toPort(value, what) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${what} must be an integer between 1 and 65535, got ${JSON.stringify(value)}`);
  }
  return port;
}

function toChoice(value, allowed, what) {
  const lowered = String(value).toLowerCase();
  if (!allowed.includes(lowered)) {
    throw new Error(`${what} must be one of ${allowed.join('|')}, got ${JSON.stringify(value)}`);
  }
  return lowered;
}

function toPositiveInt(value, what) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${what} must be a positive integer (milliseconds), got ${JSON.stringify(value)}`);
  }
  return number;
}

/**
 * Resolve the effective configuration of one node.
 *
 * @param {string[]} argv process.argv.slice(2)
 * @param {Record<string,string|undefined>} [env] injectable for tests; defaults to process.env
 */
export function resolveConfig(argv = [], env = process.env) {
  const args = parseArgs(argv);
  const port = toPort(args.port ?? env.SJS_PORT ?? DEFAULT_PORT, 'port (--port / SJS_PORT)');
  const nodeId = String(args['node-id'] ?? env.SJS_NODE_ID ?? `node-${port}`);
  const license = resolveLicense(undefined, env);

  // The mirror is the zero-license path, so it is the default whenever no server
  // key is configured. Never the other way round: silently falling back to the
  // mirror from an intended `real` run would hide a licensing problem.
  const impl = toChoice(env.SJS_IMPL || (license.serverLicenseKey ? 'real' : 'mirror'), IMPL_IDS, 'SJS_IMPL');

  const storeMode = toChoice(env.SJS_STORE || 'local', STORE_MODES, 'SJS_STORE');
  const otDbMode = toChoice(env.SJS_OT_DB || 'sqlite', ['memory', 'sqlite'], 'SJS_OT_DB');

  return {
    root: ROOT,
    dataDir: DATA_DIR,
    port,
    nodeId,
    impl,
    path: env.SJS_PATH || DEFAULT_PATH,
    adapterEnabled: boolEnv('SJS_ADAPTER', true, env),
    redisUrl: env.SJS_REDIS_URL || DEFAULT_REDIS_URL,
    redisConnectTimeoutMs: toPositiveInt(
      env.SJS_REDIS_CONNECT_TIMEOUT_MS ?? 5000,
      'SJS_REDIS_CONNECT_TIMEOUT_MS',
    ),
    otEnabled: boolEnv('SJS_OT', false, env),
    otDbMode,
    otDbFile: resolveFromRoot(env.SJS_OT_DB_FILE || resolve(DATA_DIR, 'ot.sqlite')),
    presenceEnabled: boolEnv('SJS_PRESENCE', false, env),
    storeMode,
    storeFile: resolveFromRoot(env.SJS_STORE_FILE || resolve(DATA_DIR, 'lab-store.sqlite')),
    bindHost: env.SJS_BIND_HOST || '127.0.0.1',
    verbose: boolEnv('SJS_VERBOSE', false, env),
    roomFallback: env.SJS_ROOM || DEFAULT_ROOM,
    license,
  };
}
