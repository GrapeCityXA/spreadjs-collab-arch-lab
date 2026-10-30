#!/usr/bin/env node
/**
 * Optional verification of the OFFICIAL implementation (`impl=real`).
 *
 * Why a separate script: the official collaboration server validates a
 * machine-bound server license and the official client only runs in a real browser,
 * so this path cannot be part of the zero-license `self-test`. What this script
 * checks is the part the mirror engine cannot: that the lab can drive
 * `@grapecity-software/js-collaboration` + its OT stack, and that two browser pages
 * editing the same SpreadJS workbook through it stay in sync. The optional page
 * does not enable client presence; this script does not verify presence or capacity.
 *
 * Requirements:
 *   - `server.serverLicenseKey` configured (config/license.json or SJS_LICENSE_FILE)
 *   - Chrome/Edge (headless is fine; or set SJS_BROWSER)
 *   - `npm run build:official` to have produced public/official/bundle.js
 *
 * Usage:
 *   npm run test:official                   # 1 node, official OT sync
 *   npm run test:official -- --mode=shared   # 3 nodes + Redis + shared OT store
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LAB_ROOT, LOG_DIR, loadLabConfig } from '../src/lab/paths.mjs';
import { readState } from '../src/lab/state.mjs';
import { up, down } from '../src/lab/orchestrator.mjs';
import { getJson } from '../src/lab/ports.mjs';
import { findBrowser } from '../src/lab/doctor.mjs';
import { resolveLicense } from '../src/server/config.mjs';

const BASE_PORT = 9556;
const READY_TIMEOUT_MS = 60_000;
const SYNC_TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'single';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { assertions: [], mode, scope: 'official-ot-functional-sync', presenceTested: false, startedAt: new Date().toISOString() };

function assert(name, ok, detail) {
  results.assertions.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${detail}` : ''}\n`);
  return Boolean(ok);
}

function fatal(message, code = 2) {
  process.stdout.write(`\n  ${message}\n`);
  process.exitCode = code;
}

/** Same minimal CDP client the zero-license browser probes use. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    const client = new Cdp(ws);
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && client.pending.has(message.id)) {
        const { resolve: resolvePromise, reject } = client.pending.get(message.id);
        client.pending.delete(message.id);
        message.error ? reject(new Error(message.error.message)) : resolvePromise(message.result);
      }
    });
    await new Promise((resolvePromise, reject) => {
      ws.addEventListener('open', resolvePromise, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
    return client;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }
      }, 25_000);
    });
  }
  async evaluate(expression) {
    const reply = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return reply?.result?.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* gone */
    }
  }
}

async function waitForReady(cdp) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await cdp.evaluate('window.__labReady === true').catch(() => false);
    if (ready === true) return true;
    await sleep(500);
  }
  return false;
}

async function waitForCell(cdp, row, col, expected) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`window.__labGetCell(${row}, ${col})`).catch(() => null);
    if (last === expected) return last;
    await sleep(300);
  }
  return last;
}

function advancedAndConverged(versions, before) {
  return versions.length === before.length && versions.length > 0 &&
    versions.every((version, index) => Number.isSafeInteger(version) && version > before[index] && version === versions[0]);
}

async function waitForVersions(clients, before) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let versions = [];
  while (Date.now() < deadline) {
    // Read the documented SharedDoc getter, rather than the page hook that starts
    // at zero and is refreshed by a separate 500ms UI timer.
    versions = await Promise.all(clients.map(({ cdp }) => cdp.evaluate('window.__doc?.version ?? null').catch(() => null)));
    if (advancedAndConverged(versions, before)) return versions;
    await sleep(300);
  }
  return versions;
}

async function main() {
  process.stdout.write('\n=== 官方实现（impl=real）端到端验证 ===\n');
  process.stdout.write('  范围：官方 OT 双端功能同步；不验证客户端 presence、容量或高可用。\n');
  const config = loadLabConfig();

  let license;
  try {
    license = resolveLicense();
  } catch (err) {
    fatal(err.message);
    return;
  }
  if (!license.status.server) {
    fatal('未配置 server 授权，本次未执行官方验证。请填写 config/license.json 或设置 SJS_SERVER_LICENSE_KEY。');
    return;
  }
  process.stdout.write('  授权配置来源: ' + license.source + '（仅确认已配置，有效性由 SDK 验证）\n');

  const bundle = resolve(LAB_ROOT, 'public/official/bundle.js');
  if (!existsSync(bundle)) {
    fatal('public/official/bundle.js 不存在：先运行 npm run build:official（需要 webpack 与官方协同客户端依赖）。');
    return;
  }

  const browser = findBrowser();
  if (!browser) {
    fatal('没有找到 Chrome/Edge。用 SJS_BROWSER 指定可执行文件，或安装 Chrome。');
    return;
  }

  if (readState()) {
    process.stdout.write('  检测到已运行的 stack，先停止它。\n');
    await down({ log: { info: () => {}, warn: () => {} } });
  }

  const overrides = { impl: 'real' };
  let state;
  try {
    state = await up({ mode, overrides, withWeb: true, log: { info: (m) => process.stdout.write(`  ${m}\n`), warn: () => {} } });
  } catch (err) {
    fatal(`官方实现启动失败：${err.message}`, 1);
    return;
  }

  const clients = [];
  let chrome = null;
  const userDataDir = mkdtempSync(join(tmpdir(), 'sjs-lab-official-'));
  try {
    // ---- server-side facts first: the official server really is in play ----------
    const healthRows = [];
    for (const node of state.nodes) {
      const res = await getJson(`http://127.0.0.1:${node.port}/health`).catch(() => null);
      healthRows.push({ port: node.port, health: res?.body ?? null });
    }
    assert('节点全部健康', healthRows.every((row) => row.health?.ok === true), healthRows.map((r) => `:${r.port}=${r.health?.ok}`).join(' '));
    assert(
      '运行的是官方实现（impl=real）',
      healthRows.every((row) => row.health?.impl === 'real'),
      healthRows.map((r) => `:${r.port}=${r.health?.impl}`).join(' '),
    );
    assert('官方 OT 已启用', healthRows.every((row) => row.health?.otEnabled === true), JSON.stringify(healthRows[0]?.health ?? {}));

    const webPort = state.web?.port ?? config.webPort;
    const endpoint = state.lb ? `http://127.0.0.1:${state.lb.port}` : `http://127.0.0.1:${state.nodes[0].port}`;
    const room = `official-${Date.now().toString(36)}`;
    process.stdout.write(`  协同端点: ${endpoint}${config.wsPath}  房间: ${room}\n`);

    // ---- two real browsers ------------------------------------------------------
    chrome = spawn(
      browser,
      [
        '--headless=new',
        `--remote-debugging-port=${BASE_PORT}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-breakpad',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    let version = null;
    for (let i = 0; i < 60; i++) {
      try {
        version = await (await fetch(`http://127.0.0.1:${BASE_PORT}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!version) {
      fatal('Chrome DevTools 没有起来（端口被占用？）', 1);
      return;
    }

    for (const label of ['alice', 'bob']) {
      const target = await (
        await fetch(`http://127.0.0.1:${BASE_PORT}/json/new?about:blank`, { method: 'PUT' })
      ).json();
      const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      const url = `http://127.0.0.1:${webPort}/official/?room=${encodeURIComponent(room)}&label=${label}`;
      await cdp.send('Page.navigate', { url });
      clients.push({ label, cdp, url });
      if (label === 'alice') await sleep(1500);
    }

    const readiness = {};
    for (const client of clients) {
      readiness[client.label] = await waitForReady(client.cdp);
      const nodeId = await client.cdp.evaluate('window.__labNodeId ?? null').catch(() => null);
      client.nodeId = nodeId;
      process.stdout.write(`  ${client.label}: ready=${readiness[client.label]} node=${nodeId ?? '?'} ${client.url}\n`);
    }
    const bothReady = assert('两个官方客户端页面都就绪', readiness.alice && readiness.bob, JSON.stringify(readiness));
    if (!bothReady) {
      const text = await clients[0].cdp.evaluate('document.body.innerText.slice(0, 400)').catch(() => '');
      process.stdout.write(`  页面内容: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}\n`);
      throw new Error('客户端页面没有就绪');
    }

    // The optional official page intentionally leaves __labMembers empty because
    // it does not enable client presence. Check its actual OT document instead.
    const docStates = await Promise.all(clients.map(({ cdp }) => cdp.evaluate(`(() => {
      const doc = window.__doc;
      return { id: doc?.id ?? null, type: doc?.type?.uri ?? null, version: doc?.version ?? null };
    })()`).catch(() => null)));
    const docsReady = assert('两个客户端已绑定同一官方 OT 文档', docStates.every((doc) =>
      doc?.id === room && typeof doc.type === 'string' && doc.type.length > 0 &&
      doc.type === docStates[0]?.type && Number.isSafeInteger(doc.version) && doc.version >= 0), JSON.stringify(docStates));
    if (!docsReady) throw new Error('客户端 OT 文档状态无效');
    const beforeVersions = docStates.map((doc) => doc.version);

    // ---- real OT sync both directions ------------------------------------------
    const fromAlice = `official-alice-${Date.now()}`;
    await clients[0].cdp.evaluate(`window.__labSetCell(2, 2, ${JSON.stringify(fromAlice)})`);
    const readByBob = await waitForCell(clients[1].cdp, 2, 2, fromAlice);
    assert('alice 的编辑经官方 OT 同步到 bob', readByBob === fromAlice, `bob 读到 "${readByBob}"`);

    const fromBob = `official-bob-${Date.now()}`;
    await clients[1].cdp.evaluate(`window.__labSetCell(3, 3, ${JSON.stringify(fromBob)})`);
    const readByAlice = await waitForCell(clients[0].cdp, 3, 3, fromBob);
    assert('bob 的编辑经官方 OT 同步到 alice', readByAlice === fromBob, `alice 读到 "${readByAlice}"`);

    const versions = await waitForVersions(clients, beforeVersions);
    assert('双向编辑后两端 OT 版本推进并收敛', advancedAndConverged(versions, beforeVersions),
      `before=${JSON.stringify(beforeVersions)} after=${JSON.stringify(versions)}`);
  } catch (err) {
    results.error = err.message;
    process.stdout.write(`\n  ERROR: ${err.message}\n`);
  } finally {
    for (const client of clients) client.cdp.close();
    if (chrome) {
      try {
        chrome.kill();
      } catch {
        /* gone */
      }
    }
    await sleep(500);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await down({ log: { info: () => {}, warn: () => {} } });
  }

  const passed = results.assertions.filter((a) => a.ok).length;
  const total = results.assertions.length;
  process.stdout.write(`\n  === ${passed}/${total} 通过 ===\n`);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(resolve(LOG_DIR, 'official-ot-sync.json'), `${JSON.stringify({ ...results, passed, total }, null, 2)}\n`, 'utf8');
    process.stdout.write(`  结果已写入 logs/official-ot-sync.json\n`);
  } catch {
    /* ignore */
  }
  process.exitCode = !results.error && passed === total ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`[official] ${err.message}\n`);
  process.exitCode = 1;
});
