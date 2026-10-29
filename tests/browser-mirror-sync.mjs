#!/usr/bin/env node
/**
 * Browser smoke test for the zero-license pages: two real browsers, one shared
 * workbook, plus the console page.
 *
 * This is the test that proves the thing a user actually touches works: the
 * `/client/` SpreadJS page synchronises through the mirror protocol, and the console
 * renders the three modes against the live API. It starts its own stack (3 nodes +
 * Redis adapter + shared store) and shuts it down afterwards, so it is safe to run
 * with an empty machine — but not while another stack is running.
 *
 * Usage: npm run test:ui
 *        npm run test:ui -- --mode=sharded
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LAB_ROOT, LOG_DIR } from '../src/lab/paths.mjs';
import { readState } from '../src/lab/state.mjs';
import { up, down } from '../src/lab/orchestrator.mjs';
import { pingRedis } from '../src/lab/redis.mjs';
import { loadLabConfig } from '../src/lab/paths.mjs';
import { findBrowser } from '../src/lab/doctor.mjs';
import { sleep } from '../src/lab/ports.mjs';

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'shared';
const DEBUG_PORT = Number(args.find((a) => a.startsWith('--debug-port='))?.split('=')[1] ?? 9560);
const READY_TIMEOUT_MS = 60_000;
const SYNC_TIMEOUT_MS = 15_000;

const results = { assertions: [], mode, startedAt: new Date().toISOString() };

function assert(name, ok, detail) {
  results.assertions.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${detail}` : ''}\n`);
  return Boolean(ok);
}

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
    if (reply?.exceptionDetails) throw new Error(reply.exceptionDetails.text ?? '页面脚本异常');
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

async function waitFor(cdp, expression, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await cdp.evaluate(expression).catch(() => undefined);
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function openTarget(pageUrl) {
  const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: pageUrl });
  return cdp;
}

async function main() {
  process.stdout.write('\n=== 浏览器端：两个真实客户端 + 控制台 ===\n');
  const browser = findBrowser();
  if (!browser) {
    process.stdout.write('  没有找到 Chrome/Edge：用 SJS_BROWSER 指定可执行文件。\n');
    process.exitCode = 2;
    return;
  }
  const config = loadLabConfig();
  if (!(await pingRedis(config.redisUrl, 1000)) && mode === 'shared') {
    process.stdout.write('  shared 模式需要 Redis，本机不可用。先启动 Redis，或用 --mode=sharded。\n');
    process.exitCode = 2;
    return;
  }
  if (readState()) {
    process.stdout.write('  已有 stack 在运行，先 npm run down 再运行本测试。\n');
    process.exitCode = 2;
    return;
  }

  let state = null;
  const clients = [];
  let chrome = null;
  const userDataDir = mkdtempSync(join(tmpdir(), 'sjs-lab-ui-'));
  try {
    state = await up({ mode, withWeb: true, log: { info: (m) => process.stdout.write(`  ${m}\n`), warn: () => {} } });
    const webPort = state.web?.port ?? config.webPort;
    const room = `ui-${Date.now().toString(36)}`;
    process.stdout.write(`  房间: ${room}  控制台: http://127.0.0.1:${webPort}/\n`);

    chrome = spawn(
      browser,
      [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
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
    let devtoolsUp = false;
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
        devtoolsUp = true;
        break;
      } catch {
        await sleep(250);
      }
    }
    if (!devtoolsUp) throw new Error('Chrome DevTools 没有起来');

    // ---- two mirror clients ----------------------------------------------------
    for (const label of ['alice', 'bob']) {
      const cdp = await openTarget(`http://127.0.0.1:${webPort}/client/?room=${room}&label=${label}`);
      clients.push({ label, cdp });
      if (label === 'alice') await sleep(1200);
    }
    const readiness = {};
    for (const client of clients) {
      readiness[client.label] = Boolean(await waitFor(client.cdp, 'window.__labReady === true', READY_TIMEOUT_MS));
      client.nodeId = await client.cdp.evaluate('window.__labNodeId ?? null').catch(() => null);
      client.nodePort = await client.cdp.evaluate('window.__labNodePort ?? null').catch(() => null);
      process.stdout.write(`  ${client.label}: ready=${readiness[client.label]} node=${client.nodeId} :${client.nodePort}\n`);
    }
    const bothReady = assert('两个 /client/ 页面都就绪', readiness.alice && readiness.bob, JSON.stringify(readiness));
    if (!bothReady) throw new Error('客户端页面没有就绪');

    assert('页面报告了服务自己的节点身份', clients.every((c) => typeof c.nodeId === 'string' && c.nodeId.length > 0), clients.map((c) => `${c.label}=${c.nodeId}`).join(' '));
    if (mode === 'shared' && state.nodes.length > 1) {
      assert(
        '共享模式下两个客户端可以落在不同节点（由适配器+共享库兜住）',
        clients[0].nodeId !== clients[1].nodeId,
        clients.map((c) => `${c.label}@${c.nodeId}`).join(' '),
      );
    }

    // ---- sync both directions --------------------------------------------------
    const fromAlice = `alice-${Date.now()}`;
    await clients[0].cdp.evaluate(`window.__labSetCell(5, 5, ${JSON.stringify(fromAlice)})`);
    const bobSees = await waitFor(clients[1].cdp, `window.__labGetCell(5, 5) === ${JSON.stringify(fromAlice)}`, SYNC_TIMEOUT_MS);
    assert('alice 的编辑出现在 bob 的表格里', Boolean(bobSees), `bob 读到 ${JSON.stringify(await clients[1].cdp.evaluate('window.__labGetCell(5, 5)'))}`);

    const fromBob = `bob-${Date.now()}`;
    await clients[1].cdp.evaluate(`window.__labSetCell(6, 6, ${JSON.stringify(fromBob)})`);
    const aliceSees = await waitFor(clients[0].cdp, `window.__labGetCell(6, 6) === ${JSON.stringify(fromBob)}`, SYNC_TIMEOUT_MS);
    assert('bob 的编辑出现在 alice 的表格里', Boolean(aliceSees), `alice 读到 ${JSON.stringify(await clients[0].cdp.evaluate('window.__labGetCell(6, 6)'))}`);

    const versions = await Promise.all(clients.map((c) => c.cdp.evaluate('window.__labVersion ?? null')));
    assert('客户端拿到文档版本号', versions.every((v) => typeof v === 'number' && v > 0), `versions=${versions.join(',')}`);
    const membership = await Promise.all(clients.map((c) => waitFor(c.cdp,
      'Array.isArray(window.__labMembers) && ["alice", "bob"].every(label => window.__labMembers.some(member => member.label === label))',
      SYNC_TIMEOUT_MS)));
    assert('两个页面都能看到 alice 和 bob 的成员信息', membership.every(Boolean), JSON.stringify(membership));

    await clients[1].cdp.send('Page.navigate', { url: 'about:blank' });
    const removed = await waitFor(clients[0].cdp,
      'window.__labMembers?.length === 1 && window.__labMembers[0].label === "alice"', SYNC_TIMEOUT_MS);
    assert('bob 离开后 alice 的成员列表更新', Boolean(removed));

    // ---- console page ----------------------------------------------------------
    const consoleCdp = await openTarget(`http://127.0.0.1:${webPort}/`);
    await waitFor(consoleCdp, 'document.readyState === "complete"', 30_000);
    const cards = await waitFor(consoleCdp, 'document.querySelectorAll("#modeCards > *").length', 20_000);
    assert('控制台渲染出 3 张模式卡片', Number(cards) === 3, `cards=${cards}`);
    const consoleReady = await waitFor(consoleCdp, 'Boolean(window.__labConsole)', 20_000);
    assert('控制台拿到了 API 数据', Boolean(consoleReady));
    const stackText = await consoleCdp.evaluate('(document.getElementById("stackStatus")?.textContent ?? "").trim()');
    assert('控制台显示当前 stack 状态', /运行|shared|健康/i.test(stackText), `stackStatus="${stackText}"`);
    assert('控制台说明 mirror 的验证范围', await consoleCdp.evaluate('document.body.textContent.includes("不能证明官方 OT 行为或 SpreadJS 容量")'));
    const invalid = await consoleCdp.evaluate(`(() => {
      const input = document.getElementById('scenarioInterval');
      input.value = '0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      let requests = 0;
      const originalFetch = window.fetch;
      window.fetch = function(url, options) {
        if (url === '/api/check' || url === '/api/bench') requests++;
        return originalFetch.apply(this, arguments);
      };
      window.__labConsole.runCheck();
      window.__labConsole.runBench();
      window.fetch = originalFetch;
      return input.value === '0' && requests === 0 && !window.__labConsole.state.busy &&
        document.getElementById('scenarioDerived').textContent.includes('编辑间隔');
    })()`);
    assert('错误场景保留原输入、不发请求且不锁住按钮', invalid);
    await consoleCdp.evaluate(`window.__labConsole.setScenario({ users: 4, opIntervalMs: 500, durationMs: 1000, rooms: 1 }); window.__labConsole.runBench(); true`);
    const completed = await waitFor(consoleCdp, 'window.__labConsole.state.bench.status === "done"', 30_000);
    assert('修正输入后可完成负载并显示未判定性能达标', Boolean(completed) && await consoleCdp.evaluate(
      'window.__labConsole.state.bench.stats?.outcome?.writesPassed === true && document.getElementById("benchBody").textContent.includes("性能是否满足需求")'));
    consoleCdp.close();
  } catch (err) {
    results.error = err.message;
    process.stdout.write(`\n  ERROR: ${err.message}\n`);
    if (/CDP 超时|CDP 连接失败|DevTools 没有起来|页面脚本异常/.test(err.message)) {
      process.stdout.write(
        '  提示：浏览器能被启动但 DevTools 不响应，通常是被沙箱/权限策略拦住了（例如 Windows 上 crashpad 或 mojo 通道被拒绝）。\n' +
          '        这不是页面代码的问题；请在普通桌面环境重跑，或用 SJS_BROWSER 指定另一个 Chrome/Edge。\n',
      );
      results.environmentBlocked = true;
    }
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
    writeFileSync(resolve(LOG_DIR, 'browser-mirror-sync.json'), `${JSON.stringify({ ...results, passed, total }, null, 2)}\n`, 'utf8');
  } catch {
    /* ignore */
  }
  process.exitCode = results.environmentBlocked ? 2 : !results.error && passed === total ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`[test:ui] ${err.message}\n`);
  process.exitCode = 1;
});
