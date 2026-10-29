/**
 * Filesystem locations and lab configuration.
 *
 * Everything the lab writes at runtime lives under the lab root and is gitignored
 * (`.lab/`, `data/`, `logs/`, `reports/`), so a `git status` after a run stays clean.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_DIR = resolve(LAB_ROOT, 'config');
export const LAB_CONFIG_FILE = resolve(CONFIG_DIR, 'lab.config.json');
export const LICENSE_FILE = resolve(CONFIG_DIR, 'license.json');
export const STATE_DIR = resolve(LAB_ROOT, '.lab');
export const STATE_FILE = resolve(STATE_DIR, 'state.json');
export const LOG_DIR = resolve(LAB_ROOT, 'logs');
export const DATA_DIR = resolve(LAB_ROOT, 'data');
export const REPORT_DIR = resolve(LAB_ROOT, 'reports');
export const PUBLIC_DIR = resolve(LAB_ROOT, 'public');

/** Directories searched for an optional bundled Redis binary (dev convenience). */
export const TOOL_SEARCH_DIRS = [LAB_ROOT, resolve(LAB_ROOT, '..')];

const DEFAULTS = {
  lbPort: 3000,
  webPort: 5173,
  nodeBasePort: 8081,
  redisPort: 6379,
  redisUrl: 'redis://127.0.0.1:6379',
  wsPath: '/collaboration/',
  defaultRoom: 'arch-lab-demo',
  defaultNodes: 3,
  bindHost: '127.0.0.1',
  // Address that OTHER machines use to reach this controller's load balancer.
  // Defaults to bindHost, which is correct for one-machine use; in a multi-machine
  // setup point it at the controller's LAN IP (or set SJS_LAB_LB_PUBLIC_URL).
  lbPublicUrl: null,
  // Port range used when two agents are simulated on one machine.
  maxLoadClients: 300,
};

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`无法解析 ${file}: ${err.message}`);
  }
}

/**
 * Resolve lab config: `config/lab.config.json` over defaults, then a small set of
 * environment overrides. Env wins so scripts can relocate ports without editing files.
 */
export function loadLabConfig() {
  const file = readJson(LAB_CONFIG_FILE) ?? {};
  const cfg = { ...DEFAULTS, ...file };
  const env = process.env;
  if (env.SJS_LAB_LB_PORT) cfg.lbPort = Number(env.SJS_LAB_LB_PORT);
  if (env.SJS_LAB_WEB_PORT) cfg.webPort = Number(env.SJS_LAB_WEB_PORT);
  if (env.SJS_LAB_NODE_BASE_PORT) cfg.nodeBasePort = Number(env.SJS_LAB_NODE_BASE_PORT);
  if (env.SJS_LAB_REDIS_URL) cfg.redisUrl = env.SJS_LAB_REDIS_URL;
  else if (env.SJS_REDIS_URL) cfg.redisUrl = env.SJS_REDIS_URL;
  if (env.SJS_LAB_BIND_HOST) cfg.bindHost = env.SJS_LAB_BIND_HOST;
  if (env.SJS_LAB_LB_PUBLIC_URL) cfg.lbPublicUrl = env.SJS_LAB_LB_PUBLIC_URL.replace(/\/$/, '');
  if (!cfg.lbPublicUrl) cfg.lbPublicUrl = `http://${cfg.bindHost}:${cfg.lbPort}`;
  if (env.SJS_LAB_MAX_LOAD_CLIENTS) cfg.maxLoadClients = Number(env.SJS_LAB_MAX_LOAD_CLIENTS);
  cfg.redisPort = Number(new URL(cfg.redisUrl).port || cfg.redisPort);
  return cfg;
}

export function resolveInsideLab(p) {
  return isAbsolute(p) ? p : resolve(LAB_ROOT, p);
}
