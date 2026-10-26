#!/usr/bin/env node
// runs one check for the dev loop. always exits 0, so it cannot be wired into CI or
// mistaken for `npm run verify`
import { CHECKS } from './checks.mjs';

const arg = process.argv[2];
if (!arg) {
  console.log('usage: npm run check <id>\n');
  for (const c of CHECKS) console.log(`  ${String(c.id).padStart(2)}  (phase ${c.phase})  ${c.title}`);
  process.exit(0);
}

const check = CHECKS.find((c) => String(c.id) === String(arg));
if (!check) {
  console.error(`no check with id ${arg}. Run "npm run check" to list them.`);
  process.exit(0);
}

console.log(`NOT THE GATE — single check. Run "npm run verify" for the real thing.\n`);
console.log(`[${check.id}] ${check.title}`);

let outcome;
try {
  outcome = await check.run();
} catch (err) {
  outcome = { ok: false, detail: `check threw: ${err?.stack ?? err}` };
}

console.log(outcome.ok ? '\nPASS' : '\nFAIL');
if (!outcome.ok && outcome.detail) console.log(outcome.detail);
process.exit(0);
