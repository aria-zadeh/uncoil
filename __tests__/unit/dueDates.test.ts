import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { findDuePhrases, reconcileDueDates, resolveDuePhrase, splitSentences } from '@/services/dueDates';
import type { Weekday } from '@/services/prompt';
import type { ExtractedTask } from '@/types';

const DUE_PHRASES_PATH = '__tests__/fixtures/due-phrases.json';
const DUE_RECONCILE_PATH = '__tests__/fixtures/due-reconcile.json';

interface DuePhraseCase {
  phrase: string;
  today: Weekday;
  lastDue: number | null;
  todayDate?: string;
  expected: number | null;
}

interface DueReconcileCase {
  name: string;
  text: string;
  today: Weekday;
  todayDate?: string;
  lastDue?: number | null;
  tasks: ExtractedTask[];
  expected: ExtractedTask[];
}

// local date, not `new Date(iso)`, so cases do not depend on the runner's timezone
function localDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

describe('resolveDuePhrase', () => {
  const { cases } = JSON.parse(readFileSync(DUE_PHRASES_PATH, 'utf8')) as { cases: DuePhraseCase[] };

  for (const c of cases) {
    it(`"${c.phrase}" on ${c.today} (lastDue ${c.lastDue}${c.todayDate ? `, todayDate ${c.todayDate}` : ''}) -> ${c.expected}`, () => {
      const todayDate = c.todayDate ? localDate(c.todayDate) : undefined;
      expect(resolveDuePhrase(c.phrase, c.today, c.lastDue, todayDate)).toBe(c.expected);
    });
  }
});

describe('reconcileDueDates', () => {
  const { cases } = JSON.parse(readFileSync(DUE_RECONCILE_PATH, 'utf8')) as { cases: DueReconcileCase[] };

  for (const c of cases) {
    it(c.name, () => {
      const todayDate = c.todayDate ? localDate(c.todayDate) : undefined;
      expect(reconcileDueDates(c.tasks, c.text, c.today, todayDate, c.lastDue ?? null)).toEqual(
        c.expected,
      );
    });
  }
});

// regression: a weekday plus a date more than a week out resolved to the nearest weekday.
// kept out of the shared fixtures since train/due_dates.py has no matching change
describe('weekday plus explicit date (Sat 2026-10-10)', () => {
  const today: Weekday = 'Saturday';
  const todayDate = localDate('2026-10-10');

  const resolveCases: [string, number][] = [
    ['Monday, October 19', 9],
    ['on Monday, October 19', 9],
    ['by Mon, Oct 19', 9],
    ['next Monday, October 19', 9],
    ['Fri 10/30', 20],
    ['on Fri 10/30', 20],
    ['Wednesday, October 14', 4],
    // oct 20 2026 is a tuesday, the explicit date still wins
    ['Monday, October 20', 10],
    ['Friday', 6],
    ['next Monday', 2],
  ];
  for (const [phrase, expected] of resolveCases) {
    it(`resolveDuePhrase "${phrase}" -> ${expected}`, () => {
      expect(resolveDuePhrase(phrase, today, null, todayDate)).toBe(expected);
    });
  }

  const reconcileCases: [string, string, number][] = [
    ['Essay', 'The essay is due on Monday, October 19.', 9],
    ['Essay', 'The essay is due Monday, October 19.', 9],
    ['Lab report', 'Lab report due Fri 10/30.', 20],
    ['Lab report', 'Lab report due by Fri 10/30.', 20],
    ['Lab report', 'Lab report due Friday.', 6],
    ['Lab report', 'Lab report due next Monday.', 2],
    ['Reading', 'Reading due on Wednesday, October 14.', 4],
    ['Reading', 'Reading due next Monday, October 19.', 9],
  ];
  for (const [title, text, expected] of reconcileCases) {
    it(`reconcileDueDates "${text}" -> ${expected}`, () => {
      const [task] = reconcileDueDates([{ title, dueInDays: 1 }], text, today, todayDate);
      expect(task).toEqual({ title, dueInDays: expected, dueSource: 'text' });
    });
  }

  it('finds "on Monday, October 19" as one phrase, not "on Monday" and "October 19"', () => {
    expect(findDuePhrases('Essay due on Monday, October 19.').map((p) => p.phrase)).toEqual([
      'on Monday, October 19',
    ]);
  });

  it('falls back to the weekday when no todayDate is given', () => {
    expect(resolveDuePhrase('on Monday, October 19', today, null)).toBe(2);
    expect(resolveDuePhrase('Fri 10/30', today, null)).toBe(6);
    expect(resolveDuePhrase('next Monday, October 19', today, null)).toBe(2);
  });
});

describe('findDuePhrases', () => {
  it('prefers the longer match at a position: "next Tuesday", not "Tuesday"', () => {
    const result = findDuePhrases('The study guide is due next Tuesday.');
    expect(result).toHaveLength(1);
    expect(result[0].phrase).toBe('next Tuesday');
  });

  it('prefers the longer match at a position: "the day after tomorrow", not "tomorrow"', () => {
    const result = findDuePhrases('The essay is due the day after tomorrow.');
    expect(result).toHaveLength(1);
    expect(result[0].phrase).toBe('the day after tomorrow');
  });

  it('finds a leading weekday label even without surrounding due-language', () => {
    const result = findDuePhrases('Wed - mixed review due');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ phrase: 'Wed', index: 0 });
  });

  it('finds multiple phrases in one sentence, in order of appearance', () => {
    const result = findDuePhrases('The lab report is due Wednesday and the problem set is due next Monday.');
    expect(result.map((r) => r.phrase)).toEqual(['Wednesday', 'next Monday']);
  });

  it('returns nothing for a sentence with no due phrase', () => {
    expect(findDuePhrases('Bring both to class.')).toEqual([]);
  });
});

describe('splitSentences', () => {
  it('splits on terminal punctuation', () => {
    expect(splitSentences('Quiz Friday. Essay due Monday! Anything else?')).toEqual([
      'Quiz Friday.',
      'Essay due Monday!',
      'Anything else?',
    ]);
  });

  it('splits on semicolons and newlines', () => {
    expect(splitSentences('Reading due Friday;\nEssay due Monday')).toEqual([
      'Reading due Friday',
      'Essay due Monday',
    ]);
  });

  it('splits on every spaced dash, a weekday label included, per Amendments 2', () => {
    const result = splitSentences('Mon - hw due Tue - quiz Wed - test');
    expect(result).toEqual(['Mon', 'hw due Tue', 'quiz Wed', 'test']);
  });

  it('does not split a label that already starts the text', () => {
    expect(splitSentences('Monday: quiz on chapters 1 to 3.')).toEqual(['Monday: quiz on chapters 1 to 3.']);
  });

  it('splits "Next Mon -" into its own label sentence, separate from the item after it', () => {
    const result = splitSentences('Fri - section 6.3 practice due. Next Mon - unit 6 study guide due.');
    expect(result).toEqual([
      'Fri',
      'section 6.3 practice due.',
      'Next Mon',
      'unit 6 study guide due.',
    ]);
  });
});
