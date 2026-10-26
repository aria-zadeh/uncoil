import { describe, expect, it } from 'vitest';

import {
  SYSTEM_BREAKDOWN,
  SYSTEM_EXTRACTION,
  SYSTEM_SIMPLIFY,
  WEEKDAYS,
  buildBreakdownPrompt,
  buildExtractionPrompt,
  buildRepairPrompt,
  buildSimplifyPrompt,
  chunkForExtraction,
  daysUntil,
  duePhraseFor,
  relativeDuePhrase,
  weekdayOf,
} from '@/services/prompt';
import { EXTRACTION_LIMITS, type BreakdownInput } from '@/types';

function input(overrides: Partial<BreakdownInput> = {}): BreakdownInput {
  return {
    title: 'Write a 5-paragraph essay on The Great Gatsby',
    subject: 'English 2H',
    description: null,
    duePhrase: 'in 3 days',
    sessionMinutes: 30,
    ...overrides,
  };
}

describe('daysUntil', () => {
  it('counts calendar days, not elapsed milliseconds', () => {
    // 23:00 today to 01:00 tomorrow is two hours but one calendar day
    const now = new Date(2026, 8, 7, 23, 0);
    const due = new Date(2026, 8, 8, 1, 0);
    expect(daysUntil(due, now)).toBe(1);
  });

  it('is zero for the same day regardless of time', () => {
    expect(daysUntil(new Date(2026, 8, 7, 23, 59), new Date(2026, 8, 7, 0, 1))).toBe(0);
  });

  it('is negative for a past date', () => {
    expect(daysUntil(new Date(2026, 8, 5), new Date(2026, 8, 7))).toBe(-2);
  });

  it('crosses month and year boundaries', () => {
    expect(daysUntil(new Date(2027, 0, 1), new Date(2026, 11, 30))).toBe(2);
  });
});

describe('relativeDuePhrase', () => {
  const cases: [number, string][] = [
    [-5, 'today'],
    [0, 'today'],
    [1, 'tomorrow'],
    [2, 'in 2 days'],
    [3, 'in 3 days'],
    [6, 'in 6 days'],
    [7, 'next week'],
    [8, 'in 8 days'],
    [13, 'in 13 days'],
    [14, 'in 2 weeks'],
    [17, 'in 2 weeks'],
    [21, 'in 3 weeks'],
    [27, 'in 3 weeks'],
    [30, 'in a month'],
    [60, 'in 2 months'],
  ];

  for (const [days, expected] of cases) {
    it(`renders ${days} days as ${JSON.stringify(expected)}`, () => {
      expect(relativeDuePhrase(days)).toBe(expected);
    });
  }

  it('never emits an absolute date', () => {
    // small models are bad at date arithmetic, so absolute dates stay in TypeScript
    for (let d = -10; d <= 400; d += 1) {
      expect(relativeDuePhrase(d)).not.toMatch(/\d{4}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec/);
    }
  });

  it('draws only from a closed phrase set, matching the training distribution', () => {
    const seen = new Set<string>();
    for (let d = -10; d <= 400; d += 1) seen.add(relativeDuePhrase(d));
    for (const phrase of seen) {
      expect(phrase).toMatch(/^(today|tomorrow|next week|in a month|in \d+ (days|weeks|months))$/);
    }
  });
});

describe('duePhraseFor', () => {
  it('converts an ISO date against a reference time', () => {
    expect(duePhraseFor(new Date(2026, 8, 10, 12, 0).toISOString(), new Date(2026, 8, 7, 9, 0))).toBe(
      'in 3 days',
    );
  });
});

describe('buildBreakdownPrompt', () => {
  it('uses the fixed system message verbatim', () => {
    expect(buildBreakdownPrompt(input()).system).toBe(SYSTEM_BREAKDOWN);
    expect(SYSTEM_BREAKDOWN).toBe(
      'Break the assignment into 3 to 7 physical steps. Respond with JSON only.',
    );
  });

  it('emits exactly the five labelled lines, in order, with no trailing newline', () => {
    const { user } = buildBreakdownPrompt(input());
    expect(user).toBe(
      [
        'Assignment: Write a 5-paragraph essay on The Great Gatsby',
        'Subject: English 2H',
        'Details: none',
        'Due: in 3 days',
        'Session length: 30',
      ].join('\n'),
    );
    expect(user.endsWith('\n')).toBe(false);
  });

  it('writes "none" for an absent subject or description', () => {
    const { user } = buildBreakdownPrompt(input({ subject: null, description: null }));
    expect(user).toContain('Subject: none');
    expect(user).toContain('Details: none');
  });

  it('writes "none" for a whitespace-only field, not an empty label', () => {
    const { user } = buildBreakdownPrompt(input({ subject: '   ' }));
    expect(user).toContain('Subject: none');
  });

  it('collapses newlines inside a field so the record boundary survives', () => {
    // a raw newline would look like a new labelled line to a model trained on a strict five-line record
    const { user } = buildBreakdownPrompt(
      input({ description: 'First line\nSecond line\n\nThird' }),
    );
    expect(user.split('\n')).toHaveLength(5);
    expect(user).toContain('Details: First line Second line Third');
  });

  it('collapses tabs and repeated spaces too', () => {
    const { user } = buildBreakdownPrompt(input({ title: 'Read\t\tthe   chapter' }));
    expect(user).toContain('Assignment: Read the chapter');
  });

  it('is byte-stable for the same input', () => {
    expect(buildBreakdownPrompt(input())).toEqual(buildBreakdownPrompt(input()));
  });
});

describe('buildExtractionPrompt and buildSimplifyPrompt', () => {
  it('use their own system messages so one model can serve three tasks', () => {
    expect(buildExtractionPrompt('some text').system).toBe(SYSTEM_EXTRACTION);
    expect(buildSimplifyPrompt({ title: 'A task', description: null }).system).toBe(SYSTEM_SIMPLIFY);
    expect(new Set([SYSTEM_BREAKDOWN, SYSTEM_EXTRACTION, SYSTEM_SIMPLIFY]).size).toBe(3);
  });

  it('labels the extraction input with a reference weekday', () => {
    expect(buildExtractionPrompt('Read chapter 4 by Friday', 'Tuesday').user).toBe(
      'Today: Tuesday\nText: Read chapter 4 by Friday',
    );
  });

  it('emits exactly two lines, the second starting with Text:', () => {
    const { user } = buildExtractionPrompt('Read chapter 4 by Friday', 'Wednesday');
    const lines = user.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Today: Wednesday');
    expect(lines[1]).toBe('Text: Read chapter 4 by Friday');
  });

  it('defaults the reference weekday to Monday when none is given', () => {
    expect(buildExtractionPrompt('Read chapter 4 by Friday').user).toBe(
      'Today: Monday\nText: Read chapter 4 by Friday',
    );
  });

  it('emits two labelled lines for simplification', () => {
    expect(buildSimplifyPrompt({ title: 'Analyze the rhetoric', description: null }).user).toBe(
      'Assignment: Analyze the rhetoric\nDetails: none',
    );
  });
});

describe('weekdayOf', () => {
  it('maps getDay() to the matching Weekday name, Monday first', () => {
    // 2026-09-07 to 2026-09-13 is a monday to sunday week in local time
    const days = [
      [2026, 8, 7, 'Monday'],
      [2026, 8, 8, 'Tuesday'],
      [2026, 8, 9, 'Wednesday'],
      [2026, 8, 10, 'Thursday'],
      [2026, 8, 11, 'Friday'],
      [2026, 8, 12, 'Saturday'],
      [2026, 8, 13, 'Sunday'],
    ] as const;
    for (const [year, month, date, expected] of days) {
      expect(weekdayOf(new Date(year, month, date, 12, 0))).toBe(expected);
    }
  });

  it('only ever returns one of the closed WEEKDAYS set', () => {
    for (let d = 1; d <= 28; d += 1) {
      expect(WEEKDAYS).toContain(weekdayOf(new Date(2026, 0, d, 12, 0)));
    }
  });
});

describe('buildRepairPrompt', () => {
  it('appends the concrete reason and keeps the system message', () => {
    const original = buildBreakdownPrompt(input());
    const repair = buildRepairPrompt(original, 'there were 9 steps, the maximum is 7');
    expect(repair.system).toBe(original.system);
    expect(repair.user.startsWith(original.user)).toBe(true);
    expect(repair.user.endsWith(
      'Rejected: there were 9 steps, the maximum is 7. Respond again with JSON only.',
    )).toBe(true);
  });
});

describe('chunkForExtraction', () => {
  const max = EXTRACTION_LIMITS.maxChunkChars;

  it('returns one chunk for short text', () => {
    expect(chunkForExtraction('Read chapter 4 by Friday.', max)).toEqual([
      'Read chapter 4 by Friday.',
    ]);
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkForExtraction('', max)).toEqual([]);
    expect(chunkForExtraction('   \n\n  ', max)).toEqual([]);
  });

  it('splits on paragraph boundaries', () => {
    const para = 'x'.repeat(500);
    const chunks = chunkForExtraction(`${para}\n\n${para}`, max);
    expect(chunks).toHaveLength(2);
  });

  it('never emits a chunk longer than the budget', () => {
    const inputs = [
      'word '.repeat(2000),
      'x'.repeat(5000),
      `${'Sentence one. '.repeat(300)}\n\n${'Sentence two. '.repeat(300)}`,
      `${'a'.repeat(3000)}\n\nshort`,
    ];
    for (const text of inputs) {
      for (const chunk of chunkForExtraction(text, max)) {
        expect(chunk.length).toBeLessThanOrEqual(max);
      }
    }
  });

  it('terminates on a single unbroken token longer than the budget', () => {
    const chunks = chunkForExtraction('x'.repeat(4321), max);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('').length).toBeGreaterThan(4000);
  });

  it('keeps every non-empty chunk trimmed', () => {
    for (const chunk of chunkForExtraction('Read it.\n\n   \n\nWrite it.', max)) {
      expect(chunk).toBe(chunk.trim());
      expect(chunk).not.toBe('');
    }
  });
});
