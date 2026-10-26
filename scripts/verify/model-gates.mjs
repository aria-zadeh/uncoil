#!/usr/bin/env node
// every metric in train/reports/finetuned.json meets its gate. train/eval.py does the
// scoring so the gate never loads torch or the model. thresholds come from the report
// but are re-applied here rather than trusting its own `all_gates_pass`
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { venvPythonRelative } from './lib.mjs';

const REPORT = join(process.cwd(), 'train', 'reports', 'finetuned.json');
const MIN_TEST_SAMPLES = 200; // size of the sealed test split

if (!existsSync(REPORT)) {
  console.error(`no evaluation report at ${REPORT}`);
  console.error('');
  console.error('Produce it with:');
  console.error(
    `  ${venvPythonRelative()} train/eval.py --model train/out/<run>/best --label finetuned`,
  );
  console.error('');
  console.error('Until the fine-tune has been run and scored, this check is expected to fail.');
  process.exit(1);
}

const report = JSON.parse(readFileSync(REPORT, 'utf8'));
const { metrics, gates } = report;

if (!metrics || !gates) {
  console.error(`${REPORT} is missing "metrics" or "gates"; it was not written by train/eval.py`);
  process.exit(1);
}

if (typeof report.n !== 'number' || report.n < MIN_TEST_SAMPLES) {
  console.error(
    `evaluated on ${report.n} samples, the sealed test split must be at least ${MIN_TEST_SAMPLES}`,
  );
  console.error('A gate passed on a partial split is not a passed gate.');
  process.exit(1);
}

let failed = 0;
const rows = [];
for (const [key, spec] of Object.entries(gates)) {
  const value = metrics[key];
  if (typeof value !== 'number' || Number.isNaN(value)) {
    console.error(`metric ${key} is missing from the report`);
    failed += 1;
    continue;
  }
  const ok = spec.higher_is_better ? value >= spec.gate : value <= spec.gate;
  if (!ok) failed += 1;
  rows.push(
    `${ok ? 'PASS' : 'FAIL'}  ${key.padEnd(24)} ${value.toFixed(3)} ` +
      `${spec.higher_is_better ? '>=' : '<='} ${spec.gate.toFixed(3)}`,
  );
}

console.log(`${report.label}: ${report.n} samples`);
for (const row of rows) console.log(`  ${row}`);

if (failed > 0) {
  console.error('');
  console.error(`${failed} of ${rows.length} metrics are below their gate.`);
  console.error(
    'Work the FINE_TUNING.md section 5.3 escalation ladder in order and record the outcome.',
  );
  console.error('Do not edit a threshold in train/eval.py to clear this.');
  process.exit(1);
}

console.log('');
console.log('metric 6 is human-judged and is not covered by this check.');
console.log(`see train/reports/${String(report.label).replace(/[\\/:]/g, '_')}.metric6-sample.jsonl`);
process.exit(0);
