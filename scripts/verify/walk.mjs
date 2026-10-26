import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { SCAN_EXTS, SCAN_ROOTS, SCAN_FILES } from './scan-scope.mjs';

export function toPosix(p) {
  return p.split(sep).join('/');
}

// tracked plus untracked-but-not-ignored files, so .gitignore decides what the
// scans skip and a new venv or build dir needs no list update. cached per root
const gitFilesCache = new Map();
function gitVisibleFiles(root) {
  const cached = gitFilesCache.get(root);
  if (cached) return cached;
  const r = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${r.stderr || r.error || 'unknown error'}`);
  }
  const files = r.stdout.split('\0').filter(Boolean).map(toPosix);
  gitFilesCache.set(root, files);
  return files;
}

// train/data/ is gitignored but is a corpus root for banned-strings.mjs, so list it
// directly. one level only, it holds flat .jsonl files
function trainDataFiles(root) {
  const dir = join(root, 'train', 'data');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && SCAN_EXTS.has(extname(e.name)))
    .map((e) => toPosix(join('train', 'data', e.name)));
}

/** git-visible files under `dir`, filtered to SCAN_EXTS, appended to `out` as repo-relative paths */
export function walk(dir, root, out = []) {
  const prefix = toPosix(relative(root, dir));
  for (const f of gitVisibleFiles(root)) {
    if (prefix !== '' && f !== prefix && !f.startsWith(`${prefix}/`)) continue;
    if (!SCAN_EXTS.has(extname(f))) continue;
    out.push(f);
  }
  return out;
}

/** files under SCAN_ROOTS, plus SCAN_FILES (not extension-filtered) and train/data/ */
export function scanTargets(root) {
  const files = [...gitVisibleFiles(root), ...trainDataFiles(root)];
  const out = [];

  for (const f of files) {
    const top = f.split('/')[0];
    if (SCAN_ROOTS.includes(top) && SCAN_EXTS.has(extname(f))) out.push(f);
  }

  const fileSet = new Set(files);
  for (const f of SCAN_FILES) {
    if (fileSet.has(f)) out.push(f);
  }

  return [...new Set(out)].sort();
}
