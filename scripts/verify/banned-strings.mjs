#!/usr/bin/env node
// banned strings: medical claims, monetization, network calls and URL literals.
// network-url is its own tag so a file that only quotes a URL can be exempt
// without also being exempt from real calls. scope and exemptions live in scan-scope.mjs
import { readFileSync } from 'node:fs';
import { scanTargets } from './walk.mjs';
import { exemptFrom } from './scan-scope.mjs';

// medical claims come in tiers. tier 1 applies everywhere. tier 2, the broader
// clinical vocabulary, applies to user-facing copy only: "treats a partial outcome
// as neutral" is ordinary technical english in code, and a rule that flags it gets relaxed
const COPY_SURFACES = ['app/', 'components/', 'app.json', 'README.md'];

function isCopySurface(rel) {
  return COPY_SURFACES.some((prefix) => rel === prefix || rel.startsWith(prefix));
}

// the training corpus is text about school assignments, where an advertisement is a
// normal topic. only rules marked `notInCorpus` are skipped there; purchase-path
// phrases and ad SDK names still apply, since a sample teaching those is a real defect
const CORPUS = ['train/data_sources/', 'train/data/'];

function isCorpus(rel) {
  return CORPUS.some((prefix) => rel.startsWith(prefix));
}

const RULES = [
  // tier 1: a medical claim in any context
  { rule: 'medical', re: /\b(?:therapy|therapeutic|therapist)\b/i },
  { rule: 'medical', re: /\b(?:medication|prescription|prescribed)\b/i },
  { rule: 'medical', re: /\bclinical(?:ly)?\b/i },
  { rule: 'medical', re: /\b(?:treats?|treating|treatment|manage|manages|managing|improve|improves|improving|reduce|reduces|reducing|cure|cures)\s+(?:your\s+|the\s+)?(?:ADHD|attention\s+deficit|executive\s+dysfunction|symptoms?|disorder|condition)\b/i },
  { rule: 'medical', re: /\bADHD\s+(?:symptoms?|treatment|management|medication)\b/i },
  { rule: 'medical', re: /\bexecutive\s+dysfunction\b/i },
  { rule: 'medical', re: /\bdiagnos(?:e|es|ed|ing|is)\b/i },

  // tier 2: clinical vocabulary, user-facing copy only
  { rule: 'medical', copyOnly: true, re: /\b(?:treats?|treating|treatment)\b/i },
  { rule: 'medical', copyOnly: true, re: /\b(?:symptoms?|patients?|disorder|remedy|cures?)\b/i },
  { rule: 'medical', copyOnly: true, re: /\bdiagnostic\b/i },

  // tier 3, corpus only: phrases addressed to the reader about their own condition.
  // bare nouns there were all ordinary english ("treats it as", dog treats, a biology
  // case study)
  { rule: 'medical', corpusOnly: true, re: /\byour\s+(?:symptoms?|treatment|therapy|condition|disorder|diagnosis|medication)\b/i },
  { rule: 'medical', corpusOnly: true, re: /\b(?:treatment|therapy|care|medication)\s+plan\b/i },
  // phrase shapes, not a bare `cures`: "the epoxy cures in twenty minutes" is fine
  { rule: 'medical', corpusOnly: true, re: /\bcures?\s+(?:your|the)\b/i },
  { rule: 'medical', corpusOnly: true, re: /\ba\s+cure\s+for\b/i },
  {
    rule: 'medical',
    corpusOnly: true,
    re: /\b(?:manages?|managing|eases?|easing|relieves?|relieving|improves?|improving|reduces?|reducing|alleviates?|alleviated|alleviating|boosts?|boosted|boosting|sharpens?|sharpened|sharpening|fixes|fixed|fixing)\s+(?:your\s+|the\s+)?(?:symptoms?|condition|disorder|focus|adhd|attention(?:\s+span)?|concentration|executive\s+function|hyperactivity|impulsivity)\b/i,
  },
  {
    rule: 'medical',
    corpusOnly: true,
    re: /\bhelp(?:s|ed|ing)\s+(?:you\s+)?(?:with|manage|control)\s+(?:your\s+|the\s+)?(?:symptoms?|condition|disorder|focus|adhd|attention(?:\s+span)?|concentration|executive\s+function|hyperactivity|impulsivity)\b/i,
  },
  { rule: 'medical', corpusOnly: true, re: /\bremedy\s+for\b/i },
  { rule: 'medical', corpusOnly: true, re: /\bsymptom\s+relief\b/i },

  // monetization: commerce vocabulary only. a bare "subscribe" ban was dropped because
  // zustand, AppState and executorch all spell their APIs `subscribe`
  { rule: 'monetization', re: /\bin-?app\s+purchase\b/i },
  { rule: 'monetization', re: /\bsubscription\s+(?:plan|tier|price|status|product|group|offer)\b/i },
  { rule: 'monetization', re: /\bauto-?renew(?:able|ing)\b/i },
  { rule: 'monetization', re: /\brestore\s+purchases?\b/i },
  { rule: 'monetization', re: /\bupgrade\s+to\s+(?:pro|premium|plus)\b/i },
  { rule: 'monetization', re: /\bpaywall\b/i },
  { rule: 'monetization', re: /\bpremium\s+(?:tier|plan|feature|features|version|user|users)\b/i },
  { rule: 'monetization', re: /\bpro\s+(?:tier|plan|version)\b/i },
  { rule: 'monetization', re: /\b(?:storekit|revenuecat|admob|applovin|superwall)\b/i },
  { rule: 'monetization', re: /\bentitlements?\s+check\b/i },
  { rule: 'monetization', re: /\bmonetiz(?:e|ed|ing|ation)\b/i },
  // ad infrastructure, corpus included
  { rule: 'monetization', re: /\b(?:ad\s+network|interstitial\s+ad|banner\s+ad|rewarded\s+ad|ad\s+unit|ad\s+revenue|advertising\s+identifier)\b/i },
  // bare nouns, skipped only in the corpus. no word boundaries on purpose: in code they
  // are camelCase (`getAdvertisingIdentifier`), and neither stem sits inside an innocent word
  { rule: 'monetization', notInCorpus: true, re: /(?:advertisement|advertising)/i },
  { rule: 'monetization', re: /\bfree\s+trial\b/i },

  // network
  { rule: 'network-call', re: /\bfetch\s*\(/ },
  { rule: 'network-call', re: /\b(?:axios|XMLHttpRequest|WebSocket|EventSource)\b/ },
  { rule: 'network-call', re: /navigator\.sendBeacon/ },
  { rule: 'network-url', re: /\bhttps?:\/\/[a-z0-9.-]+/i },
  { rule: 'network-call', re: /\brequire\s*\(\s*['"](?:node:)?(?:http|https|net|tls|dgram|dns)['"]\s*\)/ },
  { rule: 'network-call', re: /\bfrom\s+['"](?:node:)?(?:http|https|net|tls|dgram|dns)['"]/ },
];

const root = process.cwd();
const targets = scanTargets(root);
const violations = [];
// a listed file can fail to read (deleted, index not caught up), so count only what was opened
let scanned = 0;

for (const rel of targets) {
  let text;
  try {
    text = readFileSync(rel, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;
  const lines = text.split(/\r?\n/);
  for (const { rule, re, copyOnly, corpusOnly, notInCorpus } of RULES) {
    if (exemptFrom(rel, rule)) continue;
    if (copyOnly && !isCopySurface(rel)) continue;
    if (corpusOnly && !isCorpus(rel)) continue;
    if (notInCorpus && isCorpus(rel)) continue;
    lines.forEach((line, i) => {
      const m = line.match(re);
      if (m) {
        violations.push({ rel, line: i + 1, rule, match: m[0], text: line.trim().slice(0, 120) });
      }
    });
  }
}

// a dependency is the hardest evidence of a purchase path and cannot be a false positive
const DENIED_PACKAGES = [
  /^react-native-iap$/,
  /^expo-in-app-purchases$/,
  /^react-native-purchases/,
  /^@revenuecat\//,
  /^react-native-billing/,
  /^expo-store-review$/,
  /^react-native-google-mobile-ads$/,
  /^react-native-admob/,
  /^@react-native-firebase\/analytics$/,
  /^@sentry\//,
  /^@amplitude\//,
  /^posthog-react-native$/,
  /^@segment\//,
  /^mixpanel-react-native$/,
  /^@supabase\//,
  /^axios$/,
  /^expo-secure-store$/,
  /^react-native-web$/,
];

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const field of ['dependencies', 'devDependencies']) {
  for (const name of Object.keys(pkg[field] ?? {})) {
    const hit = DENIED_PACKAGES.find((re) => re.test(name));
    if (hit) {
      violations.push({
        rel: 'package.json',
        line: 0,
        rule: 'monetization',
        match: name,
        text: `${field} contains a disqualified package: ${name}`,
      });
    }
  }
}

if (violations.length === 0) {
  console.log(`banned-strings: clean across ${scanned} files.`);
  process.exit(0);
}

for (const v of violations) {
  console.error(`${v.rel}:${v.line}  [${v.rule}] ${JSON.stringify(v.match)}`);
  console.error(`    ${v.text}`);
}
console.error('');
console.error(`${violations.length} banned-string violations across ${new Set(violations.map((v) => v.rel)).size} files.`);
process.exit(1);
