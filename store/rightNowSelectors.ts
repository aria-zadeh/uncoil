// the block-length multiplier is read here, not passed in, so no screen can forget to pad
// the fit by the student's own history
import { useMemo } from 'react';

import { blockLengthMultiplier } from '@/services/insights';
import { pickForMinutes, type RightNowPick } from '@/services/rightNow';
import { useSchedulingStore, useTaskStore } from '@/store/runtime';

/** the one piece of work that fits availableMinutes. null minutes means no window picked yet */
export function useRightNowPick(availableMinutes: number | null): RightNowPick | null {
  const tasks = useTaskStore((s) => s.tasks);
  const signals = useSchedulingStore((s) => s.signals);

  return useMemo(() => {
    if (availableMinutes === null) return null;
    // the clock only refreshes when tasks or signals change, fine at day-to-hour resolution
    return pickForMinutes(tasks, availableMinutes, blockLengthMultiplier(signals), new Date());
  }, [tasks, signals, availableMinutes]);
}
