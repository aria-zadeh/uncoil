import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { OOM_ERROR_CODES } from '@/services/generation';

const ERROR_CODES_D_TS = 'node_modules/react-native-executorch/lib/typescript/errors/ErrorCodes.d.ts';

// generation.ts copies these codes instead of importing the library, so read the
// installed enum as text and fail if a version bump renumbers them
describe('OOM_ERROR_CODES stays in sync with the installed react-native-executorch', () => {
  const source = readFileSync(ERROR_CODES_D_TS, 'utf8');

  function enumValue(name: string): number {
    const match = new RegExp(`\\b${name}\\s*=\\s*(\\d+)`).exec(source);
    if (!match) {
      throw new Error(`${name} not found in ${ERROR_CODES_D_TS} -- has the enum been renamed?`);
    }
    return Number(match[1]);
  }

  it('MemoryAllocationFailed matches the installed enum', () => {
    expect(OOM_ERROR_CODES.has(enumValue('MemoryAllocationFailed'))).toBe(true);
  });

  it('DelegateMemoryAllocationFailed matches the installed enum', () => {
    expect(OOM_ERROR_CODES.has(enumValue('DelegateMemoryAllocationFailed'))).toBe(true);
  });

  it('contains exactly those two codes -- no stale or extra entries', () => {
    expect([...OOM_ERROR_CODES].sort((a, b) => a - b)).toEqual(
      [enumValue('MemoryAllocationFailed'), enumValue('DelegateMemoryAllocationFailed')].sort((a, b) => a - b),
    );
  });
});
