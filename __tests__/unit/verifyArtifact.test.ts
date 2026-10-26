import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { matchArtifactToParity } from '../../scripts/verify/artifact.mjs';

// regression: a passing parity report was accepted no matter which .pte it described.
// a small temp file stands in for the real 90 MB artifact
describe('matchArtifactToParity', () => {
  let dir: string;
  let artifactPath: string;
  let hash: string;
  let size: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tether-artifact-test-'));
    artifactPath = join(dir, 'tether-135m-8da4w.pte');
    const bytes = Buffer.from('fixture artifact bytes, not the real model');
    writeFileSync(artifactPath, bytes);
    hash = createHash('sha256').update(bytes).digest('hex');
    size = bytes.byteLength;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails when the parity report describes a different artifact', () => {
    const report = {
      passed: true,
      artifact: { file_name: 'tether-135m-v4-noquant-hostparity.pte', sha256: '0'.repeat(64), bytes: 652053120 },
    };

    const outcome = matchArtifactToParity(artifactPath, report);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe(
      'parity report describes tether-135m-v4-noquant-hostparity.pte, not the bundled tether-135m-8da4w.pte',
    );
  });

  it('passes when the parity report describes the bundled artifact by hash and size', () => {
    const report = {
      passed: true,
      artifact: { file_name: 'tether-135m-8da4w.pte', sha256: hash, bytes: size },
    };

    const outcome = matchArtifactToParity(artifactPath, report);

    expect(outcome.ok).toBe(true);
  });

  it('fails when passed is not true, even if the hash matches', () => {
    const report = {
      passed: false,
      artifact: { file_name: 'tether-135m-8da4w.pte', sha256: hash, bytes: size },
    };

    const outcome = matchArtifactToParity(artifactPath, report);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('parity failed');
  });
});
