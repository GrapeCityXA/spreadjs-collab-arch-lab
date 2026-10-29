/**
 * The lab's runtime state file: which processes belong to the current stack.
 *
 * `up` writes it, `down`/`status`/the web API read it. It is the only place that
 * knows which pid a port belongs to, which is what lets `down` kill *only* what
 * this lab started (never a process the user was already running).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { STATE_DIR, STATE_FILE } from './paths.mjs';

export function readState() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Atomic write: a half-written state file would make `down` unsafe. */
export function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, STATE_FILE);
  return state;
}

export function clearState() {
  rmSync(STATE_FILE, { force: true });
}

/** True when the process exists (signal 0 probe works on Windows and POSIX). */
export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
