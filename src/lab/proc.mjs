/**
 * Child-process helpers.
 *
 * Two constraints shape this file:
 *
 * 1. The lab must be able to start a stack from a CLI, return to the prompt, and
 *    still have the stack running. Children are therefore detached, unref'd, and
 *    write straight to log files.
 * 2. Piped stdio (`stdio: 'pipe'`, the Node default) is blocked in sandboxed
 *    environments (EPERM on spawn) and would also deadlock a long-lived server once
 *    the pipe buffer fills. Every child here inherits a file descriptor instead.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LAB_ROOT } from './paths.mjs';
import { isAlive } from './state.mjs';

/**
 * Start a detached background process with its stdout/stderr appended to a log file.
 *
 * @returns {{ pid: number, logFile: string, kill: () => boolean }}
 */
export function spawnBackground(command, args, { logFile, env, cwd = LAB_ROOT } = {}) {
  const absLog = resolve(LAB_ROOT, logFile);
  mkdirSync(dirname(absLog), { recursive: true });
  const fd = openSync(absLog, 'a');
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['ignore', fd, fd],
      detached: true,
      windowsHide: true,
    });
  } finally {
    // The child owns the handle now; keeping ours open would leak per start/stop cycle.
    closeSync(fd);
  }
  child.on('error', (err) => {
    process.stderr.write(`[lab] 子进程启动失败 ${command}: ${err.message}\n`);
  });
  child.unref();
  return {
    pid: child.pid,
    logFile: absLog,
    kill: () => killTree(child.pid),
  };
}

/**
 * Kill a process and its descendants, cross-platform, without waiting on output.
 *
 * The escalation order is deliberate. On Windows `taskkill /T /F` is the only way
 * to take down a whole tree, but some restricted environments deny it ("Access
 * denied") while still allowing a direct TerminateProcess — so a PowerShell
 * `Stop-Process` fallback and a final `process.kill` are tried before giving up.
 *
 * @returns {boolean} true when the process is gone afterwards
 */
export function killTree(pid) {
  if (!pid) return true;
  if (process.platform === 'win32') {
    // /T kills the tree, /F avoids a hung prompt. Output is discarded on purpose
    // (see the header note about piped stdio).
    spawnSyncQuiet('taskkill', ['/PID', String(pid), '/T', '/F']);
    if (!isAlive(pid)) return true;
    spawnSyncQuiet('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Stop-Process -Id ${Number(pid)} -Force -ErrorAction SilentlyContinue`,
    ]);
    if (!isAlive(pid)) return true;
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
    return !isAlive(pid);
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  return true;
}

function spawnSyncQuiet(command, args) {
  try {
    spawnSync(command, args, { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
  } catch {
    /* best effort */
  }
}
