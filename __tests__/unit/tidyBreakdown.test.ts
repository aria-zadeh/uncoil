import { describe, expect, it } from 'vitest';

import { tidyBreakdown } from '@/services/tidyBreakdown';
import { validateBreakdown } from '@/services/validation';
import { BREAKDOWN_LIMITS, type BreakdownInput } from '@/types';

const BREAKDOWN_INPUT: BreakdownInput = {
  title: 'Write a 5-paragraph essay on the reading',
  subject: 'English',
  description: null,
  duePhrase: 'in 3 days',
  sessionMinutes: 30,
};

interface Step {
  title: string;
  minutes: number;
}

function step(title: string, minutes = 10): Step {
  return { title, minutes };
}

describe('tidyBreakdown', () => {
  it('drops an exact duplicate title, keeping the first occurrence', () => {
    const result = tidyBreakdown([
      step('Open the reading and go through it once'),
      step('Write down the three points to make'),
      step('Open the reading and go through it once'),
    ]);

    expect(result.steps).toEqual([
      step('Open the reading and go through it once'),
      step('Write down the three points to make'),
    ]);
    expect(result.record.droppedDuplicates).toBe(1);
  });

  it('drops a duplicate that only matches after normalisation', () => {
    // same key once case and punctuation are stripped, as validation.ts's duplicate_step check does
    const result = tidyBreakdown([
      step('Open the Reading!'),
      step('Write down the three points to make'),
      step('open   the reading'),
    ]);

    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].title).toBe('Open the Reading!');
    expect(result.record.droppedDuplicates).toBe(1);
  });

  it('keeps the surviving steps in their original order', () => {
    const result = tidyBreakdown([step('First step'), step('Second step'), step('First step')]);

    expect(result.steps.map((s) => s.title)).toEqual(['First step', 'Second step']);
  });

  it('trims nine steps down to the first six plus the last', () => {
    const nine = Array.from({ length: 9 }, (_, i) => step(`Step number ${i}`));
    const result = tidyBreakdown(nine);

    expect(result.steps).toHaveLength(7);
    expect(result.steps.map((s) => s.title)).toEqual([
      'Step number 0',
      'Step number 1',
      'Step number 2',
      'Step number 3',
      'Step number 4',
      'Step number 5',
      'Step number 8',
    ]);
    expect(result.record.trimmedTo7).toBe(true);
  });

  it('leaves a breakdown with 3 to 7 unique steps untouched', () => {
    const five = [
      step('Open the book'),
      step('Read the first chapter'),
      step('Write a summary'),
      step('Check the summary against the chapter'),
      step('Save the file'),
    ];
    const result = tidyBreakdown(five);

    expect(result.steps).toEqual(five);
    expect(result.record).toEqual({ droppedDuplicates: 0, trimmedTo7: false });
  });

  it('reports zero drops and no trim for a breakdown that needed neither', () => {
    const result = tidyBreakdown([step('Open the book'), step('Read the chapter')]);

    expect(result.record.droppedDuplicates).toBe(0);
    expect(result.record.trimmedTo7).toBe(false);
  });

  it('reports both a drop count and a trim together when a breakdown needs both', () => {
    // index 5 repeats step 0, and nine remain after dropping it, so a trim also applies
    const ten = Array.from({ length: 10 }, (_, i) => step(`Step number ${i}`));
    ten[5] = step('Step number 0');

    const result = tidyBreakdown(ten);

    expect(result.record.droppedDuplicates).toBe(1);
    expect(result.record.trimmedTo7).toBe(true);
    expect(result.steps).toHaveLength(7);
    // step 9, not 8, because the duplicate was removed before the trim
    expect(result.steps[result.steps.length - 1].title).toBe('Step number 9');
  });

  it('passes through a step with no readable string title rather than dropping it', () => {
    const malformed = { minutes: 10 } as unknown as Step;
    const result = tidyBreakdown([step('Open the book'), malformed, step('Read the chapter')]);

    expect(result.steps).toHaveLength(3);
    expect(result.record.droppedDuplicates).toBe(0);
  });

  it('trims to the same step limit validateBreakdown enforces', () => {
    expect(BREAKDOWN_LIMITS.maxSteps).toBe(7);
    const eight = Array.from({ length: 8 }, (_, i) => step(`Step number ${i}`));
    expect(tidyBreakdown(eight).steps).toHaveLength(BREAKDOWN_LIMITS.maxSteps);
  });

  it('agrees with validateBreakdown on which titles are duplicates, catching drift between the two normalisations', () => {
    const titleA = 'Open the Reading!';
    const titleB = 'open   the reading';
    const tidied = tidyBreakdown([
      step(titleA),
      step('Write down the three points to make'),
      step(titleB),
    ]);
    expect(tidied.record.droppedDuplicates).toBe(1);

    // with tidy bypassed, validateBreakdown must flag the same pair or the two normalisations have drifted
    const raw = JSON.stringify({
      steps: [
        { title: titleA, minutes: 10 },
        { title: 'Write down the three points to make', minutes: 10 },
        { title: titleB, minutes: 10 },
      ],
      starterAction: titleA,
    });
    const result = validateBreakdown(raw, BREAKDOWN_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe('duplicate_step');
  });
});
