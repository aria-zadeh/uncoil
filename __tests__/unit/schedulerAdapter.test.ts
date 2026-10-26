import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '@/data/migrations';
import { proposeSlot } from '@/services/scheduler';
import { proposeForTask } from '@/store/schedulerAdapter';
import type { SettingsState } from '@/store/settingsStore';
import type { ProposeContext } from '@/store/taskStore';
import type { Task, UserSettings } from '@/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// a monday at 09:00 local, the same clock scheduler.test.ts uses
const NOW = new Date(2026, 8, 7, 9, 0, 0, 0);

function userSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    ...DEFAULT_SETTINGS,
    quietHoursStart: 23,
    quietHoursEnd: 8,
    energyPeakStart: 15,
    energyPeakEnd: 17,
    typicalSessionMinutes: 30,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'target',
    title: 'Chapter 4 notes',
    subject: 'Biology',
    description: null,
    dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    startTime: null,
    proposedTime: null,
    durationMinutes: 60,
    status: 'not_started',
    scheduleStatus: 'unscheduled',
    subtasks: [],
    starterAction: null,
    breakdownSource: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    completedAt: null,
    ...overrides,
  };
}

// the store passes its whole SettingsState, actions included, to a service that only declares UserSettings
function settingsState(overrides: Partial<UserSettings> = {}): SettingsState {
  return {
    ...userSettings(overrides),
    updateSetting: () => {},
    completeOnboarding: () => {},
    setEnergyPeak: () => {},
    toggleBusyBlock: () => {},
    setAvailabilityNotes: () => {},
    addCalendarEvent: () => '',
    updateCalendarEvent: () => {},
    deleteCalendarEvent: () => {},
  } as SettingsState;
}

function context(overrides: Partial<ProposeContext> = {}): ProposeContext {
  const target = task();
  return {
    task: target,
    allTasks: [target],
    settings: settingsState(),
    signals: [],
    ...overrides,
  };
}

describe('proposeForTask', () => {
  it('returns the start time the scheduler chose', () => {
    const ctx = context();
    const direct = proposeSlot({
      task: ctx.task,
      otherTasks: [],
      settings: ctx.settings,
      signals: [],
      now: NOW,
    });

    expect(direct).not.toBeNull();
    expect(proposeForTask(ctx, NOW)).toEqual({ startTime: direct?.startIso });
  });

  it('excludes the task being scheduled from its own occupancy', () => {
    // the store passes every task, the target included, so unfiltered it would collide with itself
    const target = task({ startTime: new Date(NOW.getTime() + 6 * HOUR).toISOString() });
    const withSelf = proposeForTask(context({ task: target, allTasks: [target] }), NOW);
    const withoutSelf = proposeForTask(context({ task: target, allTasks: [] }), NOW);

    expect(withSelf).toEqual(withoutSelf);
  });

  it('does count other scheduled tasks as occupancy', () => {
    const target = task();
    const alone = proposeForTask(context({ task: target, allTasks: [target] }), NOW);

    // fill the whole first candidate day with other work
    const blockers = Array.from({ length: 12 }, (_, i) =>
      task({
        id: `other-${i}`,
        startTime: new Date(NOW.getTime() + (1 + i) * HOUR).toISOString(),
        durationMinutes: 60,
      }),
    );
    const crowded = proposeForTask(
      context({ task: target, allTasks: [target, ...blockers] }),
      NOW,
    );

    expect(alone).not.toBeNull();
    expect(crowded).not.toEqual(alone);
  });

  it('returns null rather than a fabricated time when nothing fits', () => {
    const overdue = task({ dueDate: new Date(NOW.getTime() - 10 * DAY).toISOString() });
    expect(proposeForTask(context({ task: overdue, allTasks: [overdue] }), NOW)).toBeNull();
  });

  it('respects settings carried through from the store', () => {
    const morning = proposeForTask(
      context({ settings: settingsState({ energyPeakStart: 9, energyPeakEnd: 11 }) }),
      NOW,
    );
    const evening = proposeForTask(
      context({ settings: settingsState({ energyPeakStart: 19, energyPeakEnd: 21 }) }),
      NOW,
    );

    expect(morning).not.toEqual(evening);
  });

  it('produces a parseable ISO 8601 start time', () => {
    const result = proposeForTask(context(), NOW);
    expect(result).not.toBeNull();
    expect(Number.isNaN(Date.parse(result!.startTime))).toBe(false);
  });
});
