import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = process.cwd();

export function sh(command, opts = {}) {
  const r = spawnSync(command, {
    shell: true,
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return {
    ok: r.status === 0,
    code: r.status,
    stdout,
    stderr,
    combined: (stdout + stderr).trim(),
  };
}

export function tail(text, n = 12) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.slice(-n).join('\n');
}

export function repoPath(...p) {
  return join(ROOT, ...p);
}

export function exists(...p) {
  return existsSync(repoPath(...p));
}

export function read(...p) {
  return readFileSync(repoPath(...p), 'utf8');
}

// the venv python is addressed directly so a missing venv fails loudly instead of
// falling back to PATH (`py -V:3.12` was intermittent on this machine)
const VENV_PYTHON_SEGMENTS =
  process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];

export function venvPython() {
  return repoPath('train', '.venv', ...VENV_PYTHON_SEGMENTS);
}

export function venvPythonRelative() {
  return ['train', '.venv', ...VENV_PYTHON_SEGMENTS].join('/');
}

export function requireVenv() {
  if (!existsSync(venvPython())) {
    return { ok: false, detail: `training venv missing at ${venvPython()}\ncreate it before this check can run (see NOTES/phase-2-training.md)` };
  }
  return null;
}
