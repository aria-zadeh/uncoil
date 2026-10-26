import type { Subtask } from '@/types';

// array order and `order` drift apart after edits. copies first because callers pass
// the store's own array, and sort works in place
export function sortSubtasksForDisplay(subtasks: readonly Subtask[]): Subtask[] {
  return [...subtasks].sort((a, b) => a.order - b.order);
}
