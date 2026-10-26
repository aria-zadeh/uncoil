import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// read as text: UndoToast imports react-native and the banner is inline JSX

describe('copy guard', () => {
  it('UndoToast completion copy is exactly PRD.md 5.7\'s "Task completed" (no exclamation mark)', () => {
    const source = readFileSync('components/ui/UndoToast.tsx', 'utf8');
    const match = source.match(/export const TASK_COMPLETED_COPY = (["'])((?:(?!\1).)*)\1/);
    expect(match, 'TASK_COMPLETED_COPY export not found in UndoToast.tsx').not.toBeNull();
    expect(match?.[2]).toBe('Task completed');
  });

  it('breakdown fallback banner copy appears exactly once in each screen that renders it', () => {
    const literal = 'Showing general steps for now.';
    const files = ['app/task/[id].tsx', 'app/task/new.tsx'];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const occurrences = source.split(literal).length - 1;
      expect(occurrences, `${file} should contain "${literal}" exactly once`).toBe(1);
    }
  });
});
