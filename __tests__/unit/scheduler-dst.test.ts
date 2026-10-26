import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '@/data/migrations';
import { forecastFeasibility, proposeSlot } from '@/services/scheduler';
import type { Task, UserSettings } from '@/types';

// pinned to a US zone so the 25-hour fall-back day (1 nov 2026) is the same on every machine.
// Node re-reads TZ on assignment, and every Date below is built inside a test
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
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
    subject: null,
    description: null,
    dueDate: new Date(2026, 10, 3).toISOString(),
    startTime: null,
    proposedTime: null,
    durationMinutes: 60,
    status: 'not_started',
    scheduleStatus: 'unscheduled',
    subtasks: [],
    starterAction: null,
    breakdownSource: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    completedAt: null,
    proposedAt: null,
    ...overrides,
  };
}

describe('scheduler across the US fall-back date (TZ=America/New_York)', () => {
  it('runs in the zone it claims to', () => {
    // 25 hours between local midnights on 1 nov 2026
    expect(new Date(2026, 10, 2).getTime() - new Date(2026, 10, 1).getTime()).toBe(25 * 3_600_000);
  });

  it('blocks a calendar event at its own wall-clock time on the 25-hour day', () => {
    // midnight + 15h would land at 14:00 local and block the wrong hour
    const now = new Date(2026, 10, 1, 14, 0);
    const proposal = proposeSlot({
      task: task({ dueDate: new Date(2026, 10, 1, 16, 0).toISOString(), durationMinutes: 60 }),
      otherTasks: [],
      settings: settings({
        calendarEvents: [
          {
            id: 'e1',
            title: 'Practice',
            date: '2026-11-01',
            startTime: '15:00',
            endTime: '16:00',
            repeatDays: [],
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      }),
      signals: [],
      now,
    });
    expect(proposal).not.toBeNull();
    expect(new Date(proposal!.startIso).getHours()).toBe(14);
  });

  it('blocks a repeating event at its wall-clock time on the 25-hour day', () => {
    const now = new Date(2026, 10, 1, 14, 0);
    const proposal = proposeSlot({
      task: task({ dueDate: new Date(2026, 10, 1, 16, 0).toISOString(), durationMinutes: 60 }),
      otherTasks: [],
      settings: settings({
        calendarEvents: [
          {
            id: 'e1',
            title: 'Practice',
            date: '2026-10-04',
            startTime: '15:00',
            endTime: '16:00',
            repeatDays: ['sun'],
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      }),
      signals: [],
      now,
    });
    expect(proposal).not.toBeNull();
    expect(new Date(proposal!.startIso).getHours()).toBe(14);
  });

  it('forecastFeasibility keys each day by its own local date after the change', () => {
    // fallback capacity is 60 a day and monday 2 nov is already full, so 120. stepping by
    // fixed 24h reads sunday's empty commitments for monday and reports 180
    const result = forecastFeasibility({
      task: task({ dueDate: new Date(2026, 10, 3, 0, 0).toISOString(), durationMinutes: 30 }),
      otherTasks: [
        task({
          id: 'other',
          startTime: new Date(2026, 10, 2, 10, 0).toISOString(),
          durationMinutes: 60,
          scheduleStatus: 'pinned',
        }),
      ],
      sessions: [],
      settings: settings(),
      signals: [],
      now: new Date(2026, 9, 31, 9, 0),
    });
    expect(result.availableMinutes).toBe(120);
  });
});
