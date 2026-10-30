/**
 * Distributed smoke test — two agents on ONE machine, simulating two extra hosts.
 *
 * This test runs locally: a real multi-machine run needs separate hosts, but
 * the mechanism (agent process + LB admin registration + distributed load) is exactly
 * the same, so a green run proves the wiring, not the network.
 *
 * Covers the whole multi-machine path:
 *   1. start 2 agents (listen only; no node yet)
 *   2. `up --mode=sharded --nodes=1 --agents=...` attaches them, nodes start
 *   3. `check` runs the scenario sample against 3 nodes
 *   4. `bench --distribute` splits users across local + 2 agents
 *   5. `down --stop-agents` detaches and shuts the agents down
 *
 * Exits 0 on success, 1 on a failed assertion, 2 when the ports are already in use
 * (skipped rather than reported as a false failure).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_SCRIPT = resolve(ROOT, 'src/remote/agent.mjs');

// Ports are overridable so this test can run next to a colleague's stack (or a
// second copy of itself) without lying about the result:
//   SJS_TEST_LB_PORT=3020 SJS_TEST_NODE_BASE=8482 SJS_TEST_AGENT_PORTS=9200,9201 \
//   SJS_TEST_AGENT_NODE_PORTS=8582,8583 node tests/distributed-smoke.mjs
const LB_PORT = Number(process.env.SJS_TEST_LB_PORT ?? 3010);
const NODE_BASE = Number(process.env.SJS_TEST_NODE_BASE ?? 8282); // one controller-local node
const AGENT_PORTS = (process.env.SJS_TEST_AGENT_PORTS ?? '9100,9101').split(',').map(Number);
const AGENT_NODE_PORTS = (process.env.SJS_TEST_AGENT_NODE_PORTS ?? '8382,8383').split(',').map(Number);
const TOKEN = `t0p-${Date.now().toString(36)}`;

process.env.SJS_LAB_LB_PORT = String(LB_PORT);
process.env.SJS_LAB_NODE_BASE_PORT = String(NODE_BASE);
process.env.SJS_LAB_BIND_HOST = '127.0.0.1';
process.env.SJS_LAB_LB_PUBLIC_URL = `http://127.0.0.1:${LB_PORT}`;
process.env.SJS_LAB_AGENT_TOKEN = TOKEN;

const failures = [];
const checks = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  const mark = ok ? '✓' : '✗';
  process.stdout.write(`${mark} ${name}${detail ? `  ${detail}` : ''}\n`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function httpJson(url, { timeoutMs = 2000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function portBusy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) });
    await res.text().catch(() => '');
    return true;
  } catch {
    return false;
  }
}

function startAgent(index) {
  const port = AGENT_PORTS[index];
  const nodePort = AGENT_NODE_PORTS[index];
  const child = spawn(
    process.execPath,
    [
      AGENT_SCRIPT,
      `--port=${port}`,
      `--lb=http://127.0.0.1:${LB_PORT}`,
      `--token=${TOKEN}`,
      '--public-host=127.0.0.1',
      `--node-port=${nodePort}`,
    ],
    { cwd: ROOT, env: process.env, stdio: ['ignore', 'ignore', 'ignore'] },
  );
  child.agentPort = port;
  child.nodePort = nodePort;
  return child;
}

async function waitFor(url, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await httpJson(url);
    last = res;
    if (res.ok) return res.body;
    await sleep(150);
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内没有就绪（最后：${JSON.stringify(last)}）`);
}

async function main() {
  for (const port of [LB_PORT, NODE_BASE, ...AGENT_PORTS, ...AGENT_NODE_PORTS]) {
    if (await portBusy(port)) {
      process.stdout.write(`SKIP 端口 :${port} 已被占用，分布式测试跳过（不要与正在运行的 stack 同时跑）\n`);
      return 2;
    }
  }

  // Env is set above, so dynamic imports see the relocated ports.
  const { up, down, status } = await import('../src/lab/orchestrator.mjs');
  const { runCheck, exitCodeFor } = await import('../src/checks/runner.mjs');
  const { runBench } = await import('../src/bench/bench.mjs');
  const { killTree } = await import('../src/lab/proc.mjs');
  const { getJson } = await import('../src/lab/ports.mjs');
  const { readState } = await import('../src/lab/state.mjs');
  const agentCtl = await import('../src/remote/controller.mjs');

  const existing = readState();
  if (existing) {
    process.stdout.write(
      `SKIP 已有 lab stack 在运行（${existing.config?.mode ?? '?'}）。本测试会自己 up()，` +
        '请先 `npm run down`（否则两条链路会抢同一份 .lab/state.json）。\n',
    );
    return 2;
  }

  const agents = [];
  let stackUp = false;
  try {
    // ---------------------------------------------------------------- 1. agents
    for (let i = 0; i < 2; i++) {
      agents.push(startAgent(i));
      const health = await waitFor(`http://127.0.0.1:${AGENT_PORTS[i]}/health`, `agent ${AGENT_PORTS[i]}`);
      check(`agent ${AGENT_PORTS[i]} 监听`, health?.role === 'agent');
    }
    for (const agentPort of AGENT_PORTS) {
      const res = await httpJson(`http://127.0.0.1:${agentPort}/agent/status`, {
        headers: { 'x-lab-token': TOKEN },
      });
      // The agent starts its node at LAUNCH (a collision is a launch error); attach only
      // registers it. Encoding that here keeps the docs and the code honest.
      check(
        `agent ${agentPort} 启动即起 node（未 attach）`,
        res.ok && Boolean(res.body?.node) && res.body?.attached === null,
        `node=${res.body?.node?.nodeId ?? 'null'} attached=${JSON.stringify(res.body?.attached)}`,
      );
    }
    check('未授权请求被拒绝', (await httpJson(`http://127.0.0.1:${AGENT_PORTS[0]}/agent/status`)).status === 401);

    // ------------------------------------------------------------------ 2. up
    const state = await up({
      mode: 'sharded',
      overrides: { nodes: 1 },
      withWeb: false,
      agents: AGENT_PORTS.map((port) => `http://127.0.0.1:${port}`),
      agentToken: TOKEN,
      log: { info: () => {}, warn: (msg) => process.stdout.write(`! ${msg}\n`) },
    });
    stackUp = true;
    check('state.nodes = 1 本机 + 2 远端', state.nodes.filter((n) => !n.remote).length === 1 && state.nodes.filter((n) => n.remote).length === 2);
    check('state.remote 记录了 agent 地址', (state.remote ?? []).length === 2);
    check('一个本机节点加两个 agent 仍然保留 LB', Boolean(state.lb), `strategy=${state.lb?.strategy}`);
    const lbState = await getJson(`http://127.0.0.1:${LB_PORT}/__lb/state`);
    check('LB /__lb/state upstreams = 3', lbState.ok && (lbState.body?.upstreams ?? []).length === 3, JSON.stringify((lbState.body?.upstreams ?? []).map((u) => u.url)));
    for (const agentPort of AGENT_PORTS) {
      const res = await httpJson(`http://127.0.0.1:${agentPort}/agent/status`, { headers: { 'x-lab-token': TOKEN } });
      check(`agent ${agentPort} 已启动 node`, Boolean(res.body?.node), res.body?.node?.url ?? '');
    }
    const live = await status();
    check('status 报告 3 个节点', live.nodes.length === 3, live.nodes.map((n) => n.id).join(','));
    check('status 报告 2 个远端 agent', (live.remote ?? []).length === 2);

    // --------------------------------------------------------------- 3. check
    const { result } = await runCheck({
      scenario: { users: 6, interval: 1, duration: 3, rooms: 1 },
      outputDir: resolve(ROOT, 'reports'),
    });
    check('体检产出 12 项', result.checks.length === 12, result.checks.map((c) => c.id).join(','));
    const loadCheck = result.checks.find((c) => c.id === 'load.scenario');
    check('load.scenario 为 record（记录，不是承诺）', loadCheck?.status === 'record');
    check('load.scenario 真的发了编辑', (loadCheck?.metrics?.ops ?? 0) > 0, `ops=${loadCheck?.metrics?.ops}`);
    check('报告带上了场景', result.scenario?.users === 6 && result.scenario?.opIntervalMs === 1000, JSON.stringify(result.scenario?.describe));
    check(
      'sharded 仍然是 healthy（多机不改变承诺）',
      result.summary.status === 'healthy',
      `${result.summary.status} ${result.summary.headline}`,
    );
    check('check 退出码 0', exitCodeFor(result) === 0);

    // --------------------------------------------------------------- 4. bench
    const bench = await runBench({
      scenario: { users: 8, interval: 0.5, duration: 3, rooms: 1 },
      distribute: true,
      log: { info: () => {} },
    });
    check('分布式压测有 3 个参与者', bench.participants.length === 3, bench.participants.map((p) => p.label).join(' + '));
    check('参与者合计用户数 = 8', bench.participants.reduce((sum, p) => sum + p.users, 0) === 8);
    check('所有参与者都发过编辑', bench.participants.every((p) => p.ops > 0), bench.participants.map((p) => `${p.label}:${p.ops}`).join(' '));
    check('合并吞吐 > 0', bench.opsPerSecond > 0, `${bench.opsPerSecond} op/s，扇出 ${bench.fanoutPerSecond}/s`);
    check('单房合并成员数保持 8', JSON.stringify(bench.membersPerRoom) === '[8]', JSON.stringify(bench.membersPerRoom));
    check('单房扇出使用全局 7 个接收者', bench.fanoutPerSecond === Math.round(bench.ops.ok * 7 * 1000 / bench.writingMs));
    check('吞吐分母仅为写入窗口', bench.opsPerSecond === Number((bench.ops.ok * 1000 / bench.writingMs).toFixed(2)));
    check('报告分别记录连接和写入时间', bench.connectionMs >= 0 && bench.writingMs > 0 && bench.elapsedMs >= bench.writingMs);
    check('分布式报告明确两道屏障口径', bench.coordination?.allReadyBeforeWriting === true && bench.coordination?.allCompletedBeforeClosing === true && bench.timingBasis === 'coordinated-longest-participant-writing-window');
    check('合并 ACK 有样本', (bench.ackMs?.samples ?? 0) > 0, `p95=${bench.ackMs?.p95}ms`);
    check('压测报告落盘', Boolean(bench.file) && existsSync(bench.file));
    const saved = JSON.parse(readFileSync(bench.file, 'utf8'));
    check('报告记录 distribute 与场景', saved.scenario?.users === 8 && Boolean(saved.distributed));

    // The old per-generator room mapping turned this into four 3-person rooms.
    // Exercise the actual local + agent socket path, including HTTP option forwarding.
    const paired = await runBench({ scenario: { users: 12, interval: 0.5, duration: 3, rooms: 6 },
      distribute: true, log: { info: () => {} } });
    check('12/6/3 实测仍为六个双人房', JSON.stringify(paired.membersPerRoom) === '[2,2,2,2,2,2]', JSON.stringify(paired.membersPerRoom));
    check('各参与者保留全局房间编号与空槽', paired.participants.every((p) => p.membersPerRoom.length === 6 && p.membersPerRoom.filter((n) => n === 2).length === 2));
    check('参与者全局用户偏移为 0/4/8', paired.participants.map((p) => p.userOffset).join(',') === '0,4,8');
    check('双人房每次成功写入只推算一个接收者', paired.fanoutOps === paired.ops.ok);
    check('双人房确实观察到广播', paired.broadcastReceived > 0, `received=${paired.broadcastReceived}`);
    check('广播接收覆盖ready到release独立窗口', paired.participants.every((p) => p.receiveWindowMs >= p.writingMs && p.broadcastReceiveBasis === 'ready-through-all-completed-release'));
    check('发送目标达成率来自实际尝试数', Math.abs(paired.targetRateAchievement - paired.opsSent * 1000 / paired.writingMs / 24) < 1e-10);

    const sparse = await runBench({ scenario: { users: 2, interval: 0.5, duration: 1, rooms: 2 },
      distribute: true, log: { info: () => {} } });
    check('零用户分片不会额外连接一个用户', sparse.participants.map((p) => p.users).join(',') === '1,1,0');
    check('空分片保留两间房的全局分布', JSON.stringify(sparse.membersPerRoom) === '[1,1]' && sparse.participants[2].skipped === true);
    check('两间单人房没有接收者扇出', sparse.fanoutPerSecond === 0);
  } finally {
    // ------------------------------------------------------------ 5. shutdown
    if (stackUp) {
      const stopped = await down({
        stopAgents: true,
        log: { info: () => {}, warn: (msg) => process.stdout.write(`! ${msg}\n`) },
      });
      check('down 摘除并关闭 2 个远端 agent', (stopped.remote ?? []).filter((r) => r.detached).length === 2, JSON.stringify((stopped.remote ?? []).map((r) => r.detached)));
    } else {
      // `up` failed after the agents were started: close them gracefully so no node child
      // leaks into the next test run.
      for (const port of AGENT_PORTS) {
        try {
          await agentCtl.shutdownAgent(`http://127.0.0.1:${port}`, { token: TOKEN });
        } catch {
          /* already gone */
        }
      }
    }
    for (const agent of agents) {
      try {
        killTree(agent.pid);
      } catch {
        /* already gone */
      }
    }
    await sleep(800);
    // A hard-killed agent can leave its node child behind (observed). Kill it by the pid
    // the node reports, so the test never leaves ports occupied for the next run.
    for (const port of [...AGENT_PORTS, ...AGENT_NODE_PORTS]) {
      const health = await httpJson(`http://127.0.0.1:${port}/health`);
      if (health.ok && health.body?.pid) {
        process.stdout.write(`! 端口 :${port} 仍有节点（pid ${health.body.pid}），清理\n`);
        try {
          killTree(health.body.pid);
        } catch {
          /* best effort */
        }
      }
    }
    await sleep(800);
    for (const port of AGENT_PORTS) {
      check(`agent :${port} 已退出`, !(await portBusy(port)));
    }
    for (const port of [LB_PORT, NODE_BASE, ...AGENT_NODE_PORTS]) {
      check(`端口 :${port} 已释放`, !(await portBusy(port)));
    }
    // Leave no state behind: `down` clears it, but a failed `up` might not have.
    if (!stackUp) {
      const stateFile = resolve(ROOT, '.lab/state.json');
      if (existsSync(stateFile)) rmSync(stateFile, { force: true });
    }
  }
}

try {
  const code = await main();
  if (code === 2) process.exit(2);
} catch (err) {
  process.stdout.write(`\n✗ 分布式测试异常：${err.stack ?? err.message}\n`);
  process.exit(1);
}

process.stdout.write(
  `\n${failures.length ? '✗' : '✓'} 分布式冒烟测试：${checks.length - failures.length}/${checks.length} 通过\n`,
);
if (failures.length) {
  for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`);
  process.exit(1);
}
process.exit(0);
