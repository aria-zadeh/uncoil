import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { VENV_PYTHON } from '../helpers/venv';

import {
  buildBreakdownPrompt,
  buildExtractionPrompt,
  buildRepairPrompt,
  buildSimplifyPrompt,
  relativeDuePhrase,
  type Weekday,
} from '@/services/prompt';

// the app's prompt builder and train/prompt.py must emit byte-identical strings, or the model
// trains on a format it never sees in the app

const FIXTURE_PATH = '__tests__/fixtures/prompt-parity.json';

interface PromptFixture {
  id: string;
  kind: 'breakdown' | 'extraction' | 'simplify' | 'repair' | 'duePhrase';
  title?: string;
  subject?: string | null;
  description?: string | null;
  duePhrase?: string;
  sessionMinutes?: number;
  text?: string;
  today?: Weekday;
  reason?: string;
  days?: number;
}

interface Emitted {
  id: string;
  system: string;
  user: string;
}

const fixtures = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as PromptFixture[];

function typescriptSide(fixture: PromptFixture): Emitted {
  switch (fixture.kind) {
    case 'breakdown': {
      const built = buildBreakdownPrompt({
        title: fixture.title ?? '',
        subject: fixture.subject ?? null,
        description: fixture.description ?? null,
        duePhrase: fixture.duePhrase ?? '',
        sessionMinutes: fixture.sessionMinutes ?? 30,
      });
      return { id: fixture.id, ...built };
    }
    case 'extraction':
      return {
        id: fixture.id,
        ...buildExtractionPrompt(fixture.text ?? '', fixture.today ?? 'Monday'),
      };
    case 'simplify':
      return {
        id: fixture.id,
        ...buildSimplifyPrompt({
          title: fixture.title ?? '',
          description: fixture.description ?? null,
        }),
      };
    case 'repair': {
      const base = buildBreakdownPrompt({
        title: fixture.title ?? '',
        subject: fixture.subject ?? null,
        description: fixture.description ?? null,
        duePhrase: fixture.duePhrase ?? '',
        sessionMinutes: fixture.sessionMinutes ?? 30,
      });
      return { id: fixture.id, ...buildRepairPrompt(base, fixture.reason ?? '') };
    }
    case 'duePhrase':
      return { id: fixture.id, system: '', user: relativeDuePhrase(fixture.days ?? 0) };
    default: {
      const exhaustive: never = fixture.kind;
      throw new Error(`unknown fixture kind: ${String(exhaustive)}`);
    }
  }
}

describe('prompt parity: TypeScript against train/prompt.py', () => {
  it('has at least the 50 fixtures the gate requires', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(50);
  });

  it('the training venv exists', () => {
    // fail instead of skip, so parity never runs against whatever python happens to be installed
    expect(
      existsSync(VENV_PYTHON),
      `training venv missing at ${VENV_PYTHON}. See NOTES/phase-2-training.md.`,
    ).toBe(true);
  });

  it('emits byte-identical strings for every fixture', () => {
    const proc = spawnSync(VENV_PYTHON, ['scripts/verify/emit_python_outputs.py', 'prompts', FIXTURE_PATH], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(proc.status, `python failed:\n${proc.stderr}`).toBe(0);

    const pythonSide = JSON.parse(proc.stdout) as Emitted[];
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
      // compare raw strings: json.dumps and JSON.stringify differ on separators and escaping
      if (ts.system !== py.system) {
        mismatches.push(
          `${fixture.id} system:\n  ts: ${JSON.stringify(ts.system)}\n  py: ${JSON.stringify(py.system)}`,
        );
      }
      if (ts.user !== py.user) {
        mismatches.push(
          `${fixture.id} user:\n  ts: ${JSON.stringify(ts.user)}\n  py: ${JSON.stringify(py.user)}`,
        );
      }
    }

    expect(mismatches.join('\n\n')).toBe('');
  });
});
