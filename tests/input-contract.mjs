/** Regression checks: requested scenarios, result semantics and license sources. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { normalizeScenario, scenarioFromFlags, CHECK_DEFAULTS } from '../src/lab/scenario.mjs';
import { resolveLicense, resolveConfig } from '../src/server/config.mjs';
import { comparisonExitCode } from '../src/checks/compare.mjs';
import { benchOutcome } from '../src/bench/bench.mjs';
import { LAB_ROOT, LICENSE_FILE } from '../src/lab/paths.mjs';

const temp = mkdtempSync(resolve(tmpdir(), 'sjs-input-contract-'));
const env = { ...process.env };
for (const key of ['SJS_LICENSE_FILE', 'SJS_LICENSE_KEY', 'SJS_DESIGNER_LICENSE_KEY', 'SJS_SERVER_LICENSE_KEY']) delete env[key];
try {
  assert.equal(normalizeScenario().users, CHECK_DEFAULTS.users);
  assert.equal(scenarioFromFlags({ interval: '0.5', duration: '1' }).opIntervalMs, 500);
  assert.equal(normalizeScenario({ clients: 3, intervalMs: 500, duration: 1 }).users, 3);
  for (const input of [null, [], 'bad', { users: 'oops' }, { users: 1.5 }, { users: true },
    { users: '' }, { users: null }, { interval: 0 }, { interval: -1 }, { interval: 'bad' },
    { intervalMs: Infinity }, { duration: 0 }, { durationMs: NaN }, { rooms: 0 },
    { rooms: 'bad' }, { rooms: 1.5 }, { users: 2, rooms: 3 }]) {
    assert.throws(() => normalizeScenario(input), { code: 'BAD_SCENARIO' });
  }
  for (const flags of [{ users: true }, { interval: true }, { duration: '' }, { rooms: 'NaN' }]) {
    assert.throws(() => scenarioFromFlags(flags), { code: 'BAD_SCENARIO' });
  }

  const healthy = { result: { summary: { status: 'healthy' } } };
  const expected = { variant: 'broken-no-adapter', result: { summary: { status: 'expected-broken' } } };
  assert.equal(comparisonExitCode([healthy, expected]), 0);
  for (const results of [[], [healthy, { error: 'Redis unavailable' }],
    [healthy, { ...expected, error: 'startup failed' }],
    [{ result: { summary: { status: 'degraded' } } }],
    [{ ...expected, result: { summary: { status: 'healthy' } } }]]) {
    assert.equal(comparisonExitCode(results), 1);
  }
  assert.equal(benchOutcome({ ok: 10, failed: 0 }).writesPassed, true);
  assert.equal(benchOutcome({ ok: 10, failed: 0 }).performance, 'not-evaluated');
  assert.equal(benchOutcome({ ok: 1, failed: 99 }).writesPassed, false);
  assert.equal(benchOutcome({ ok: 0, failed: 0 }).writesPassed, false);
  assert.equal(benchOutcome({ ok: 10, failed: 0 }, true).status, 'cancelled');

  const file = resolve(temp, 'license.json');
  writeFileSync(file, JSON.stringify({ runtime: { licenseKey: 'file-runtime' }, serverLicenseKey: 'file-server' }));
  const resolved = resolveLicense(file, { SJS_SERVER_LICENSE_KEY: 'env-server' });
  assert.equal(resolved.licenseKey, 'file-runtime');
  assert.equal(resolved.serverLicenseKey, 'env-server');
  assert.equal(resolved.source, 'env');
  assert.equal(resolveLicense(undefined, {}).file, LICENSE_FILE, 'no parent-directory fallback');
  assert.equal(resolveLicense(undefined, { SJS_SERVER_LICENSE_KEY: 'env-server' }).status.server, true);
  assert.equal(resolveLicense('config/license.example.json', {}).file, resolve(LAB_ROOT, 'config/license.example.json'));
  assert.equal(resolveConfig([], { SJS_SERVER_LICENSE_KEY: 'env-server' }).license.serverLicenseKey, 'env-server');
  assert.throws(() => resolveLicense(undefined, { SJS_LICENSE_FILE: resolve(temp, 'missing.json'), SJS_SERVER_LICENSE_KEY: 'env-server' }), /指定的授权文件不存在/);
  writeFileSync(file, '{ "secret": "do-not-print-this",');
  assert.throws(() => resolveLicense(file, {}), (error) => /授权文件格式错误/.test(error.message) && !error.message.includes('do-not-print-this'));

  // Real CLI input checks: invalid requests must fail before starting any stack.
  const stdout = openSync(resolve(temp, 'stdout.log'), 'w');
  const stderr = openSync(resolve(temp, 'stderr.log'), 'w');
  try {
    for (const args of [
      ['src/cli.mjs', 'check', '--users=abc'], ['src/cli.mjs', 'bench', '--interval=0'],
      ['src/cli.mjs', 'compare', '--duration=-1'], ['src/cli.mjs', 'check', '--users'],
      ['src/cli.mjs', 'check', '--max-load-clients=bad'],
      ['scripts/capacity.mjs', '--rooms=bad'], ['scripts/capacity.mjs', '--node-cores=0'],
      ['scripts/capacity.mjs', '--users=2.5'], ['scripts/capacity.mjs', '--rooms'],
    ]) {
      const result = spawnSync(process.execPath, args, { cwd: LAB_ROOT, env,
        stdio: ['ignore', stdout, stderr], windowsHide: true, timeout: 20_000 });
      assert.equal(result.status, 2, `${args.join(' ')}: ${readFileSync(resolve(temp, 'stderr.log'), 'utf8')}`);
    }
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  process.stdout.write('PASS scenario validation, command results, license resolution and invalid CLI requests\n');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
