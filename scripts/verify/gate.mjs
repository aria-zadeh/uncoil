#!/usr/bin/env node
// runs every check in checks.mjs. no arguments on purpose: a subset flag is one way to
// forget something and turn the gate into a no-op. `npm run check <id>` is for the dev loop
import { CHECKS } from './checks.mjs';

if (process.argv.length > 2) {
  console.error('verify takes no arguments. It always runs all checks.');
  console.error('For a single check during development: npm run check <id>');
  process.exit(2);
}

const started = Date.now();
const results = [];

for (const check of CHECKS) {
  process.stdout.write(`  [${String(check.id).padStart(2)}] ${check.title} ... `);
  let outcome;
  try {
    outcome = await check.run();
  } catch (err) {
    outcome = { ok: false, detail: `check threw: ${err?.stack ?? err}` };
  }
  process.stdout.write(outcome.ok ? 'PASS\n' : 'FAIL\n');
  results.push({ ...check, ...outcome });
}

const failures = results.filter((r) => !r.ok);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log('');
console.log('='.repeat(72));
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${String(r.id).padStart(2)}  ${r.title}`);
}
console.log('='.repeat(72));

if (failures.length === 0) {
  console.log(`\nAll ${results.length} checks green in ${elapsed}s.`);
  process.exit(0);
}

console.log('');
for (const f of failures) {
  console.log(`--- FAIL ${f.id}: ${f.title} (first expected to pass in phase ${f.phase})`);
  if (f.detail) console.log(f.detail);
  console.log('');
}

// the expected-red set comes from the same list, so it cannot drift like a prose note
const byPhase = new Map();
for (const f of failures) byPhase.set(f.phase, (byPhase.get(f.phase) ?? 0) + 1);
const phaseSummary = [...byPhase.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([p, n]) => `${n} from phase ${p}`)
  .join(', ');

console.log(`${failures.length} of ${results.length} checks failing (${phaseSummary}) in ${elapsed}s.`);
console.log(`Top failure: check ${failures[0].id} — ${failures[0].title}`);
process.exit(1);
