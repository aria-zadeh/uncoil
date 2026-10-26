#!/usr/bin/env node
// the bundled model artifact is real (not an LFS pointer, sane size) and
// train/reports/parity.json passed for this exact file, matched by sha256 and
// byte count computed here. a passing report for some other .pte does not count
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { MODEL_ARTIFACT } from './checks.mjs';
import { sh, repoPath, exists, read } from './lib.mjs';

const MIN_BYTES = 1 * 1024 * 1024;
const MAX_BYTES = 600 * 1024 * 1024; // ceiling agreed in DECISIONS.md, 2026-09-07
const PARITY_REPORT_REL = ['train', 'reports', 'parity.json'];
const PARITY_REPORT = repoPath(...PARITY_REPORT_REL);

function fail(reason) {
  console.error(reason);
  process.exit(1);
}

/** whether the parity report passed and its hash and size match the file at artifactPath */
export function matchArtifactToParity(artifactPath, report) {
  const size = statSync(artifactPath).size;
  const hash = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
  const bundledName = basename(artifactPath);

  if (report.passed !== true) {
    return { ok: false, reason: 'parity failed', hash, size };
  }

  const reported = report.artifact;
  const reportedName = reported && typeof reported.file_name === 'string' ? reported.file_name : '(no artifact.file_name)';

  if (!reported || reported.sha256 !== hash || reported.bytes !== size) {
    return { ok: false, reason: `parity report describes ${reportedName}, not the bundled ${bundledName}`, hash, size };
  }

  return { ok: true, hash, size };
}

// only run as a script, so the unit test can import matchArtifactToParity without exiting
if (process.argv[1] && process.argv[1].endsWith('artifact.mjs')) {
  if (!existsSync(MODEL_ARTIFACT)) {
    fail('artifact missing');
  }

  // the file exists, so a non-zero exit here means an LFS pointer
  const lfs = sh('node scripts/verify/lfs-pointer.mjs');
  if (!lfs.ok) {
    fail('LFS pointer');
  }

  const size = statSync(MODEL_ARTIFACT).size;
  console.log(`artifact size: ${size} bytes`);
  if (size <= MIN_BYTES) fail('too small');
  if (size > MAX_BYTES) fail('too large');

  if (!exists(...PARITY_REPORT_REL)) {
    fail('parity report missing');
  }

  let report;
  try {
    report = JSON.parse(read(...PARITY_REPORT_REL));
  } catch (err) {
    fail(`parity report unreadable: ${err instanceof Error ? err.message : err}`);
  }

  const outcome = matchArtifactToParity(MODEL_ARTIFACT, report);
  console.log(`bundled artifact sha256: ${outcome.hash}`);
  if (!outcome.ok) {
    fail(outcome.reason);
  }

  console.log(`model artifact ok: ${PARITY_REPORT} passed=true, describes ${basename(MODEL_ARTIFACT)} by hash, ${size} bytes`);
  process.exit(0);
}
