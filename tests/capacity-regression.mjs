/** Pure capacity regressions: no stack, sockets, license or installed packages. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LAB_ROOT } from '../src/lab/paths.mjs';
import { formatCores, modelScenario, roomIndexForUser } from '../src/lab/scenario.mjs';

const sparse = modelScenario({ users: 10_000, rooms: 9_999, opIntervalMs: 50 });
assert.equal(sparse.fanoutPerSecond, 40, 'one two-user room sends 40 peer messages/s');
assert.equal(sparse.usersPerRoom, 10_000 / 9_999);
assert.equal(sparse.usersPerRoomMin, 1);
assert.equal(sparse.usersPerRoomMax, 2);
assert.equal(sparse.roomsWithExtraUser, 1);
assert.ok(sparse.predictedCores > 0 && sparse.predictedCores < 0.01);
assert.equal(formatCores(sparse.predictedCores), '<0.01');

// Independent check: enumerate the same room assignment used by the generators.
for (const [users, rooms] of [[5, 3], [10_000, 9_999], [7, 4], [1, 1], [500, 500]]) {
  const membership = Array(rooms).fill(0);
  for (let user = 0; user < users; user++) membership[roomIndexForUser(user, users, rooms)]++;
  assert.equal(membership.reduce((sum, count) => sum + count, 0), users);
  assert.ok(Math.max(...membership) - Math.min(...membership) <= 1);
  const actualRecipients = membership.reduce((sum, count) => sum + count * (count - 1), 0);
  assert.equal(modelScenario({ users, rooms, opIntervalMs: 1000 }).fanoutPerSecond, actualRecipients);
}
for (const args of [[-1, 5, 3], [5, 5, 3], [0, 5, 6], [0, 5, 0], [0, 1.5, 1]]) {
  assert.throws(() => roomIndexForUser(...args), { code: 'BAD_SCENARIO' });
}

const solo = modelScenario({ users: 500, rooms: 500, opIntervalMs: 50 }, { presence: true });
assert.equal(solo.opsPerSecond, 10_000);
assert.equal(solo.fanoutPerSecond, 0);
assert.equal(solo.predictedCores, 0);
assert.equal(solo.cpuScope, 'broadcast-only');
assert.equal(formatCores(0), '0');

// Run the exact CLI in an isolated fixture so existing reports cannot hide its
// fresh-clone instructions or affect the historical-report checks below.
const fixture = mkdtempSync(resolve(tmpdir(), 'sjs-capacity-regression-'));
try {
  for (const relative of ['scripts', 'src/lab']) mkdirSync(resolve(fixture, relative), { recursive: true });
  for (const relative of ['scripts/capacity.mjs', 'src/lab/scenario.mjs', 'src/lab/paths.mjs']) {
    copyFileSync(resolve(LAB_ROOT, relative), resolve(fixture, relative));
  }
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [resolve(fixture, 'scripts/capacity.mjs'), ...args], {
      cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 20_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const table = (output) => Array.from(output.matchAll(
    /^\s*每\s+([\d.]+)s 一次\s+([\d,]+) 条\/秒\s+广播 CPU ≈ ([\d.<]+) 核$/gm,
  ), (match) => ({ seconds: Number(match[1]), deliveries: Number(match[2].replaceAll(',', '')), cores: match[3] }));

  const unevenOutput = cli('--users=5', '--rooms=3', '--interval=2000');
  assert.deepEqual(table(unevenOutput).map((row) => row.deliveries), [7, 2, 1, 0]);
  assert.match(unevenOutput, /平均 1\.6667 人\/房间，每房间 1–2 人/);
  assert.match(unevenOutput, /npm run bench -- --users=5 --interval=2 --duration=20 --rooms=3/);

  const args = ['--users=4000', '--rooms=2000', '--interval=2000'];
  const withPresence = JSON.parse(cli(...args, '--presence', '--json'));
  const withoutPresence = JSON.parse(cli(...args, '--json'));
  assert.equal(withPresence.estimate.fanoutPerSec, 2000);
  assert.equal(withoutPresence.estimate.fanoutPerSec, 2000);
  assert.equal(withPresence.model.presenceCpuFactor, 1.17);
  assert.equal(withPresence.estimate.coresNeeded / withoutPresence.estimate.coresNeeded, 1.17);
  assert.equal(withPresence.estimate.nodesBasis, 'aggregate-cpu-division-only');
  assert.match(withPresence.suggestedBenchCommand, /--rooms=2000(?:\s|$)/);
  assert.deepEqual(table(cli(...args, '--presence')), [
    { seconds: 0.6, deliveries: 6667, cores: '0.61' },
    { seconds: 2, deliveries: 2000, cores: '0.18' },
    { seconds: 5, deliveries: 800, cores: '0.07' },
    { seconds: 30, deliveries: 133, cores: '0.01' },
  ]);
  const soloOutput = JSON.parse(cli('--users=500', '--rooms=500', '--interval=50', '--json'));
  assert.equal(soloOutput.estimate.fanoutPerSec, 0);
  assert.equal(soloOutput.estimate.editsPerSec, 10_000);
  assert.match(soloOutput.limitations.join('\n'), /零广播仍有编辑处理、连接、存储和内存成本/);
  assert.match(soloOutput.limitations.join('\n'), /不代表一个 Node 进程能用满这些核/);
  assert.equal(JSON.parse(cli('--users=1', '--rooms=1', '--json')).estimate.fanoutPerSec, 0);

  mkdirSync(resolve(fixture, 'reports'));
  const report = {
    generatedAt: '2026-10-28T00:00:00Z', scenario: { users: 4000, rooms: 2000, opIntervalMs: 2000, durationMs: 15_000 },
    fanoutPerSecond: 905, ackMs: { p95: 707 },
  };
  const reportFile = resolve(fixture, 'reports/bench-2026-10-28.json');
  writeFileSync(reportFile, JSON.stringify(report));
  const legacyOutput = cli(...args);
  assert.match(legacyOutput, /旧报告没有可靠 writingMs.*吞吐分母含建连时间/);
  assert.doesNotMatch(legacyOutput, /目标编辑扇出 \/ 那次报告扇出/);
  assert.equal(JSON.parse(cli(...args, '--json')).bench.throughputBasis, 'legacy-includes-connect');
  writeFileSync(reportFile, JSON.stringify({ ...report, writingMs: 15_000 }));
  const currentOutput = cli(...args);
  assert.match(currentOutput, /不能证明容量余量，也不能直接换算机器数/);
  assert.doesNotMatch(currentOutput, /偏乐观|需要更多机器|在实测规模之内/);
  assert.equal(JSON.parse(cli(...args, '--json')).bench.throughputBasis, 'writing-window');
  writeFileSync(reportFile, JSON.stringify({ ...report, writingMs: 15_000, timingBasis: 'legacy-elapsed-fallback' }));
  const mixedLegacyOutput = cli(...args);
  assert.match(mixedLegacyOutput, /legacy-elapsed-fallback.*吞吐分母含建连时间/);
  assert.doesNotMatch(mixedLegacyOutput, /目标编辑扇出 \/ 那次报告扇出/);
  assert.equal(JSON.parse(cli(...args, '--json')).bench.throughputBasis, 'legacy-includes-connect');
  process.stdout.write('PASS capacity room distribution, singleton rooms, CLI frequency table, presence and report scope\n');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
