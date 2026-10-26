import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { VENV_PYTHON } from '../helpers/venv';

import {
  validateBreakdown,
  validateExtraction,
  validateSimplification,
} from '@/services/validation';
import type { BreakdownInput, SimplifyInput } from '@/types';

// services/validation.ts and train/validate.py must agree: the python side filters training
// samples and scores evals. the corpus leans on what a small model really emits (fences, preambles, truncation)

const FIXTURE_PATH = '__tests__/fixtures/validator-parity.json';

interface ValidatorFixture {
  id: string;
  kind: 'breakdown' | 'extraction' | 'simplification';
  raw: string;
  task: { title?: string; subject?: string | null; description?: string | null } | null;
}

interface Verdict {
  id: string;
  ok: boolean;
  code: string;
  reason: string;
}

const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ValidatorFixture[];

function typescriptSide(fixture: ValidatorFixture): Verdict {
  const task = fixture.task ?? {};
  if (fixture.kind === 'breakdown') {
    const input: BreakdownInput = {
      title: task.title ?? '',
      subject: task.subject ?? null,
      description: task.description ?? null,
      duePhrase: 'in 3 days',
      sessionMinutes: 30,
    };
    const r = validateBreakdown(fixture.raw, input);
    return r.ok
      ? { id: fixture.id, ok: true, code: 'ok', reason: '' }
      : { id: fixture.id, ok: false, code: r.rejection.code, reason: r.rejection.reason };
  }
  if (fixture.kind === 'extraction') {
    const r = validateExtraction(fixture.raw);
    return r.ok
      ? { id: fixture.id, ok: true, code: 'ok', reason: '' }
      : { id: fixture.id, ok: false, code: r.rejection.code, reason: r.rejection.reason };
  }
  const input: SimplifyInput = {
    title: task.title ?? '',
    description: task.description ?? null,
  };
  const r = validateSimplification(fixture.raw, input);
  return r.ok
    ? { id: fixture.id, ok: true, code: 'ok', reason: '' }
    : { id: fixture.id, ok: false, code: r.rejection.code, reason: r.rejection.reason };
}

describe('validator parity: TypeScript against train/validate.py', () => {
  it('has at least the 200 fixtures the gate requires', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(200);
  });

  it('includes malformed input, not only well-formed objects', () => {
    const malformed = fixtures.filter((f) => {
      try {
        JSON.parse(f.raw);
        return false;
      } catch {
        return true;
      }
    });
    expect(malformed.length).toBeGreaterThanOrEqual(20);
  });

  it('the training venv exists', () => {
    expect(
      existsSync(VENV_PYTHON),
      `training venv missing at ${VENV_PYTHON}. See NOTES/phase-2-training.md.`,
    ).toBe(true);
  });

  it('returns identical verdicts for every fixture', () => {
    const proc = spawnSync(
      VENV_PYTHON,
      ['scripts/verify/emit_python_outputs.py', 'verdicts', FIXTURE_PATH],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    expect(proc.status, `python failed:\n${proc.stderr}`).toBe(0);

    const pythonSide = JSON.parse(proc.stdout) as Verdict[];
    expect(pythonSide).toHaveLength(fixtures.length);

    const byId = new Map(pythonSide.map((p) => [p.id, p]));
    const mismatches: string[] = [];

    for (const fixture of fixtures) {
      const ts = typescriptSide(fixture);
      const py = byId.get(fixture.id);
      if (py === undefined) {
        mismatches.push(`${fixture.id}: missing from the Python output`);
        continue;
      }
      if (ts.ok !== py.ok || ts.code !== py.code || ts.reason !== py.reason) {
        mismatches.push(
          [
            `${fixture.id} (${fixture.kind})`,
            `  raw: ${JSON.stringify(fixture.raw.slice(0, 120))}`,
            `  ts:  ok=${ts.ok} code=${ts.code} reason=${JSON.stringify(ts.reason)}`,
            `  py:  ok=${py.ok} code=${py.code} reason=${JSON.stringify(py.reason)}`,
          ].join('\n'),
        );
      }
    }

    expect(mismatches.slice(0, 15).join('\n\n')).toBe('');
    expect(mismatches).toHaveLength(0);
  });
});
