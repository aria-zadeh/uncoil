// lets app/ use services/insights.ts, since app/ never imports services.
// raw-select, then derive in useMemo. a derived selector re-renders forever on zustand v5 + React 19
import { useMemo } from 'react';

import {
  calibrationProgress,
  completionCounts,
  completionRate,
  currentStreak,
  estimateCalibration,
  productiveWindow,
  windowProgress,
  type CompletionCounts,
  type EstimateCalibration,
  type LearningProgress,
  type ProductiveWindow,
} from '@/services/insights';
import { useSchedulingStore, useTaskStore } from '@/store/runtime';

export interface Insights {
  completed7: CompletionCounts;
  completed30: CompletionCounts;
  // share done by the due date over 30 days, null below sample size
  completionRate30: number | null;
  // consecutive days back from today with at least one completion
  streak: number;
  // null until there are enough signals
  productiveWindow: ProductiveWindow | null;
  // progress toward productiveWindow, so the tile has something to show while learning
  windowProgress: LearningProgress;
  // the student's estimates against actual time, null until there are enough signals
  estimateCalibration: EstimateCalibration | null;
  // counts only signals with both durations. have reaching need is when estimateCalibration appears
  calibrationProgress: LearningProgress;
}

export function useInsights(): Insights {
  const tasks = useTaskStore((s) => s.tasks);
  const signals = useSchedulingStore((s) => s.signals);

  return useMemo(() => {
    // the clock only refreshes when tasks or signals change. day-bucketed numbers don't need more
    const now = new Date();
    return {
      completed7: completionCounts(tasks, now, 7),
      completed30: completionCounts(tasks, now, 30),
      completionRate30: completionRate(tasks, now, 30),
      streak: currentStreak(tasks, now),
      productiveWindow: productiveWindow(signals),
      windowProgress: windowProgress(signals),
      estimateCalibration: estimateCalibration(signals),
      calibrationProgress: calibrationProgress(signals),
    };
  }, [tasks, signals]);
}
