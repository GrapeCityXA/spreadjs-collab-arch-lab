#!/usr/bin/env node
/**
 * Self-test: prove the lab itself works, end to end, on this machine.
 *
 * It starts every topology for real, runs the same check a user runs, and asserts
 * that the lab reports what the topology promised — including that the three
 * anti-pattern variants are reproduced as `expected-broken`. If this passes, the
 * instructions in the README are true on this machine.
 *
 * Usage: npm run self-test [-- --only=single,sharded] [-- --skip-variants]
 *
 * This is intentionally NOT a unit-test suite: the thing worth testing is the
 * behaviour of real processes over real sockets. It takes ~1-2 minutes.
 */
import { up, down } from '../src/lab/orchestrator.mjs';
import { readState } from '../src/lab/state.mjs';
import { loadLabConfig } from '../src/lab/paths.mjs';
import { pingRedis } from '../src/lab/redis.mjs';
import { runCheck } from '../src/checks/runner.mjs';
import { renderMarkdown } from '../src/checks/report.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const has = (name) => args.includes(`--${name}`);

const CASES = [
  {
    name: 'single',
    label: '单机（1 节点）',
    up: { mode: 'single' },
    summary: 'healthy',
    // One case also proves the load cap: the check must SAY it clamped, not silently
    // measure fewer users than the scenario asked for.
    clampLoad: true,
    checks: { 'nodes.health': 'pass', 'topology.config': 'pass', 'lb.distribution': 'n/a', 'realtime.sameNode': 'pass' },
  },
  {
    name: 'sharded',
    label: '分区（3 节点 + 亲和负载均衡）',
    up: { mode: 'sharded' },
    summary: 'healthy',
    checks: {
      'lb.distribution': 'pass',
      'room.placement': 'pass',
      'realtime.crossNode': 'n/a',
      'join.consistency': 'record',
    },
  },
  {
    name: 'shared',
    label: '共享 room（3 节点 + 适配器 + 共享库）',
    up: { mode: 'shared' },
    summary: 'healthy',
    needsRedis: true,
    checks: {
      'realtime.crossNode': 'pass',
      'join.consistency': 'pass',
      'store.consistency': 'pass',
      'eventual.mask': 'pass',
    },
  },
  {
    name: 'broken-sharded',
    label: '反模式 A：分区但负载均衡不亲和',
    up: { variant: 'broken-sharded' },
    summary: 'expected-broken',
    checks: { 'room.placement': 'expected-failure' },
  },
  {
    name: 'broken-adapter-only',
    label: '反模式 B：只有适配器，文档库不共享',
    up: { variant: 'broken-adapter-only' },
    summary: 'expected-broken',
    needsRedis: true,
    checks: { 'join.consistency': 'expected-failure', 'store.consistency': 'expected-failure' },
  },
  {
    name: 'broken-no-adapter',
    label: '反模式 C：文档库共享但没有适配器',
    up: { variant: 'broken-no-adapter' },
    summary: 'expected-broken',
    checks: { 'realtime.crossNode': 'expected-failure', 'eventual.mask': 'expected-failure' },
  },
];

const only = flag('only')?.split(',').map((s) => s.trim());
const cases = CASES.filter((c) => (only ? only.includes(c.name) : true)).filter((c) =>
  has('skip-variants') ? !c.up.variant : true,
);

const results = [];

function record(name, label, ok, detail) {
  results.push({ name, label, ok, detail });
  process.stdout.write(`${ok ? '  PASS' : '  FAIL'}  ${label}  ${detail}\n`);
}

async function runCase(testCase, redisAvailable) {
  process.stdout.write(`\n=== ${testCase.label} ===\n`);
  if (testCase.needsRedis && !redisAvailable) {
    process.stdout.write('  SKIP  需要 Redis，本机不可用\n');
    results.push({ name: testCase.name, label: testCase.label, ok: null, skipped: true, detail: '需要 Redis' });
    return;
  }
  try {
    const state = await up({ ...testCase.up, withWeb: false, log: { info: () => {}, warn: () => {} } });
    // A tiny scenario keeps the sample phase short; the assertions below are about the
    // *shape* of the result (scenario echoed, load recorded, report mentions it).
    const scenario = { users: testCase.clampLoad ? 6 : 4, interval: 0.5, duration: 2, rooms: 1 };
    if (testCase.clampLoad) process.env.SJS_LAB_MAX_LOAD_CLIENTS = '2';
    const { result } = await runCheck({ stack: state, persist: false, scenario });
    if (testCase.clampLoad) delete process.env.SJS_LAB_MAX_LOAD_CLIENTS;
    const markdown = renderMarkdown(result);

    record(
      testCase.name,
      `${testCase.label} · 结论`,
      result.summary.status === testCase.summary,
      `实际 ${result.summary.status}（期望 ${testCase.summary}）`,
    );
    for (const [id, expected] of Object.entries(testCase.checks ?? {})) {
      const check = result.checks.find((c) => c.id === id);
      record(
        testCase.name,
        `${testCase.label} · ${id}`,
        check?.status === expected,
        `实际 ${check?.status ?? '缺失'}（期望 ${expected}）`,
      );
    }

    // ---- scenario plumbing -------------------------------------------------
    const loadCheck = result.checks.find((c) => c.id === 'load.scenario');
    record(
      testCase.name,
      `${testCase.label} · 12 项检查（新增 load.scenario）`,
      result.checks.length === 12 && Boolean(loadCheck),
      `共 ${result.checks.length} 项`,
    );
    record(
      testCase.name,
      `${testCase.label} · load.scenario 是记录不是承诺`,
      loadCheck?.status === 'record',
      `实际 ${loadCheck?.status ?? '缺失'}（期望 record）`,
    );
    record(
      testCase.name,
      `${testCase.label} · 结果回显用户场景`,
      result.scenario?.users === scenario.users &&
        result.scenario?.opIntervalMs === scenario.interval * 1000 &&
        result.scenario?.durationMs === scenario.duration * 1000,
      JSON.stringify(result.scenario?.describe),
    );
    record(
      testCase.name,
      `${testCase.label} · 场景真的产生编辑`,
      (loadCheck?.metrics?.ops ?? 0) > 0,
      `ops=${loadCheck?.metrics?.ops} 失败=${loadCheck?.metrics?.opsFailed}`,
    );
    record(
      testCase.name,
      `${testCase.label} · 报告写明场景`,
      markdown.includes('- 场景：') && markdown.includes('场景负载'),
      'markdown 含 "- 场景：" 与 "场景负载"',
    );
    if (testCase.clampLoad) {
      record(
        testCase.name,
        `${testCase.label} · 超上限时明确收敛`,
        result.scenario?.load?.capped === true && (loadCheck?.detail ?? '').includes('按上限收敛'),
        `clients=${result.scenario?.load?.clients} capped=${result.scenario?.load?.capped}`,
      );
    }

    record(testCase.name, `${testCase.label} · 报告可渲染`, markdown.length > 500, 'markdown 长度 > 500');
  } catch (err) {
    if (testCase.clampLoad) delete process.env.SJS_LAB_MAX_LOAD_CLIENTS;
    record(testCase.name, `${testCase.label} · 启动或体检`, false, err.message);
  } finally {
    await down({ log: { info: () => {}, warn: () => {} } });
  }
}

async function main() {
  const config = loadLabConfig();
  process.stdout.write('SpreadJS 协同架构验证实验室 · 自检\n');
  process.stdout.write(
    `端口：负载均衡 ${config.lbPort}，节点 ${config.nodeBasePort}-${config.nodeBasePort + config.defaultNodes - 1}\n`,
  );

  const running = readState();
  if (running) {
    process.stdout.write('[self-test] 检测到已运行的 stack，先停止它。\n');
    await down({ log: { info: () => {}, warn: () => {} } });
  }

  const redisAvailable = await pingRedis(config.redisUrl, 1200);
  process.stdout.write(`Redis：${redisAvailable ? '可用' : '不可用（shared 相关用例会跳过）'}\n`);

  for (const testCase of cases) await runCase(testCase, redisAvailable);

  const failed = results.filter((r) => !r.skipped && !r.ok);
  const skipped = results.filter((r) => r.skipped);
  const passed = results.filter((r) => !r.skipped && r.ok);
  process.stdout.write(`\n${'-'.repeat(60)}\n`);
  process.stdout.write(
    `${results.length} 项结果：${passed.length} 通过${skipped.length ? `，${skipped.length} 用例跳过` : ''}` +
      `${failed.length ? `，${failed.length} 失败` : ''}\n`,
  );
  if (failed.length) {
    for (const failure of failed) process.stdout.write(`  ✗ ${failure.label}：${failure.detail}\n`);
    return 1;
  }
  process.stdout.write(`自检通过：已执行 ${cases.length - skipped.length}/${cases.length} 个所选用例${skipped.length ? '，跳过项未验证' : ''}。\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`[self-test] ${err.message}\n`);
    if (process.env.SJS_LAB_DEBUG) process.stderr.write(`${err.stack}\n`);
    process.exitCode = 1;
  });
