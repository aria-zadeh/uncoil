// "i have N minutes right now": pick the one piece of work that fits the window. estimates are padded
// by the learned overrun multiplier (blockLengthMultiplier in insights.ts), so someone who runs 50% long
// isn't offered a 30-minute step for a 30-minute window and left with it half done
import type { Task } from '@/types';

export interface RightNowPick {
  taskId: string;
  taskTitle: string;
  // null for a whole task with no subtasks
  subtaskId: string | null;
  title: string;
  // padded by the multiplier, rounded up
  fitMinutes: number;
}

interface Candidate extends RightNowPick {
  // negative once overdue
  dueInMs: number;
  order: number;
  candidateId: string;
}

// a bad multiplier counts as 1, so a caller without calibration gets unpadded estimates, not nothing
export function pickForMinutes(
  tasks: readonly Task[],
  availableMinutes: number,
  durationMultiplier: number,
  now: Date,
): RightNowPick | null {
  if (availableMinutes <= 0) return null;
  const multiplier =
    Number.isFinite(durationMultiplier) && durationMultiplier > 0 ? durationMultiplier : 1;

  const nowMs = now.getTime();
  const fits: Candidate[] = [];

  for (const task of tasks) {
    if (task.status === 'complete') continue;
    const dueInMs = new Date(task.dueDate).getTime() - nowMs;

    const remaining = task.subtasks.filter((subtask) => !subtask.isComplete);
    if (remaining.length > 0) {
      for (const subtask of remaining) {
        push(fits, availableMinutes, {
          taskId: task.id,
          taskTitle: task.title,
          subtaskId: subtask.id,
          title: subtask.title,
          fitMinutes: pad(subtask.estimatedMinutes, multiplier),
          dueInMs,
          order: subtask.order,
          candidateId: subtask.id,
        });
      }
      continue;
    }

    // no duration to size it by, and a default would be a guess shown as a fit
    if (task.durationMinutes === null) continue;
    push(fits, availableMinutes, {
      taskId: task.id,
      taskTitle: task.title,
      subtaskId: null,
      title: task.title,
      fitMinutes: pad(task.durationMinutes, multiplier),
      dueInMs,
      order: 0,
      candidateId: task.id,
    });
  }

  if (fits.length === 0) return null;
  fits.sort(byUrgencyThenFit);

  const best = fits[0];
  return {
    taskId: best.taskId,
    taskTitle: best.taskTitle,
    subtaskId: best.subtaskId,
    title: best.title,
    fitMinutes: best.fitMinutes,
  };
}

// rounded up, a window that's a minute short is short
function pad(estimateMinutes: number, multiplier: number): number {
  return Math.ceil(estimateMinutes * multiplier);
}

function push(into: Candidate[], availableMinutes: number, candidate: Candidate): void {
  if (candidate.fitMinutes <= availableMinutes) into.push(candidate);
}

// overdue needs no special case, a negative dueInMs already sorts ahead of everything
function byUrgencyThenFit(a: Candidate, b: Candidate): number {
  if (a.dueInMs !== b.dueInMs) return a.dueInMs - b.dueInMs;
  // a 25-minute step uses a 30-minute window better than a 5-minute one
  if (a.fitMinutes !== b.fitMinutes) return b.fitMinutes - a.fitMinutes;
  if (a.order !== b.order) return a.order - b.order;
  if (a.candidateId < b.candidateId) return -1;
  if (a.candidateId > b.candidateId) return 1;
  return 0;
}
