import { describe, expect, it } from 'vitest';

import { classify, forTask, type TemplatePattern } from '@/services/templates';
import { validateBreakdown } from '@/services/validation';
import { BREAKDOWN_LIMITS, type BreakdownInput } from '@/types';

function input(overrides: Partial<BreakdownInput> = {}): BreakdownInput {
  return {
    title: 'Untitled assignment',
    subject: null,
    description: null,
    duePhrase: 'in 3 days',
    sessionMinutes: 30,
    ...overrides,
  };
}

const CLASSIFICATION: [string, TemplatePattern][] = [
  ['Write a 5-paragraph essay on the causes of the Civil War', 'writing'],
  ['Lab report on titration', 'writing'],
  ['Reading response for chapters 4 to 6', 'writing'],
  ['Annotated bibliography', 'writing'],
  ['Read chapters 4 through 6', 'reading'],
  ['Finish the novel', 'reading'],
  ['Article annotation', 'reading'],
  ['Chapter 7 problem set', 'problem_set'],
  ['Algebra worksheet', 'problem_set'],
  ['Geometry packet', 'problem_set'],
  ['Study for the unit test', 'study'],
  ['Biology quiz on Friday', 'study'],
  ['Make a review sheet', 'study'],
  ['Memorize the vocab list', 'study'],
  ['Group project on the water cycle', 'project'],
  ['Presentation slides', 'project'],
  ['Build a poster', 'project'],
  ['Turn in the permission slip', 'generic'],
  ['Bring gym clothes', 'generic'],
];

describe('classify', () => {
  for (const [title, expected] of CLASSIFICATION) {
    it(`routes ${JSON.stringify(title)} to ${expected}`, () => {
      expect(classify(input({ title }))).toBe(expected);
    });
  }

  it('matches on the subject and description too, not only the title', () => {
    expect(classify(input({ title: 'Unit 3', subject: 'Algebra II' }))).toBe('problem_set');
    expect(classify(input({ title: 'Unit 3', description: 'Read the article first' }))).toBe(
      'reading',
    );
  });

  it('is case insensitive', () => {
    expect(classify(input({ title: 'WRITE AN ESSAY' }))).toBe('writing');
  });
});

describe('forTask output passes the same validator as model output', () => {
  // the eval harness scores templates with this validator as a baseline, so a rejected template is a bug
  const sessions = [5, 15, 20, 30, 45, 60, 90, 120, 180];

  for (const [title, pattern] of CLASSIFICATION) {
    for (const sessionMinutes of sessions) {
      it(`${pattern} at a ${sessionMinutes} minute session is valid`, () => {
        const task = input({ title, sessionMinutes });
        const breakdown = forTask(task);
        const result = validateBreakdown(JSON.stringify(breakdown), task);
        if (!result.ok) {
          throw new Error(
            `${pattern} @${sessionMinutes}m rejected: ${result.rejection.code} — ${result.rejection.reason}\n${JSON.stringify(breakdown, null, 2)}`,
          );
        }
        expect(result.ok).toBe(true);
      });
    }
  }
});

describe('forTask, structural guarantees', () => {
  const cases = CLASSIFICATION.map(([title]) => title);

  it('always produces between 3 and 7 steps', () => {
    for (const title of cases) {
      for (const sessionMinutes of [5, 30, 180]) {
        const steps = forTask(input({ title, sessionMinutes })).steps;
        expect(steps.length).toBeGreaterThanOrEqual(BREAKDOWN_LIMITS.minSteps);
        expect(steps.length).toBeLessThanOrEqual(BREAKDOWN_LIMITS.maxSteps);
      }
    }
  });

  it('keeps every step inside the minute bounds', () => {
    for (const title of cases) {
      for (const sessionMinutes of [5, 30, 180]) {
        for (const step of forTask(input({ title, sessionMinutes })).steps) {
          expect(step.minutes).toBeGreaterThanOrEqual(BREAKDOWN_LIMITS.minMinutes);
          expect(step.minutes).toBeLessThanOrEqual(BREAKDOWN_LIMITS.maxMinutes);
          expect(Number.isInteger(step.minutes)).toBe(true);
        }
      }
    }
  });

  it('keeps the total inside 15 to 300 minutes even at an extreme session length', () => {
    for (const title of cases) {
      for (const sessionMinutes of [1, 5, 240, 600]) {
        const total = forTask(input({ title, sessionMinutes })).steps.reduce(
          (sum, s) => sum + s.minutes,
          0,
        );
        expect(total).toBeGreaterThanOrEqual(BREAKDOWN_LIMITS.minTotalMinutes);
        expect(total).toBeLessThanOrEqual(BREAKDOWN_LIMITS.maxTotalMinutes);
      }
    }
  });

  it('names a first step that is physically startable, never a decision', () => {
    for (const title of cases) {
      const first = forTask(input({ title })).steps[0].title.toLowerCase();
      for (const vague of ['plan', 'think about', 'decide', 'brainstorm', 'figure out', 'get ready']) {
        expect(first).not.toContain(vague);
      }
    }
  });

  it('restates the first step as the starter action', () => {
    for (const title of cases) {
      const breakdown = forTask(input({ title }));
      expect(breakdown.starterAction).toBe(breakdown.steps[0].title);
    }
  });

  it('is deterministic', () => {
    for (const title of cases) {
      expect(forTask(input({ title }))).toEqual(forTask(input({ title })));
    }
  });

  it('introduces no proper noun, so it is valid for any assignment title', () => {
    // the hallucination check compares against the assignment text, so naming a book or
    // teacher would fail for inputs that do not mention it
    for (const title of cases) {
      const task = input({ title: 'x', subject: null, description: null, sessionMinutes: 30 });
      const breakdown = forTask(input({ title }));
      const result = validateBreakdown(JSON.stringify(breakdown), task);
      expect(result.ok).toBe(true);
    }
  });
});

describe('forTask, adversarial assignment input', () => {
  const adversarial = [
    '',
    'a',
    '\u{1F600}',
    'qx9 '.repeat(125),
    '寿司の宿題',
    'Sign the permission slip',
    'this damn essay',
    '   ',
    '!!!???',
  ];

  for (const title of adversarial) {
    it(`produces a valid breakdown for ${JSON.stringify(title.slice(0, 24))}`, () => {
      const task = input({ title, sessionMinutes: 30 });
      const breakdown = forTask(task);
      const result = validateBreakdown(JSON.stringify(breakdown), task);
      expect(result.ok).toBe(true);
    });
  }

  it('handles a zero or negative session length', () => {
    for (const sessionMinutes of [0, -30, Number.NaN]) {
      const task = input({ title: 'Write an essay', sessionMinutes });
      const result = validateBreakdown(JSON.stringify(forTask(task)), task);
      expect(result.ok).toBe(true);
    }
  });
});
