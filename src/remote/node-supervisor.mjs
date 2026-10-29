#!/usr/bin/env node
/**
 * Watchdog wrapper around ONE collaboration node child of an agent (DEV-CONTRACT §12).
 *
 *   node src/remote/node-supervisor.mjs --parent-pid=<agent pid> -- \
 *        src/server/node-server.mjs --port=8081 --node-id=node-h1-8081
 *
 * Why this exists: the node child must survive a normal agent restart of the node
 * (so the agent can keep its log fd), but it must NOT survive a crashed or
 * force-killed agent. A detached child alone does exactly the first and not the
 * second - `taskkill /T /F` on the agent normally reaches it, but when that is
 * denied (sandboxes) the node keeps the port and the next agent start fails with a
 * confusing "port in use". Two independent guarantees are therefore stacked here:
 *
 *   1. the node is a normal child of this supervisor, so killing the supervisor's
 *      tree (taskkill /T /F) kills the node as well;
 *   2. this supervisor polls the agent pid. When the agent disappears for any other
 *      reason, the node is stopped and the supervisor exits.
 *
 * Nothing is ever piped: the supervisor inherits the log fd from the agent and
 * passes the same fd to the node via `stdio: 'inherit'`.
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
const ownArgs = separator === -1 ? args : args.slice(0, separator);
const childArgs = separator === -1 ? [] : args.slice(separator + 1);

function parseFlag(prefix) {
  const match = ownArgs.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const parentPid = Number(parseFlag('--parent-pid='));
const intervalMs = Number(parseFlag('--interval-ms=') ?? 300);

if (!childArgs.length) {
  process.stderr.write('[supervisor] usage: node node-supervisor.mjs --parent-pid=<pid> -- <script> [args...]\n');
  process.exit(2);
}
if (!Number.isInteger(parentPid) || parentPid <= 0) {
  process.stderr.write('[supervisor] --parent-pid=<agent pid> is required\n');
  process.exit(2);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const child = spawn(process.execPath, childArgs, {
  stdio: 'inherit',
  windowsHide: true,
});

let stopping = false;
let parentGone = false;

/** Stop the node; escalate if it ignores SIGTERM. Never hangs. */
function stopChild(reason) {
  if (stopping) return;
  stopping = true;
  process.stderr.write(`[supervisor] ${reason}: stopping node child ${child.pid}\n`);
  try {
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    process.exit(0);
  }, 2_000);
  timer.unref?.();
}

child.on('error', (err) => {
  process.stderr.write(`[supervisor] failed to start node: ${err.message}\n`);
  process.exit(1);
});

// The node is the supervisor's whole reason to exist: when it exits, exit with the
// same code so the agent's health wait sees the real startup failure (exit 2 for an
// invalid configuration, for example).
child.on('exit', (code, signal) => {
  if (parentGone) process.exit(0);
  process.exit(code ?? (signal ? 1 : 1));
});

const timer = setInterval(() => {
  if (isAlive(parentPid)) return;
  parentGone = true;
  stopChild(`agent ${parentPid} is gone`);
}, Number.isFinite(intervalMs) && intervalMs >= 50 ? intervalMs : 300);
timer.unref?.();

// A tree kill may deliver SIGTERM to the supervisor before the node; forward it so
// the node still gets its graceful shutdown path.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => stopChild(signal));
}
