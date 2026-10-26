import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SMOLLM2_LICENSE_TEXT } from '@/assets/model/license';

const TXT_PATH = 'assets/model/LICENSE-SmolLM2.txt';
const TS_PATH = 'assets/model/license.ts';

// so a checkout with autocrlf on does not fail on line endings alone
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

describe('SmolLM2 Apache-2.0 license text', () => {
  // license.ts exists because nothing reads the .txt off disk on device yet
  it('matches assets/model/LICENSE-SmolLM2.txt exactly, so the two copies cannot drift', () => {
    const fromDisk = toLf(readFileSync(TXT_PATH, 'utf8'));
    const fromModule = toLf(SMOLLM2_LICENSE_TEXT);
    expect(fromModule).toBe(fromDisk);
  });

  it('is the real Apache License, Version 2.0', () => {
    expect(SMOLLM2_LICENSE_TEXT).toContain('Apache License');
    expect(SMOLLM2_LICENSE_TEXT).toContain('Version 2.0');
  });

  // the scan-scope exemption that lets the license URL through would also let a real
  // network call through in this file, so check for one here
  it('contains no real network call in assets/model/license.ts, only the license URL as prose', () => {
    const source = readFileSync(TS_PATH, 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\b(?:axios|XMLHttpRequest|WebSocket|EventSource)\b/);
    expect(source).not.toMatch(/navigator\.sendBeacon/);
  });
});
