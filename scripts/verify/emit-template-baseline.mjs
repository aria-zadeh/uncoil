#!/usr/bin/env node
// writes the template fallback's breakdowns over the sealed test split for
// `train/eval.py --predictions`. runs the real services/templates.ts, not a python
// port, so the comparison is of behavior rather than of two copies. run as
//   node --import ./scripts/verify/ts-alias-register.mjs scripts/verify/emit-template-baseline.mjs
// order must match `train/eval.py --kinds breakdown`: sorted batch files, file order
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { forTask } from '@/services/templates';

import { venvPythonRelative } from './lib.mjs';

const ROOT = process.cwd();
const SOURCE = join(ROOT, 'train', 'data_sources', 'test');
const OUT = join(ROOT, 'train', 'data', 'baseline-templates.jsonl');

const records = [];
for (const file of readdirSync(SOURCE).filter((f) => f.endsWith('.json')).sort()) {
  records.push(...JSON.parse(readFileSync(join(SOURCE, file), 'utf8')));
}

const breakdowns = records.filter((r) => r.kind === 'breakdown');
if (breakdowns.length === 0) {
  console.error(`no breakdown records under ${SOURCE}`);
  process.exit(1);
}

const lines = breakdowns.map((record) => {
  const { title, subject, description, duePhrase, sessionMinutes } = record.task;
  const built = forTask({
    title: title ?? '',
    subject: subject ?? null,
    description: description ?? null,
    duePhrase: duePhrase ?? 'in 3 days',
    sessionMinutes: sessionMinutes ?? 30,
  });
  // serialized the way build_dataset.py canonicalizes a completion, so the metrics
  // see the same shape as model output
  return JSON.stringify({ kind: record.kind, completion: JSON.stringify(built) });
});

mkdirSync(join(ROOT, 'train', 'data'), { recursive: true });
writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');
console.log(`wrote ${lines.length} template breakdowns to ${OUT}`);
console.log('score with:');
console.log(
  `  ${venvPythonRelative()} train/eval.py --predictions train/data/baseline-templates.jsonl ` +
    '--kinds breakdown --label templates-breakdown',
);
