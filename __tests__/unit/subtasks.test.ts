import { describe, expect, it } from 'vitest';

import { sortSubtasksForDisplay } from '@/utils/subtasks';
import type { Subtask } from '@/types';

function subtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: 'sub-1',
    parentTaskId: 'task-1',
    title: 'Do something',
    estimatedMinutes: 10,
    isComplete: false,
    order: 0,
    completedAt: null,
    ...overrides,
  };
}

describe('sortSubtasksForDisplay', () => {
  it('sorts by order, ascending', () => {
    const input = [
      subtask({ id: 'c', order: 2 }),
      subtask({ id: 'a', order: 0 }),
      subtask({ id: 'b', order: 1 }),
    ];

    const result = sortSubtasksForDisplay(input);

    expect(result.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns a new array, not the input reference', () => {
    const input = [subtask({ id: 'a', order: 1 }), subtask({ id: 'b', order: 0 })];

    const result = sortSubtasksForDisplay(input);

    // screens call this from a useMemo over the store's own task.subtasks, so returning
    // the same reference would hand back the store array itself
    expect(result).not.toBe(input);
  });

  it('does not mutate the input array or its order', () => {
    const input = [
      subtask({ id: 'c', order: 2 }),
      subtask({ id: 'a', order: 0 }),
      subtask({ id: 'b', order: 1 }),
    ];
    const inputIdsBefore = input.map((s) => s.id);

    sortSubtasksForDisplay(input);

    // regression: sorting task.subtasks in place reordered the store's array during render
    expect(input.map((s) => s.id)).toEqual(inputIdsBefore);
  });

  it('is stable and total across an unordered, non-contiguous input', () => {
    const input = [
      subtask({ id: 'x', order: 5 }),
      subtask({ id: 'y', order: -1 }),
      subtask({ id: 'z', order: 5 }),
    ];

    const result = sortSubtasksForDisplay(input);

    expect(result.map((s) => s.id)).toEqual(['y', 'x', 'z']);
  });

  it('handles an empty list', () => {
    expect(sortSubtasksForDisplay([])).toEqual([]);
  });
});
