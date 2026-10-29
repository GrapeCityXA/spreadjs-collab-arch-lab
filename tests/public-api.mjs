/** Regression coverage for public credentials, CLI JSON and graceful web stop. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LAB_ROOT, LOG_DIR, loadLabConfig } from '../src/lab/paths.mjs';
import { down } from '../src/lab/orchestrator.mjs';
import { publicJsonReplacer } from '../src/lab/public-json.mjs';
import { spawnBackground } from '../src/lab/proc.mjs';
import { readState, isAlive } from '../src/lab/state.mjs';
import { assertPortFree, waitForJson, waitPortFree } from '../src/lab/ports.mjs';

if (readState()) throw new Error('已有部署记录，先 npm run down 再运行 test:api。');

const token = randomBytes(24).toString('hex');
const privateState = { agentToken: token, lb: { adminToken: token }, nested: [{ agentToken: null }] };
const visible = JSON.parse(JSON.stringify(privateState, publicJsonReplacer));
assert.equal(visible.agentToken, 'SET');
assert.equal(visible.lb.adminToken, 'SET');
assert.equal(visible.nested[0].agentToken, 'MISSING');
assert.equal(privateState.agentToken, token, 'serialization must not mutate runtime credentials');

const cfg = loadLabConfig();
await assertPortFree(cfg.webPort, 'test:api 控制台');
mkdirSync(LOG_DIR, { recursive: true });
let web;
const quiet = { info() {}, warn() {} };

function cli(args) {
  const output = resolve(LOG_DIR, 'api-cli-stdout.log');
  const errors = resolve(LOG_DIR, 'api-cli-stderr.log');
  const stdout = openSync(output, 'w');
  const stderr = openSync(errors, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [resolve(LAB_ROOT, 'src/cli.mjs'), ...args], {
      cwd: LAB_ROOT, stdio: ['ignore', stdout, stderr], windowsHide: true, timeout: 60_000,
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  assert.equal(result.status, 0, readFileSync(errors, 'utf8'));
  const text = readFileSync(output, 'utf8');
  assert.ok(!text.includes(token), 'CLI output leaked a management token');
  return JSON.parse(text);
}

async function request(path, body) {
  const response = await fetch(`http://127.0.0.1:${cfg.webPort}${path}`, {
    method: body ? 'POST' : 'GET',
    // CLI subprocesses block this test's event loop; do not reuse an idle socket
    // whose keep-alive close event cannot be processed during that interval.
    headers: { connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `HTTP ${response.status} ${path}`);
  const text = await response.text();
  assert.ok(!text.includes(token), `API ${path} leaked a management token`);
  return JSON.parse(text);
}

try {
  web = spawnBackground(process.execPath, [resolve(LAB_ROOT, 'src/web/server.mjs'), `--port=${cfg.webPort}`], {
    logFile: 'logs/api-web.log',
    env: { SJS_LICENSE_FILE: '', SJS_LICENSE_KEY: 'test-runtime-not-a-license',
      SJS_DESIGNER_LICENSE_KEY: '', SJS_SERVER_LICENSE_KEY: 'test-server-not-a-license' },
  });
  await waitForJson(`http://127.0.0.1:${cfg.webPort}/api/health`, { timeoutMs: 20_000 });
  const licenseConfig = await request('/api/collab-config');
  assert.equal(licenseConfig.source, 'env');
  assert.equal(licenseConfig.license.server, true);
  assert.equal(licenseConfig.licenseKey, 'test-runtime-not-a-license');
  const started = await request('/api/stack/up', { mode: 'sharded', overrides: { nodes: 2 }, agentToken: token });
  assert.equal(started.state.lb.adminToken, 'SET');
  assert.equal(readState().lb.adminToken, token, 'private token is needed for cleanup');
  assert.equal((await request('/api/stack')).state.lb.adminToken, 'SET');
  for (const route of ['/api/check', '/api/bench']) {
    for (const scenario of [{ users: 'bad' }, { interval: 0 }, { users: 2, rooms: 3 }, null]) {
      const response = await fetch(`http://127.0.0.1:${cfg.webPort}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ scenario }), signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 400, `${route} must reject invalid scenarios`);
      await response.text();
    }
  }
  assert.equal(cli(['status', '--json']).lb.adminToken, 'SET');
  assert.equal(cli(['check', '--json', '--users=4', '--duration=1', '--interval=0.5']).summary.status, 'healthy');
  assert.equal(cli(['down', '--json']).stopped, true);
  const cliStarted = cli(['up', '--mode=sharded', '--nodes=2', '--no-web', '--json', `--agent-token=${token}`]);
  assert.equal(cliStarted.lb.adminToken, 'SET');
  assert.equal((await request('/api/stack')).state.lb.adminToken, 'SET');
  const response = await fetch(`http://127.0.0.1:${cfg.webPort}/shutdown`, {
    method: 'POST', headers: { connection: 'close' }, signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 202, 'web shutdown must reach the API router');
  await response.text();
  assert.equal(await waitPortFree(cfg.webPort, 5000), true, 'web must release its port');
  process.stdout.write('PASS public API/CLI tokens, private credential retention, JSON parsing, graceful web shutdown\n');
} finally {
  await down({ log: quiet });
  if (web && isAlive(web.pid)) web.kill();
}
