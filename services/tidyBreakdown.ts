// cleans freshly parsed model output before validateBreakdown: drops repeated steps and trims to the
// step limit, so one repeat or one extra step doesn't throw away a usable breakdown. the validator is
// unchanged and still gets the last word, so anything that doesn't look like a step is left alone

import { BREAKDOWN_LIMITS } from '@/types';

export interface TidyRecord {
  droppedDuplicates: number;
  trimmedTo7: boolean;
}

export interface TidyResult<T> {
  steps: T[];
  record: TidyRecord;
}

// must match the normalisation in validation.ts's duplicate check. tidyBreakdown.test.ts keeps them in step
function normalisedTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '')
    .join(' ');
}

function titleOf(step: unknown): string | null {
  if (typeof step !== 'object' || step === null) return null;
  const title = (step as { title?: unknown }).title;
  return typeof title === 'string' ? title : null;
}

const MAX_STEPS = BREAKDOWN_LIMITS.maxSteps;
const KEEP_HEAD = 6;

// a trim keeps the first six steps and the last, which is usually the useful "check it" step
export function tidyBreakdown<T>(steps: readonly T[]): TidyResult<T> {
  const seen = new Set<string>();
  const deduped: T[] = [];
  let droppedDuplicates = 0;

  for (const step of steps) {
    const title = titleOf(step);
    if (title === null) {
      deduped.push(step);
      continue;
    }
    const key = normalisedTitle(title);
    if (seen.has(key)) {
      droppedDuplicates += 1;
      continue;
    }
    seen.add(key);
    deduped.push(step);
  }

  if (deduped.length <= MAX_STEPS) {
    return { steps: deduped, record: { droppedDuplicates, trimmedTo7: false } };
  }

  const trimmed = [...deduped.slice(0, KEEP_HEAD), deduped[deduped.length - 1]];
  return { steps: trimmed, record: { droppedDuplicates, trimmedTo7: true } };
}
