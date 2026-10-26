import { sep } from 'node:path';

// scope for the static scans (banned-strings.mjs and secrets.mjs), declared once
// with reasons, so it cannot quietly widen to make a check pass

export const SCAN_ROOTS = [
  'app',
  'components',
  'services',
  'store',
  'data',
  'types',
  'utils',
  '__tests__',
  'train',
  'assets',
  // tooling is source too: a network call or a pasted secret in a script is just as
  // real. only the two scanners get an exemption, below
  'scripts',
];

export const SCAN_FILES = [
  'app.json',
  'README.md',
  'metro.config.js',
  'babel.config.js',
  'tailwind.config.js',
  'eslint.config.js',
  'vitest.config.mts',
  'tsconfig.json',
];

export const SCAN_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.json', '.jsonl', '.md', '.txt', '.plist', '.yml', '.yaml',
]);

// an exemption is a decision, so each one carries its reason
export const EXEMPTIONS = [
  {
    match: (p) => p.startsWith('docs/'),
    rules: ['medical', 'monetization', 'network-call', 'network-url', 'secrets'],
    why: 'docs/ is the specification. RELEASE.md 3.1 must be able to name the forbidden medical terms in order to forbid them, docs/DECISIONS.md\'s own audit trail must name the network-call patterns and paste a control URL it ran and reverted, and ON_DEVICE_MODEL.md must cite Hugging Face URLs as sources.',
  },
  {
    match: (p) => p === 'README.md',
    rules: ['network-url', 'hostname'],
    why: 'The Hugging Face link is the attribution Apache-2.0 requires for the base model -- a URL literal, not an outgoing call. README is not app surface. Still scanned for medical and monetization terms, and for network-call.',
  },
  {
    // only the two scanners, not all of scripts/verify/. no network-url: the URL rule
    // escapes its slashes, so it never matches its own source
    match: (p) => p === 'scripts/verify/banned-strings.mjs' || p === 'scripts/verify/secrets.mjs',
    rules: ['medical', 'monetization', 'network-call', 'secrets'],
    why: 'The scanners necessarily contain the patterns they scan for.',
  },
  {
    match: (p) => p === 'services/contentFilter.ts',
    rules: ['medical'],
    why: "A filter must name the terms it blocks; same reasoning as banned-strings.mjs's own rule list.",
  },
  {
    match: (p) => p === '__tests__/integration/no-network.test.ts' || p.startsWith('__tests__/stubs/'),
    rules: ['network-call', 'network-url'],
    why: 'The no-network test must name the browser networking primitives (the request function and the request/socket constructors this rule forbids) and invoke the request function against a literal URL in order to assert it throws. It is still scanned for medical and monetization terms.',
  },
  {
    match: (p) => p === 'eslint.config.js',
    rules: ['network-call'],
    why: 'The no-restricted-globals/no-restricted-properties entries that enforce "zero network requests" (PRD.md 8) must name each network primitive and beacon-sending property this rule forbids, in order to forbid it.',
  },
  {
    match: (p) => /^train\/[^/]+\.(py|txt|md)$/.test(p),
    rules: ['network-url', 'hostname'],
    why: 'The training pipeline scripts and requirements file must cite the Hugging Face model and the PyTorch CPU index URL to be runnable. train/data_sources/ is deliberately NOT exempt: constraint 5 covers training data.',
  },
  {
    match: (p) => p === 'package-lock.json',
    // a dedicated tag, so the credential rules still run over the lockfile
    rules: ['network-url', 'hostname'],
    why: 'npm generates a resolved URL for every dependency and a funding URL for every package that declares one, so the lockfile carries the npm registry host, GitHub, OpenCollective and six more hosts roughly 1,457 times. They are generated, cannot be removed while the lockfile is committed, and are build tooling: Metro never reads this file and none of it reaches the app. A host allowlist was tried first and rejected -- npm rewrites funding URLs whenever a dependency changes, so the list would rot, and it would not have caught the one thing worth catching anyway, since a rogue registry appears in "resolved" exactly like a legitimate one. RESIDUAL GAP, stated rather than hidden: check 11 no longer looks at hosts in the lockfile at all. Supply-chain integrity is what the "integrity" hashes npm writes are for, and it was never what this check controlled. The credential rules DO still run over this file, so a token pasted into it is still caught -- there is a negative control for that. The app-level network prohibition is enforced by check 10 over SCAN_ROOTS and by the no-network runtime test, neither of which this touches.',
  },
  {
    match: (p) => p === 'assets/model/LICENSE-SmolLM2.txt',
    rules: ['network-url', 'secrets'],
    why: 'The Apache-2.0 license text contains the Apache Software Foundation license URL and must ship verbatim.',
  },
  {
    // the same license text as a TS string, since nothing reads the .txt at runtime.
    // never network-call, so a real request landing here still fails
    match: (p) => p === 'assets/model/license.ts',
    rules: ['network-url', 'hostname'],
    why: 'The Apache-2.0 text string module for the bundled SmolLM2 model (mirrors the LICENSE-SmolLM2.txt exemption above): the Apache Software Foundation license URL it carries twice is license prose being quoted verbatim, not an outgoing call. Scoped to \'network-url\' and the narrow \'hostname\' tag, never \'network-call\', so a real request landing in this file still fails check 10 -- confirmed by control (see the Reviewed note above and docs/DECISIONS.md (i)).',
  },
  {
    match: (p) => p === '__tests__/unit/license.test.ts',
    rules: ['network-call'],
    why: 'This test\'s own "no real network call" assertion must name the request call, the browser request constructors and the beacon-sending property in its regex literals in order to check assets/model/license.ts for their absence, the same structural reason banned-strings.mjs and secrets.mjs are exempted for defining those patterns as regexes in the first place.',
  },
  {
    match: (p) => p === 'scripts/verify/lfs-pointer.mjs' || p === 'scripts/verify/contrast.mjs',
    rules: ['network-url', 'hostname'],
    why: 'lfs-pointer.mjs\'s LFS_MAGIC constant is the literal Git LFS pointer header string, spelled out in full in that file, that the check matches pointer files against -- it is not a request destination, it is the file format signature. contrast.mjs cites the W3C WCAG 2.1 relative-luminance formula it implements. Both are one-line, load-bearing or documentary, not app surface.',
  },
  {
    // the tag name 'monetization' matches its own rule, so writing it here trips the
    // check. the other tag names do not, so this file is still scanned for them
    match: (p) => p === 'scripts/verify/scan-scope.mjs',
    rules: ['monetization'],
    why: 'The EXEMPTIONS array must write the literal tag string "monetization" to grant or withhold that exemption, which is the one rule-tag identifier that matches its own rule pattern.',
  },
];

export function exemptFrom(relPath, rule) {
  const p = relPath.split(sep).join('/');
  return EXEMPTIONS.some((e) => e.rules.includes(rule) && e.match(p));
}
