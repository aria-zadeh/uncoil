#!/usr/bin/env node
// keeps the redesign from drifting in app/ and components/: no color literals (only
// utils/palette.cjs has them), no deleted v1 primitives, no fontFamily string outside
// the families tailwind.config.js registers, and no Alert.alert. that last one
// duplicates the eslint rule on purpose, in case the rule is ever loosened
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tailwind from '../../tailwind.config.js';
import { walk } from './walk.mjs';

const ROOT = process.cwd();

// read from tailwind.config.js so the two cannot drift
function allowedFontFamilies() {
  const families = tailwind.theme?.extend?.fontFamily ?? {};
  const names = new Set();
  for (const value of Object.values(families)) {
    for (const name of Array.isArray(value) ? value : [value]) names.add(name);
  }
  return names;
}
const ALLOWED_FAMILIES = allowedFontFamilies();

const DELETED_PRIMITIVES = ['StarterActionCard', 'Badge', 'IconButton'];

const COMPONENT_EXTS = ['.tsx', '.jsx', '.js'];

// hsl( is what palette.cjs is written in, which is why it must never appear elsewhere
const COLOR_RULES = [
  { kind: 'hex colour literal', re: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g },
  { kind: 'rgb( colour literal', re: /\brgb\(/g },
  { kind: 'rgba( colour literal', re: /\brgba\(/g },
  { kind: 'hsl( colour literal', re: /\bhsl\(/g },
];

const FONT_FAMILY_RE = /\bfontFamily\s*:\s*(["'`])([^"'`]*)\1/g;
const ALERT_RE = /\bAlert\s*\.\s*alert\s*\(/g;

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function scanFile(rel, source, violations) {
  for (const { kind, re } of COLOR_RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      violations.push({ rel, line: lineOf(source, m.index), kind, detail: m[0] });
    }
  }

  for (const name of DELETED_PRIMITIVES) {
    const re = new RegExp(`\\b${name}\\b`, 'g');
    let m;
    while ((m = re.exec(source)) !== null) {
      violations.push({
        rel,
        line: lineOf(source, m.index),
        kind: 'deleted primitive reappeared',
        detail: `${name} (docs/REDESIGN.md section 4.3: deleted, replaced in v2)`,
      });
    }
  }

  FONT_FAMILY_RE.lastIndex = 0;
  let fm;
  while ((fm = FONT_FAMILY_RE.exec(source)) !== null) {
    const family = fm[2];
    if (!ALLOWED_FAMILIES.has(family)) {
      violations.push({
        rel,
        line: lineOf(source, fm.index),
        kind: 'non-Inter fontFamily literal',
        detail: `"${family}" is not one of: ${[...ALLOWED_FAMILIES].join(', ')}`,
      });
    }
  }

  ALERT_RE.lastIndex = 0;
  let am;
  while ((am = ALERT_RE.exec(source)) !== null) {
    violations.push({
      rel,
      line: lineOf(source, am.index),
      kind: 'Alert.alert',
      detail: 'Use the Modal component (already banned by eslint.config.js no-restricted-syntax; checked again here)',
    });
  }
}

const files = [];
for (const dir of ['app', 'components']) walk(join(ROOT, dir), ROOT, files);
const targets = files.filter((f) => COMPONENT_EXTS.some((ext) => f.endsWith(ext)));

const violations = [];
let scanned = 0;
for (const rel of targets) {
  let source;
  try {
    source = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  scanned += 1;
  scanFile(rel, source, violations);
}

if (violations.length === 0) {
  console.log(`design-baseline: clean across ${scanned} files under app/ and components/.`);
  process.exit(0);
}

for (const v of violations) {
  console.error(`${v.rel}:${v.line}  [${v.kind}] ${v.detail}`);
}
console.error('');
const byKind = new Map();
for (const v of violations) byKind.set(v.kind, (byKind.get(v.kind) ?? 0) + 1);
for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
  console.error(`  ${String(count).padStart(4)}  ${kind}`);
}
console.error(`\n${violations.length} pre-redesign / off-token violations across ${new Set(violations.map((v) => v.rel)).size} files.`);
process.exit(1);
