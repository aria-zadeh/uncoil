// maps the scheduler onto the seam taskStore declares. not inline in runtime.ts because
// runtime.ts can't load in node tests, and this mapping needs testing
import { proposeSlot } from '@/services/scheduler';
import type { ProposeContext, ProposedSlot } from '@/store/taskStore';

export function proposeForTask(
  context: ProposeContext,
  now: Date = new Date(),
): ProposedSlot | null {
  const proposal = proposeSlot({
    task: context.task,
    // otherTasks is occupancy, so leave this task out or it collides with itself
    otherTasks: context.allTasks.filter((other) => other.id !== context.task.id),
    settings: context.settings,
    signals: context.signals,
    now,
  });

  // only the start crosses the seam. the end follows from the task's duration
  return proposal === null ? null : { startTime: proposal.startIso };
}
