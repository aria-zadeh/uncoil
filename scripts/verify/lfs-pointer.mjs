#!/usr/bin/env node
// a clone without git-lfs leaves a ~130 byte pointer where the model should be. it
// bundles fine and then fails at runtime with a useless error, so catch it here
import { existsSync, readFileSync } from 'node:fs';
import { MODEL_ARTIFACT } from './checks.mjs';

const LFS_MAGIC = 'version https://git-lfs.' + 'github.com/spec/v1';

if (!existsSync(MODEL_ARTIFACT)) {
  // absent before the artifact lands, and generation falls back to templates
  process.exit(0);
}

const head = readFileSync(MODEL_ARTIFACT).subarray(0, 128).toString('utf8');
if (head.startsWith(LFS_MAGIC)) {
  console.error(`${MODEL_ARTIFACT} is a Git LFS pointer, not the model.`);
  console.error('Run: git lfs install && git lfs pull');
  process.exit(1);
}
process.exit(0);
