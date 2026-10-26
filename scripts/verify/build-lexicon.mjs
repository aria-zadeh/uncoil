#!/usr/bin/env node
// compiles services/lexicon/*.txt into services/lexicon.generated.ts. the .txt files
// are the single source: train/validate.py reads them, metro cannot. --check only verifies
import { readFileSync, writeFileSync } from 'node:fs';

const SOURCES = [
  { file: 'services/lexicon/imperative-verbs.txt', constant: 'IMPERATIVE_VERBS' },
  { file: 'services/lexicon/vague-verbs.txt', constant: 'VAGUE_PHRASES' },
  { file: 'services/lexicon/common-capitalized.txt', constant: 'COMMON_CAPITALIZED' },
  { file: 'services/lexicon/stopwords.txt', constant: 'STOPWORDS' },
];

const OUT = 'services/lexicon.generated.ts';

function entries(file) {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

const blocks = SOURCES.map(({ file, constant }) => {
  const list = entries(file);
  const seen = new Set();
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) {
      console.error(`${file}: duplicate entry ${JSON.stringify(item)}`);
      process.exit(1);
    }
    seen.add(key);
  }
  const body = list.map((v) => `  ${JSON.stringify(v)},`).join('\n');
  return `/** Generated from ${file}. ${list.length} entries. */\nexport const ${constant}: readonly string[] = [\n${body}\n];`;
});

const generated = `/**
 * GENERATED FILE. Do not edit.
 *
 * Source of truth is services/lexicon/*.txt, which train/validate.py reads
 * directly. Regenerate with: node scripts/verify/build-lexicon.mjs
 * The gate runs this with --check, so an edit here fails the build.
 */

${blocks.join('\n\n')}
`;

const check = process.argv.includes('--check');

if (check) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error(`${OUT} is missing. Run: node scripts/verify/build-lexicon.mjs`);
    process.exit(1);
  }
  if (current.replace(/\r\n/g, '\n') !== generated) {
    console.error(`${OUT} is out of date with services/lexicon/*.txt.`);
    console.error('Run: node scripts/verify/build-lexicon.mjs');
    process.exit(1);
  }
  console.log('lexicon: generated module matches its source.');
  process.exit(0);
}

writeFileSync(OUT, generated, 'utf8');
console.log(`wrote ${OUT}`);
