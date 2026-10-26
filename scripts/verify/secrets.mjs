#!/usr/bin/env node
// no JWTs, API keys, tokens, private keys or bare hostnames in tracked files. walks
// `git ls-files` because this is about what the repo publishes, not what is on disk.
// exemptions live in scan-scope.mjs
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';
import { exemptFrom, SCAN_EXTS } from './scan-scope.mjs';

const CREDENTIAL_RULES = [
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'sk- secret key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  // no leading \b, so `npmAuthToken: "..."` matches at the camelCase hump. the optional
  // quote before the separator lets it match JSON keys like `"authToken": "value"`.
  // it still demands a quoted 12+ char literal, which keeps ordinary prose out
  { name: 'assigned secret literal', re: /(?:api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b["']?\s*[:=]\s*['"][^'"\s]{12,}['"]/i },
  { name: 'Expo public env var', re: /\bEXPO_PUBLIC_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|URL)\b/ },
  // ini/npmrc form, unquoted: `_authToken=value`. the value has to look like a credential
  // (16+ chars with a digit and a letter, or a known token prefix) so identifiers like
  // `const token = process.env.NPM_TOKEN` pass. `.` and `()` are outside the charset
  {
    name: 'ini/env-style credential literal',
    re: /(?:_authToken|_auth|password|token|secret|api[_-]?key)\s*=\s*(?:(?=[A-Za-z0-9_/+=-]*[0-9])(?=[A-Za-z0-9_/+=-]*[A-Za-z])[A-Za-z0-9_/+=-]{16,}|(?:npm_|ghp_|gho_|github_pat_|sk-|AKIA|xox[abp]-|eyJ)[A-Za-z0-9_/+=-]*)\b/i,
  },
  // .netrc has no `=`. extensionless files only, since "password" followed by a word is
  // common prose
  {
    name: 'netrc-style password literal',
    extensionlessOnly: true,
    re: /\bpassword\s+(?:(?=[A-Za-z0-9_/+=-]*[0-9])(?=[A-Za-z0-9_/+=-]*[A-Za-z])[A-Za-z0-9_/+=-]{12,}|(?:npm_|ghp_|gho_|github_pat_|sk-|AKIA|xox[abp]-|eyJ)[A-Za-z0-9_/+=-]*)\b/i,
  },
  // the npm token prefix alone, for places the keyword rules do not reach
  { name: 'npm auth token', re: /\bnpm_[A-Za-z0-9]{30,}/ },
];

// a bare hostname is a destination even without a scheme; the scheme form is
// banned-strings.mjs's job
const HOSTNAME_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|co|dev|app|ai|cloud|sh|me|xyz|gg|to|link)\b/i;

// identifiers in this codebase or its toolchain that look like hostnames
const HOSTNAME_FALSE_POSITIVES = [
  /^schema\.org$/i,
  /^example\.com$/i,
  // `migration.to` in data/migrations.ts. matched exactly so a real `.to` host still fails
  /^migration\.to$/i,
  // pytorch's `model.to(device)`. exact matches only: a suffix match let `evil.model.to` through
  /^model\.to$/i,
  /^self\.model\.to$/i,
  // the socket.io-client package name, which denylists mention
  /^socket\.io$/i,
];

const root = process.cwd();

const ls = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (ls.status !== 0) {
  console.error('git ls-files failed; cannot enumerate tracked files.');
  console.error(ls.stderr);
  process.exit(1);
}

const tracked = ls.stdout.split(/\r?\n/).filter(Boolean);
const violations = [];

// a tracked env file or signing key fails regardless of contents
for (const rel of tracked) {
  const base = rel.split('/').pop() ?? rel;
  if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) {
    violations.push({ rel, line: 0, kind: 'tracked env file', match: rel });
  }
  if (/\.(?:p8|p12|pem|jks|key|mobileprovision|keystore)$/i.test(base)) {
    violations.push({ rel, line: 0, kind: 'tracked signing material', match: rel });
  }
}

let scanned = 0;
for (const rel of tracked) {
  // extensionless files (.npmrc, .netrc, Dockerfile) are where pasted credentials land
  const ext = extname(rel);
  if (ext !== '' && !SCAN_EXTS.has(ext)) continue;
  let size;
  try {
    size = statSync(rel).size;
  } catch {
    continue;
  }
  if (size > 2 * 1024 * 1024) continue; // committed data files, checked by shape elsewhere

  let text;
  try {
    text = readFileSync(rel, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    for (const { name, re, extensionlessOnly } of CREDENTIAL_RULES) {
      if (exemptFrom(rel, 'secrets')) break;
      if (extensionlessOnly && ext !== '') continue;
      const m = line.match(re);
      if (m) violations.push({ rel, line: i + 1, kind: name, match: m[0].slice(0, 40) });
    }
    // a network exemption is no license for a bare hostname. only a 'secrets' exemption
    // or the narrow 'hostname' one skips this
    if (!exemptFrom(rel, 'secrets') && !exemptFrom(rel, 'hostname')) {
      const h = line.match(HOSTNAME_RE);
      if (h && !HOSTNAME_FALSE_POSITIVES.some((fp) => fp.test(h[0]))) {
        violations.push({ rel, line: i + 1, kind: 'hostname', match: h[0] });
      }
    }
  });
}

if (violations.length === 0) {
  console.log(`secrets: clean across ${scanned} tracked text files.`);
  process.exit(0);
}

for (const v of violations) {
  console.error(`${v.rel}:${v.line}  [${v.kind}] ${JSON.stringify(v.match)}`);
}
console.error('');
console.error(`${violations.length} secret/hostname violations across ${new Set(violations.map((v) => v.rel)).size} tracked files.`);
process.exit(1);
