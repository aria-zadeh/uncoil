#!/usr/bin/env node
// fine-tuned model vs the prompted base model and vs templates. it must beat base
// on schema validity; structural metrics vs templates print only. ship gate: metric 6
// clears its bar and the model is preferred on fit over templates. metric 8
// (duration) never gates, since templates and references share the sessionMinutes
// formula. rules in docs/FINE_TUNING.md
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { venvPythonRelative } from './lib.mjs';

const DIR = join(process.cwd(), 'train', 'reports');
// templates only decompose assignments, so all three are scored on the breakdown
// subset rather than charging templates for work they never do
const KINDS = '--kinds breakdown';
const PYTHON = venvPythonRelative();
const REQUIRED = {
  'finetuned-breakdown': `${PYTHON} train/eval.py --model train/out/<run>/best ${KINDS} --label finetuned-breakdown`,
  'base-breakdown': `${PYTHON} train/eval.py --model base ${KINDS} --label base-breakdown`,
  'templates-breakdown':
    `node --import ./scripts/verify/ts-alias-register.mjs scripts/verify/emit-template-baseline.mjs && ` +
    `${PYTHON} train/eval.py --predictions train/data/baseline-templates.jsonl ${KINDS} --label templates-breakdown`,
};

// templates are perfect here by construction, so these print only
const TOLERANCE = 0.02;
const STRUCTURAL = [
  '1_schema_first_try',
  '2_schema_after_repair',
  '3_step_count_in_range',
  '4_steps_under_45_min',
  '5_actionability',
  '7_hallucination',
  '9_format_leakage',
  '10_repetition',
];

const reports = {};
const missing = [];
for (const [name, how] of Object.entries(REQUIRED)) {
  const path = join(DIR, `${name}.json`);
  if (!existsSync(path)) {
    missing.push(`  ${name}: ${how}`);
    continue;
  }
  reports[name] = JSON.parse(readFileSync(path, 'utf8'));
}

if (missing.length > 0) {
  console.error('missing baseline reports. Section 5.2 requires all three:');
  for (const line of missing) console.error(line);
  console.error('');
  console.error('Until the fine-tune has been run and all three scored, this check is expected to fail.');
  process.exit(1);
}

const finetuned = reports['finetuned-breakdown'];
const base = reports['base-breakdown'];
const templates = reports['templates-breakdown'];
const gates = finetuned.gates;

function better(metric, a, b) {
  return gates[metric].higher_is_better ? a > b : a < b;
}
function delta(metric, a, b) {
  return gates[metric].higher_is_better ? a - b : b - a;
}

let failed = 0;
const say = (ok, text) => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`);
};

console.log(
  `finetuned n=${finetuned.n}  base n=${base.n}  templates n=${templates.n}`,
);
if (new Set([finetuned.n, base.n, templates.n]).size !== 1) {
  console.error('the three reports scored different numbers of samples; they are not comparable');
  process.exit(1);
}

console.log('\nvs prompted base model:');
{
  const a = finetuned.metrics['1_schema_first_try'];
  const b = base.metrics['1_schema_first_try'];
  say(
    a > b,
    `schema valid first try  ${a.toFixed(3)} vs ${b.toFixed(3)}  (+${(a - b).toFixed(3)})`,
  );
}

console.log('\nvs templates, structural metrics (information only, template-relative):');
{
  for (const metric of STRUCTURAL) {
    const x = finetuned.metrics[metric];
    const y = templates.metrics[metric];
    const d = delta(metric, x, y);
    const withinTolerance = d >= -TOLERANCE;
    console.log(
      `  ${withinTolerance ? 'i' : '!'}     ${metric.padEnd(24)}${x.toFixed(3)} vs ${y.toFixed(3)}  ` +
        `(${d >= 0 ? '+' : ''}${d.toFixed(3)}, tolerance ${TOLERANCE})`,
    );
  }
}

// templates are a fallback, never a ship candidate, so this only asks whether the
// model clears its own bar
const METRIC6 = join(DIR, 'metric6.json');
console.log('\nthe ship-or-not decision (docs/FINE_TUNING.md 5.2):');

if (!existsSync(METRIC6)) {
  console.error('  metric 6, fit         NOT MEASURED');
  console.error('');
  console.error('The ship decision runs on metric 6 and has not been scored.');
  console.error('Produce train/reports/metric6.json with train/metric6.py, then re-run.');
  console.error('Leaving it unmeasured is not a pass.');
  process.exit(1);
}

const metric6 = JSON.parse(readFileSync(METRIC6, 'utf8'));

// a score with no recorded judge is not a measurement. human_judged: false is an
// accepted interim (DECISIONS.md) and only warns below
if (metric6.judged_by == null) {
  failed += 1;
  console.log('  FAIL  metric 6 judged_by is missing or null -- a score with no recorded judge is not a measurement');
} else {
  const m8Model = finetuned.metrics['8_duration_mape'];
  const m8Templates = templates.metrics['8_duration_mape'];
  const beatsOn8 = better('8_duration_mape', m8Model, m8Templates);
  console.log(
    `  metric 8, duration   ${m8Model.toFixed(3)} vs ${m8Templates.toFixed(3)}  ` +
      `model ${beatsOn8 ? 'wins' : 'loses'}   (information only, never gates)`,
  );

  // hardcoded so a report cannot pass itself by recording a lower `gate`
  const SHIP_GATE = 0.85;
  const fit = metric6.fit_not_a_spec_metric;
  const modelOk = typeof metric6.model === 'number';
  const fitOk = fit && typeof fit.model_preferred === 'number' && typeof fit.templates_preferred === 'number';

  if (!modelOk) {
    failed += 1;
    console.log('  FAIL  metric 6 model score is missing or not a number -- the ship decision cannot be made without it');
  } else {
    const clearsGate = metric6.model >= SHIP_GATE;
    console.log(
      `  metric 6, fit         ${metric6.model.toFixed(3)} vs gate ${SHIP_GATE.toFixed(2)}  ` +
        `model ${clearsGate ? 'clears' : 'misses'} the gate   (${metric6.judged_by}, n=${metric6.n ?? '?'})`,
    );
  }

  if (!fitOk) {
    failed += 1;
    console.log('  FAIL  metric 6 fit_not_a_spec_metric is missing model_preferred/templates_preferred -- the ship decision cannot be made without it');
  } else {
    const preferredOnFit = fit.model_preferred > fit.templates_preferred;
    console.log(
      `  fit, model preferred  ${fit.model_preferred.toFixed(3)} vs ${fit.templates_preferred.toFixed(3)} templates-preferred  ` +
        `model ${preferredOnFit ? 'preferred' : 'not preferred'}`,
    );
  }

  if (modelOk && fitOk) {
    const clearsGate = metric6.model >= SHIP_GATE;
    const preferredOnFit = fit.model_preferred > fit.templates_preferred;
    if (clearsGate && preferredOnFit) {
      console.log('  PASS  metric 6 clears its gate and the model is preferred on fit over templates');
    } else {
      failed += 1;
      console.log('  FAIL  ship condition not met (docs/FINE_TUNING.md 5.2): needs metric 6 >= gate AND preferred on fit over templates');
    }
  }
}

// accepted, so it does not fail, but it prints loud because nothing else will remind anyone
if (metric6.human_judged !== true) {
  console.log('');
  console.log('  ################################################################');
  console.log('  #  WARN: metric 6 is NOT human-judged                          #');
  console.log(`  #  judged_by:     ${String(metric6.judged_by).padEnd(45)}#`);
  console.log(`  #  human_judged:  ${String(metric6.human_judged).padEnd(45)}#`);
  console.log('  #  Accepted as an interim measure -- docs/DECISIONS.md.        #');
  console.log('  #  This is not a failure. It is a fact about the evidence.     #');
  console.log('  ################################################################');
  console.log('');
}

if (failed > 0) {
  console.error('');
  console.error(`${failed} baseline comparison(s) failed.`);
  console.error('Work the section 5.3 ladder, then record the honest numbers in train/RUNS.md.');
  process.exit(1);
}
process.exit(0);
