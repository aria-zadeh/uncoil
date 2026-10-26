import { describe, expect, it } from 'vitest';

import {
  DURATION_MULTIPLIER_MAX,
  DURATION_MULTIPLIER_MIN,
  MIN_OBSERVATIONS_FOR_CAPACITY,
  MIN_SAMPLES_FOR_DURATION_MULTIPLIER,
  MIN_SIGNALS_FOR_CALIBRATION,
  MIN_SIGNALS_FOR_WINDOW,
  blockLengthMultiplier,
  calibrationProgress,
  completionCounts,
  completionRate,
  currentStreak,
  estimateCalibration,
  focusSecondsInPeriod,
  highestPriorityTask,
  isOverdue,
  median,
  productiveWindow,
  scheduledToday,
  weekdayCapacities,
  windowProgress,
} from '@/services/insights';
import type { FocusSession, SchedulingSignal, Task } from '@/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = new Date(2026, 8, 7, 18, 0, 0, 0); // monday evening

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Chapter 4 notes',
    subject: null,
    description: null,
    dueDate: new Date(NOW.getTime() + 2 * DAY).toISOString(),
    startTime: null,
    proposedTime: null,
    durationMinutes: 45,
    status: 'not_started',
    scheduleStatus: 'unscheduled',
    subtasks: [],
    starterAction: null,
    breakdownSource: null,
    createdAt: new Date(NOW.getTime() - DAY).toISOString(),
    updatedAt: new Date(NOW.getTime() - DAY).toISOString(),
    completedAt: null,
    ...overrides,
  };
}

function signal(overrides: Partial<SchedulingSignal> = {}): SchedulingSignal {
  return {
    id: 's1',
    taskId: 't1',
    dayOfWeek: 1,
    hourOfDay: 15,
    outcome: 'completed',
    actualDurationMinutes: 60,
    estimatedDurationMinutes: 45,
    recordedAt: new Date(NOW.getTime() - DAY).toISOString(),
    ...overrides,
  };
}

function session(overrides: Partial<FocusSession> = {}): FocusSession {
  return {
    id: 'f1',
    taskId: 't1',
    taskTitleSnapshot: 'Chapter 4 notes',
    subtaskId: null,
    startedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
    endedAt: new Date(NOW.getTime() - HOUR).toISOString(),
    durationSeconds: 3600,
    breaksTaken: 1,
    breakSecondsTotal: 300,
    completedSubtaskIds: [],
    endReason: 'completed',
    ...overrides,
  };
}

describe('median', () => {
  it('handles odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('is NaN for an empty list', () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('completionCounts', () => {
  it('counts completions and creations inside the window', () => {
    const tasks = [
      task({ id: 'a', completedAt: new Date(NOW.getTime() - 2 * DAY).toISOString() }),
      task({ id: 'b', completedAt: new Date(NOW.getTime() - 20 * DAY).toISOString() }),
      task({ id: 'c', createdAt: new Date(NOW.getTime() - 40 * DAY).toISOString() }),
    ];
    expect(completionCounts(tasks, NOW, 7)).toEqual({ completed: 1, created: 2 });
    expect(completionCounts(tasks, NOW, 30)).toEqual({ completed: 2, created: 2 });
  });

  it('is zero for an empty list', () => {
    expect(completionCounts([], NOW, 7)).toEqual({ completed: 0, created: 0 });
  });
});

describe('completionRate', () => {
  it('is the share completed on or before the due date', () => {
    const tasks = [
      task({
        id: 'onTime',
        dueDate: new Date(NOW.getTime() - HOUR).toISOString(),
        completedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
      }),
      task({
        id: 'late',
        dueDate: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
        completedAt: new Date(NOW.getTime() - HOUR).toISOString(),
      }),
      task({ id: 'open' }),
    ];
    expect(completionRate(tasks, NOW, 7)).toBeCloseTo(1 / 3);
  });

  it('counts a task completed exactly at the due moment as on time', () => {
    const at = new Date(NOW.getTime() - HOUR).toISOString();
    expect(completionRate([task({ dueDate: at, completedAt: at })], NOW, 7)).toBe(1);
  });

  it('is null when nothing was created in the window, rather than zero', () => {
    // a rate over zero tasks is not a fact about the student
    expect(completionRate([], NOW, 7)).toBeNull();
    expect(
      completionRate([task({ createdAt: new Date(NOW.getTime() - 60 * DAY).toISOString() })], NOW, 7),
    ).toBeNull();
  });
});

describe('currentStreak', () => {
  function completedOn(daysAgo: number, id: string): Task {
    const when = new Date(NOW.getTime() - daysAgo * DAY);
    return task({ id, completedAt: when.toISOString(), status: 'complete' });
  }

  it('counts consecutive days ending today', () => {
    expect(currentStreak([completedOn(0, 'a'), completedOn(1, 'b'), completedOn(2, 'c')], NOW)).toBe(3);
  });

  it('stays alive when today has no completion yet but yesterday did', () => {
    // otherwise the streak would reset to zero every morning
    expect(currentStreak([completedOn(1, 'a'), completedOn(2, 'b')], NOW)).toBe(2);
  });

  it('is zero when the most recent completion is older than yesterday', () => {
    expect(currentStreak([completedOn(2, 'a'), completedOn(3, 'b')], NOW)).toBe(0);
  });

  it('is zero with no completions', () => {
    expect(currentStreak([task()], NOW)).toBe(0);
    expect(currentStreak([], NOW)).toBe(0);
  });

  it('counts a day once no matter how many tasks were completed on it', () => {
    expect(currentStreak([completedOn(0, 'a'), completedOn(0, 'b'), completedOn(0, 'c')], NOW)).toBe(1);
  });

  it('stops at the first missing day', () => {
    expect(
      currentStreak([completedOn(0, 'a'), completedOn(1, 'b'), completedOn(3, 'c')], NOW),
    ).toBe(2);
  });
});

describe('productiveWindow', () => {
  function signals(count: number, overrides: Partial<SchedulingSignal> = {}): SchedulingSignal[] {
    return Array.from({ length: count }, (_, i) => signal({ id: `s${i}`, ...overrides }));
  }

  it('is null below the minimum sample count', () => {
    expect(productiveWindow(signals(MIN_SIGNALS_FOR_WINDOW - 1))).toBeNull();
  });

  it('returns the best bucket once there are enough samples', () => {
    const mixed = [
      ...signals(5, { dayOfWeek: 1, hourOfDay: 15, outcome: 'completed' }),
      ...signals(5, { dayOfWeek: 3, hourOfDay: 20, outcome: 'skipped' }),
    ];
    const window = productiveWindow(mixed);
    expect(window).not.toBeNull();
    expect(window!.dayOfWeek).toBe(1);
    expect(window!.hourOfDay).toBe(15);
    expect(window!.completionRate).toBe(1);
  });

  it('ignores a bucket with fewer than three of its own samples', () => {
    // one lucky tuesday must not become "your most productive time"
    const mixed = [
      ...signals(9, { dayOfWeek: 1, hourOfDay: 15, outcome: 'completed' }),
      signal({ id: 'lucky', dayOfWeek: 2, hourOfDay: 7, outcome: 'completed' }),
    ];
    const window = productiveWindow(mixed);
    expect(window!.dayOfWeek).toBe(1);
  });

  it('prefers the larger sample when two buckets tie on rate', () => {
    const mixed = [
      ...signals(6, { dayOfWeek: 1, hourOfDay: 15, outcome: 'completed' }),
      ...signals(3, { dayOfWeek: 4, hourOfDay: 16, outcome: 'completed' }),
      ...signals(3, { dayOfWeek: 5, hourOfDay: 9, outcome: 'skipped' }),
    ];
    const window = productiveWindow(mixed);
    expect(window!.dayOfWeek).toBe(1);
    expect(window!.sampleCount).toBe(6);
  });
});

describe('windowProgress', () => {
  function signals(count: number, overrides: Partial<SchedulingSignal> = {}): SchedulingSignal[] {
    return Array.from({ length: count }, (_, i) => signal({ id: `s${i}`, ...overrides }));
  }

  it('is zero of the threshold with no signals at all', () => {
    expect(windowProgress([])).toEqual({ have: 0, need: MIN_SIGNALS_FOR_WINDOW });
  });

  it('reports the count so far while the window is still null', () => {
    expect(windowProgress(signals(3))).toEqual({ have: 3, need: MIN_SIGNALS_FOR_WINDOW });
    expect(productiveWindow(signals(3))).toBeNull();
  });

  it('is full exactly where productiveWindow stops being null', () => {
    const enough = signals(MIN_SIGNALS_FOR_WINDOW);
    expect(windowProgress(enough).have).toBe(MIN_SIGNALS_FOR_WINDOW);
    expect(productiveWindow(enough)).not.toBeNull();
  });

  it('caps at the threshold so a long-running install cannot read "41 of 10"', () => {
    expect(windowProgress(signals(41))).toEqual({
      have: MIN_SIGNALS_FOR_WINDOW,
      need: MIN_SIGNALS_FOR_WINDOW,
    });
  });
});

describe('estimateCalibration', () => {
  it('is null below the minimum sample count', () => {
    const few = Array.from({ length: MIN_SIGNALS_FOR_CALIBRATION - 1 }, (_, i) =>
      signal({ id: `s${i}` }),
    );
    expect(estimateCalibration(few)).toBeNull();
  });

  it('reports the median ratio of actual to estimated', () => {
    const many = Array.from({ length: MIN_SIGNALS_FOR_CALIBRATION }, (_, i) =>
      signal({ id: `s${i}`, actualDurationMinutes: 60, estimatedDurationMinutes: 30 }),
    );
    const calibration = estimateCalibration(many);
    expect(calibration).not.toBeNull();
    expect(calibration!.ratio).toBe(2);
    expect(calibration!.sampleCount).toBe(MIN_SIGNALS_FOR_CALIBRATION);
  });

  it('skips records missing either side of the ratio', () => {
    const mixed = [
      ...Array.from({ length: MIN_SIGNALS_FOR_CALIBRATION }, (_, i) =>
        signal({ id: `ok${i}`, actualDurationMinutes: 45, estimatedDurationMinutes: 45 }),
      ),
      signal({ id: 'noActual', actualDurationMinutes: null }),
      signal({ id: 'noEstimate', estimatedDurationMinutes: null }),
      signal({ id: 'zeroEstimate', estimatedDurationMinutes: 0 }),
    ];
    const calibration = estimateCalibration(mixed);
    expect(calibration!.sampleCount).toBe(MIN_SIGNALS_FOR_CALIBRATION);
    expect(calibration!.ratio).toBe(1);
  });
});

describe('calibrationProgress', () => {
  function usable(count: number): SchedulingSignal[] {
    return Array.from({ length: count }, (_, i) =>
      signal({ id: `ok${i}`, actualDurationMinutes: 60, estimatedDurationMinutes: 30 }),
    );
  }

  const unusable = [
    signal({ id: 'noActual', actualDurationMinutes: null }),
    signal({ id: 'noEstimate', estimatedDurationMinutes: null }),
    signal({ id: 'zeroEstimate', estimatedDurationMinutes: 0 }),
    signal({ id: 'negativeEstimate', estimatedDurationMinutes: -30 }),
  ];

  it('is zero of the threshold with no signals at all', () => {
    expect(calibrationProgress([])).toEqual({ have: 0, need: MIN_SIGNALS_FOR_CALIBRATION });
  });

  it('reports the count so far while the calibration is still null', () => {
    expect(calibrationProgress(usable(3))).toEqual({ have: 3, need: MIN_SIGNALS_FOR_CALIBRATION });
    expect(estimateCalibration(usable(3))).toBeNull();
  });

  it('is full exactly where estimateCalibration stops being null', () => {
    const enough = usable(MIN_SIGNALS_FOR_CALIBRATION);
    expect(calibrationProgress(enough).have).toBe(MIN_SIGNALS_FOR_CALIBRATION);
    expect(estimateCalibration(enough)).not.toBeNull();
  });

  it('caps at the threshold so a long-running install cannot read "41 of 8"', () => {
    expect(calibrationProgress(usable(41))).toEqual({
      have: MIN_SIGNALS_FOR_CALIBRATION,
      need: MIN_SIGNALS_FOR_CALIBRATION,
    });
  });

  it('ignores the signals estimateCalibration ignores, which windowProgress still counts', () => {
    // different thresholds on purpose: counting every signal while gating on ones with both
    // durations would show "8 of 8 logged" above a still-learning line
    const mixed = [...usable(4), ...unusable];
    expect(calibrationProgress(mixed).have).toBe(4);
    expect(windowProgress(mixed).have).toBe(4 + unusable.length);
  });

  it('reaches the threshold exactly when estimateCalibration turns non-null', () => {
    for (let count = MIN_SIGNALS_FOR_CALIBRATION - 2; count <= MIN_SIGNALS_FOR_CALIBRATION + 1; count += 1) {
      const straddling = [...usable(count), ...unusable];
      expect(calibrationProgress(straddling).have >= MIN_SIGNALS_FOR_CALIBRATION).toBe(
        estimateCalibration(straddling) !== null,
      );
    }
  });
});

describe('blockLengthMultiplier (SCHEDULING.md 3b)', () => {
  it('is exactly 1.0 below MIN_SAMPLES_FOR_DURATION_MULTIPLIER, a lower bar than MIN_SIGNALS_FOR_CALIBRATION', () => {
    expect(MIN_SAMPLES_FOR_DURATION_MULTIPLIER).toBeLessThan(MIN_SIGNALS_FOR_CALIBRATION);
    const four = Array.from({ length: MIN_SAMPLES_FOR_DURATION_MULTIPLIER - 1 }, (_, i) =>
      signal({ id: `s${i}`, actualDurationMinutes: 90, estimatedDurationMinutes: 30 }),
    );
    expect(blockLengthMultiplier(four)).toBe(1.0);
  });

  it('acts on the ratio as soon as the fifth sample lands', () => {
    const five = Array.from({ length: MIN_SAMPLES_FOR_DURATION_MULTIPLIER }, (_, i) =>
      signal({ id: `s${i}`, actualDurationMinutes: 45, estimatedDurationMinutes: 30 }),
    );
    expect(blockLengthMultiplier(five)).toBeCloseTo(1.5, 5);
  });

  it('clamps to the documented range', () => {
    const long = Array.from({ length: 6 }, (_, i) =>
      signal({ id: `s${i}`, actualDurationMinutes: 300, estimatedDurationMinutes: 30 }),
    );
    expect(blockLengthMultiplier(long)).toBe(DURATION_MULTIPLIER_MAX);
    const short = Array.from({ length: 6 }, (_, i) =>
      signal({ id: `s${i}`, actualDurationMinutes: 3, estimatedDurationMinutes: 30 }),
    );
    expect(blockLengthMultiplier(short)).toBe(DURATION_MULTIPLIER_MIN);
  });
});

describe('weekdayCapacities (SCHEDULING.md 3c)', () => {
  const NOW_MONDAY = new Date(2026, 8, 7, 18, 0, 0, 0); // monday evening

  function focusSession(startedAt: Date, minutes: number): FocusSession {
    return session({
      id: `fs-${startedAt.getTime()}`,
      startedAt: startedAt.toISOString(),
      endedAt: new Date(startedAt.getTime() + minutes * MINUTE).toISOString(),
      durationSeconds: minutes * 60,
    });
  }

  it('falls back to typicalSessionMinutes * 2 below MIN_OBSERVATIONS_FOR_CAPACITY', () => {
    const tooFew = Array.from({ length: MIN_OBSERVATIONS_FOR_CAPACITY - 1 }, (_, i) =>
      focusSession(new Date(NOW_MONDAY.getTime() - (i + 1) * 7 * DAY), 90),
    );
    const capacities = weekdayCapacities(tooFew, NOW_MONDAY, 20);
    const monday = capacities.get(1);
    expect(monday?.learned).toBe(false);
    expect(monday?.minutes).toBe(40);
  });

  it('learns the median of the last four occurrences once there is enough evidence', () => {
    const sessions = [1, 2, 3, 4].map((weeksAgo) =>
      focusSession(new Date(NOW_MONDAY.getTime() - weeksAgo * 7 * DAY), 60),
    );
    const capacities = weekdayCapacities(sessions, NOW_MONDAY, 30);
    const monday = capacities.get(1);
    expect(monday?.learned).toBe(true);
    expect(monday?.minutes).toBeCloseTo(60, 0);
  });

  it('ignores a fifth, older occurrence beyond the last four', () => {
    const recentFour = [1, 2, 3, 4].map((weeksAgo) =>
      focusSession(new Date(NOW_MONDAY.getTime() - weeksAgo * 7 * DAY), 60),
    );
    const veryOldOutlier = focusSession(new Date(NOW_MONDAY.getTime() - 20 * 7 * DAY), 500);
    const capacities = weekdayCapacities([...recentFour, veryOldOutlier], NOW_MONDAY, 30);
    expect(capacities.get(1)?.minutes).toBeCloseTo(60, 0);
  });

  it("shrinks a thinly-observed weekday toward the median across all weekdays", () => {
    // monday: three sessions at 100 minutes. every other weekday: four at 30
    const sessions: FocusSession[] = [];
    for (let day = 0; day < 7; day += 1) {
      const minutes = day === 1 ? 100 : 30;
      const occurrences = day === 1 ? 3 : 4;
      for (let i = 1; i <= occurrences; i += 1) {
        const daysAgo = i * 7 + ((NOW_MONDAY.getDay() - day + 7) % 7);
        sessions.push(focusSession(new Date(NOW_MONDAY.getTime() - daysAgo * DAY), minutes));
      }
    }
    const capacities = weekdayCapacities(sessions, NOW_MONDAY, 30);
    const monday = capacities.get(1)!;
    expect(monday.learned).toBe(true);
    expect(monday.minutes).toBeLessThan(100);
    expect(monday.minutes).toBeGreaterThan(30);
  });
});

describe('focusSecondsInPeriod', () => {
  it('sums completed sessions inside the window', () => {
    const sessions = [
      session({ id: 'a', durationSeconds: 1800 }),
      session({ id: 'b', durationSeconds: 900 }),
      session({ id: 'old', durationSeconds: 3600, startedAt: new Date(NOW.getTime() - 30 * DAY).toISOString() }),
      session({ id: 'running', durationSeconds: null }),
    ];
    expect(focusSecondsInPeriod(sessions, NOW, 7)).toBe(2700);
  });
});

describe('isOverdue', () => {
  it('is true only for incomplete tasks past their due date', () => {
    const past = new Date(NOW.getTime() - HOUR).toISOString();
    expect(isOverdue(task({ dueDate: past }), NOW)).toBe(true);
    expect(isOverdue(task({ dueDate: past, status: 'complete' }), NOW)).toBe(false);
    expect(isOverdue(task(), NOW)).toBe(false);
  });
});

describe('scheduledToday', () => {
  it('includes both confirmed and proposed times on today', () => {
    const confirmed = task({ id: 'a', startTime: new Date(2026, 8, 7, 20, 0).toISOString() });
    const proposed = task({ id: 'b', proposedTime: new Date(2026, 8, 7, 21, 0).toISOString() });
    const tomorrow = task({ id: 'c', startTime: new Date(2026, 8, 8, 9, 0).toISOString() });
    const done = task({
      id: 'd',
      status: 'complete',
      startTime: new Date(2026, 8, 7, 10, 0).toISOString(),
    });
    const result = scheduledToday([confirmed, proposed, tomorrow, done], NOW);
    expect(result.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });
});

describe('highestPriorityTask', () => {
  it('is null when everything is complete', () => {
    expect(highestPriorityTask([task({ status: 'complete' })], NOW)).toBeNull();
    expect(highestPriorityTask([], NOW)).toBeNull();
  });

  it('puts an overdue task ahead of one due sooner in absolute terms', () => {
    const overdue = task({ id: 'overdue', dueDate: new Date(NOW.getTime() - DAY).toISOString() });
    const soon = task({ id: 'soon', dueDate: new Date(NOW.getTime() + HOUR).toISOString() });
    expect(highestPriorityTask([soon, overdue], NOW)!.id).toBe('overdue');
  });

  it('orders by due date among tasks that are not overdue', () => {
    const later = task({ id: 'later', dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString() });
    const sooner = task({ id: 'sooner', dueDate: new Date(NOW.getTime() + DAY).toISOString() });
    expect(highestPriorityTask([later, sooner], NOW)!.id).toBe('sooner');
  });

  it('prefers a task that already has a time when due dates match', () => {
    const due = new Date(NOW.getTime() + DAY).toISOString();
    const unscheduled = task({ id: 'unscheduled', dueDate: due });
    const scheduled = task({
      id: 'scheduled',
      dueDate: due,
      proposedTime: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
    });
    expect(highestPriorityTask([unscheduled, scheduled], NOW)!.id).toBe('scheduled');
  });

  it('is deterministic for otherwise identical tasks', () => {
    const due = new Date(NOW.getTime() + DAY).toISOString();
    const a = task({ id: 'aaa', dueDate: due });
    const b = task({ id: 'bbb', dueDate: due });
    expect(highestPriorityTask([a, b], NOW)!.id).toBe(highestPriorityTask([b, a], NOW)!.id);
  });

  it('does not mutate the array it was given', () => {
    const tasks = [task({ id: 'b' }), task({ id: 'a' })];
    highestPriorityTask(tasks, NOW);
    expect(tasks.map((t) => t.id)).toEqual(['b', 'a']);
  });
});
