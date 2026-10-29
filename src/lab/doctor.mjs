/**
 * Environment self-check (`npm run doctor`).
 *
 * The rule: anything that blocks the zero-license path is an error; everything else
 * is a warning that names the mode it affects. A user should be able to run
 * `doctor`, read the table and know exactly which of the three topologies they can
 * run on this machine right now.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { LAB_ROOT, LICENSE_FILE, loadLabConfig } from './paths.mjs';
import { probeTcp, getJson } from './ports.mjs';
import { findBundledRedis, pingRedis } from './redis.mjs';
import { resolveLicense } from '../server/config.mjs';

const require = createRequire(import.meta.url);

const REQUIRED_PACKAGES = ['socket.io', 'socket.io-client', 'redis', '@socket.io/redis-adapter'];
const OPTIONAL_PACKAGES = [
  'sqlite3',
  '@grapecity-software/spread-sheets',
  '@grapecity-software/js-collaboration',
  '@grapecity-software/js-collaboration-client',
];

export function resolvePackageEntry(pkg, relative = 'package.json') {
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`);
    return join(pkgJson.replace(/[\\/]package\.json$/, ''), relative);
  } catch {
    // Some packages hide package.json behind `exports`; fall back to a filesystem walk.
    const candidates = [LAB_ROOT, join(LAB_ROOT, '..')].map((base) =>
      join(base, 'node_modules', ...pkg.split('/'), relative),
    );
    return candidates.find((p) => existsSync(p)) ?? null;
  }
}

function packagePresent(pkg) {
  try {
    require.resolve(pkg);
    return true;
  } catch {
    return resolvePackageEntry(pkg) !== null;
  }
}

export function findBrowser() {
  if (process.env.SJS_BROWSER && existsSync(process.env.SJS_BROWSER)) return process.env.SJS_BROWSER;
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function dockerAvailable() {
  const probe = spawnSync('docker', ['info'], { stdio: 'ignore', windowsHide: true, timeout: 8000 });
  return probe.status === 0;
}

function readLicenseFile() {
  try {
    const license = resolveLicense();
    return { file: license.file, present: license.present, source: license.source, ...license.status };
  } catch (err) {
    return { file: process.env.SJS_LICENSE_FILE || LICENSE_FILE, present: false, error: err.message,
      runtime: false, designer: false, server: false };
  }
}

/**
 * Who owns an occupied port? Being able to tell "the lab is already running" apart
 * from "something else took my port" is the difference between a helpful doctor and
 * a confusing one: `npm run web` then `npm run doctor` is a perfectly normal order.
 */
async function identifyOwner(port) {
  const tryJson = async (path) => {
    try {
      const res = await getJson(`http://127.0.0.1:${port}${path}`, 700);
      return res.ok ? res.body : null;
    } catch {
      return null;
    }
  };
  const webHealth = await tryJson('/api/health');
  if (webHealth?.ok) return { kind: 'lab-web', detail: '本实验室的控制台正在运行' };
  const nodeHealth = await tryJson('/health');
  if (nodeHealth?.ok && nodeHealth.nodeId) {
    return { kind: 'lab-node', detail: `本实验室的协同节点 ${nodeHealth.nodeId} 正在运行` };
  }
  const lbHealth = await tryJson('/healthz');
  if (lbHealth === 'ok' || lbHealth?.ok === true) return { kind: 'lab-lb', detail: '本实验室的负载均衡正在运行' };
  return null;
}

/**
 * @returns {Promise<{blockers: string[], warnings: string[], rows: Array, environment: object}>}
 */
export async function runDoctor() {
  const config = loadLabConfig();
  const rows = [];
  const blockers = [];
  const warnings = [];

  const push = (section, name, status, detail, level = 'ok') => {
    rows.push({ section, name, status, detail, level });
    if (level === 'error') blockers.push(`${name}: ${detail}`);
    if (level === 'warn') warnings.push(`${name}: ${detail}`);
  };

  // ---- runtime -------------------------------------------------------------
  const major = Number(process.versions.node.split('.')[0]);
  push('运行环境', 'Node.js', major >= 20 ? 'OK' : '不满足', `v${process.versions.node}（需要 >= 20）`, major >= 20 ? 'ok' : 'error');
  push('运行环境', '平台', 'OK', `${process.platform} ${process.arch}`);
  push('运行环境', '工程目录', 'OK', LAB_ROOT);
  push(
    '运行环境',
    '依赖查找',
    'OK',
    '依赖可从工程目录或上一级 node_modules 解析（独立克隆时先 npm install）',
  );

  // ---- dependencies ---------------------------------------------------------
  for (const pkg of REQUIRED_PACKAGES) {
    const ok = packagePresent(pkg);
    push('依赖（必需）', pkg, ok ? 'OK' : '缺失', ok ? '已解析' : '未解析，先 npm install', ok ? 'ok' : 'error');
  }
  for (const pkg of OPTIONAL_PACKAGES) {
    const ok = packagePresent(pkg);
    const affects = pkg === 'sqlite3' ? '共享文档库/官方 OT 需要' : '官方实现（impl=real）需要';
    push('依赖（可选）', pkg, ok ? 'OK' : '缺失', ok ? '已解析' : `未解析：${affects}`, ok ? 'ok' : 'warn');
  }

  // ---- ports ---------------------------------------------------------------
  const ports = [
    ['负载均衡', config.lbPort],
    ['控制台', config.webPort],
    ...Array.from({ length: config.defaultNodes }, (_, i) => [`协同节点 #${i + 1}`, config.nodeBasePort + i]),
    ['Redis', config.redisPort],
  ];
  for (const [name, port] of ports) {
    const state = await probeTcp(port);
    const isRedis = name === 'Redis';
    if (state === 'free') {
      push('端口', `${name} :${port}`, '空闲', '可用');
      continue;
    }
    if (isRedis) {
      push('端口', `${name} :${port}`, '占用', '已被占用（lab 会复用这个 Redis）');
      continue;
    }
    const owner = await identifyOwner(port);
    if (owner) {
      push('端口', `${name} :${port}`, '运行中', `${owner.detail}（无需释放）`);
    } else {
      push(
        '端口',
        `${name} :${port}`,
        '被占用',
        '被其它进程占用，先释放它，或在 config/lab.config.json 里改端口',
        'error',
      );
    }
  }

  // ---- redis ---------------------------------------------------------------
  const redisUp = await pingRedis(config.redisUrl, 900);
  push('Redis（shared 模式）', '连通性', redisUp ? 'OK' : '未运行', redisUp ? config.redisUrl : '当前没有可用的 Redis', redisUp ? 'ok' : 'warn');
  const bundled = findBundledRedis();
  push('Redis（shared 模式）', '内置二进制', bundled ? 'OK' : '无', bundled ?? '未找到 tools/redis/redis-server', 'ok');
  const docker = dockerAvailable();
  push('Redis（shared 模式）', 'Docker', docker ? 'OK' : '不可用', docker ? '可用来自动启动 redis:7-alpine' : '未安装或未启动', 'ok');
  if (!redisUp && !bundled && !docker) {
    warnings.push('shared 模式暂时无法启动：没有 Redis、内置二进制或 Docker。single/sharded 仍然可用。');
  }

  // ---- browser -------------------------------------------------------------
  const browser = findBrowser();
  push(
    '浏览器（官方实现/浏览器体检）',
    'Chrome/Edge',
    browser ? 'OK' : '未找到',
    browser ?? '未找到，可用 SJS_BROWSER 指定可执行文件路径',
    browser ? 'ok' : 'warn',
  );

  // ---- license -------------------------------------------------------------
  const license = readLicenseFile();
  push(
    '授权',
    '授权文件',
    license.present ? '存在' : '不存在',
    `${license.file}（仅表示已配置，授权有效性由 SDK 验证）`,
    license.present ? 'ok' : 'ok',
  );
  push('授权', 'runtime key', license.runtime ? 'SET' : 'MISSING', '浏览器端 SpreadJS；127.0.0.1/localhost 免授权', 'ok');
  push('授权', 'designer key', license.designer ? 'SET' : 'MISSING', '仅 Designer 页面需要', 'ok');
  push('授权', 'server key', license.server ? 'SET' : 'MISSING', '官方协同服务端需要（机器码绑定）；mirror 模式不需要', 'ok');

  // The machine id is what a SERVER license must be activated against. It is a
  // read-only getter from the official package; only available when that optional
  // dependency is installed, so a mirror-only checkout still passes doctor.
  let machineId = null;
  let machineIdError = null;
  try {
    const collab = await import('@grapecity-software/js-collaboration');
    machineId = typeof collab.getMachineIdForServerLicense === 'function' ? collab.getMachineIdForServerLicense() : null;
  } catch (err) {
    machineIdError = err.message;
  }
  push(
    '授权',
    '机器码',
    machineId ? 'OK' : '不可用',
    machineId ??
      `需要安装 @grapecity-software/js-collaboration 才能读取（${machineIdError ?? '未导出 getMachineIdForServerLicense'}）` +
        '；申请 server 授权时把机器码发给 GrapeCity',
    'ok',
  );

  if (!license.server) {
    warnings.push('impl=real（官方实现）不可用：缺少 server.serverLicenseKey。mirror 模式可完整验证架构差异。');
  }
  if (license.error) push('授权', '授权文件解析', '失败', license.error, 'error');

  const environment = {
    nodeVersion: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    redis: {
      available: redisUp || Boolean(bundled) || docker,
      running: redisUp,
      url: config.redisUrl,
      bundled,
      docker,
      mode: redisUp ? 'running' : bundled ? 'bundled' : docker ? 'docker' : 'none',
    },
    browser: { found: Boolean(browser), path: browser },
    license,
    machineId,
    ports: { lb: config.lbPort, web: config.webPort, nodeBase: config.nodeBasePort, redis: config.redisPort },
  };
  return { blockers, warnings, rows, environment };
}

/** CJK-aware display width so the doctor table lines up. */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    width += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf)) ? 2 : 1;
  }
  return width;
}

/** Render the doctor rows as an aligned terminal table. */
export function renderDoctor(result) {
  const lines = [];
  let section = null;
  const nameWidth = Math.max(...result.rows.map((r) => displayWidth(r.name)), 10);
  const statusWidth = Math.max(...result.rows.map((r) => displayWidth(r.status)), 6);
  for (const row of result.rows) {
    if (row.section !== section) {
      section = row.section;
      lines.push('');
      lines.push(`  ${section}`);
    }
    const marker = row.level === 'error' ? '[ 失败 ]' : row.level === 'warn' ? '[ 注意 ]' : '[  ok  ]';
    const namePad = ' '.repeat(Math.max(0, nameWidth - displayWidth(row.name)));
    const statusPad = ' '.repeat(Math.max(0, statusWidth - displayWidth(row.status)));
    lines.push(`  ${marker} ${row.name}${namePad}  ${row.status}${statusPad}  ${row.detail}`);
  }
  return lines.join('\n');
}
