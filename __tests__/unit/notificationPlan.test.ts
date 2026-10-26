import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '@/data/migrations';
import { isQuietHour, periodFor } from '@/services/periods';
import { planNotifications } from '@/services/notificationPlan';
import type { Task, UserSettings } from '@/types';

const NOW = new Date('2026-09-01T10:00:00.000Z'); // a tuesday
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    ...DEFAULT_SETTINGS,
    notificationsEnabled: true,
    // quiet hours off so each rule is tested alone
    quietHoursStart: 0,
    quietHoursEnd: 0,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  const created = new Date(NOW.getTime() - DAY).toISOString();
  return {
    id: 'task-1',
    title: 'Chapter 4 notes',
    subject: 'Biology',
    description: null,
    dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    startTime: null,
    proposedTime: null,
    durationMinutes: 45,
    status: 'not_started',
    scheduleStatus: 'unscheduled',
    subtasks: [],
    starterAction: 'Open the textbook to chapter 4',
    breakdownSource: null,
    createdAt: created,
    updatedAt: created,
    completedAt: null,
    ...overrides,
  };
}

describe('isQuietHour', () => {
  it('handles a range that wraps midnight', () => {
    // the shipped default, 23:00 to 08:00
    expect(isQuietHour(23, 23, 8)).toBe(true);
    expect(isQuietHour(2, 23, 8)).toBe(true);
    expect(isQuietHour(7, 23, 8)).toBe(true);
    expect(isQuietHour(8, 23, 8)).toBe(false);
    expect(isQuietHour(15, 23, 8)).toBe(false);
    expect(isQuietHour(22, 23, 8)).toBe(false);
  });

  it('handles a range that does not wrap', () => {
    // regression: a range that does not wrap used to report every hour as quiet
    expect(isQuietHour(9, 8, 17)).toBe(true);
    expect(isQuietHour(16, 8, 17)).toBe(true);
    expect(isQuietHour(17, 8, 17)).toBe(false);
    expect(isQuietHour(7, 8, 17)).toBe(false);
    expect(isQuietHour(20, 8, 17)).toBe(false);
  });

  it('treats an empty range as never quiet', () => {
    for (let h = 0; h < 24; h += 1) expect(isQuietHour(h, 0, 0)).toBe(false);
  });
});

describe('periodFor', () => {
  it('covers 06:00 to 23:00 with no gap between periods', () => {
    for (let h = 6; h < 23; h += 1) expect(periodFor(h)).not.toBeNull();
  });

  it('returns null outside the waking day', () => {
    expect(periodFor(5)).toBeNull();
    expect(periodFor(23)).toBeNull();
  });

  it('puts boundary hours in exactly one period', () => {
    expect(periodFor(11)).toBe('morning');
    expect(periodFor(12)).toBe('afternoon');
    expect(periodFor(17)).toBe('afternoon');
    expect(periodFor(18)).toBe('evening');
  });
});

describe('planNotifications', () => {
  it('schedules nothing when notifications are disabled', () => {
    const plan = planNotifications([task()], settings({ notificationsEnabled: false }), NOW);
    expect(plan).toEqual([]);
  });

  it('rule 4: never for a completed task', () => {
    const done = task({
      status: 'complete',
      completedAt: NOW.toISOString(),
      startTime: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
      dueDate: new Date(NOW.getTime() + DAY + HOUR).toISOString(),
    });
    expect(planNotifications([done], settings(), NOW)).toEqual([]);
  });

  it('fires a best-time reminder 15 minutes before the start', () => {
    const start = new Date(NOW.getTime() + 2 * HOUR);
    const plan = planNotifications([task({ startTime: start.toISOString() })], settings(), NOW);
    const best = plan.find((n) => n.kind === 'best_time');
    expect(best).toBeDefined();
    expect(new Date(best!.fireAt).getTime()).toBe(start.getTime() - 15 * 60_000);
  });

  it('uses a proposed time when there is no confirmed one', () => {
    const proposed = new Date(NOW.getTime() + 3 * HOUR);
    const plan = planNotifications([task({ proposedTime: proposed.toISOString() })], settings(), NOW);
    expect(plan.some((n) => n.kind === 'best_time')).toBe(true);
  });

  it('does not fire a best-time reminder for a start already past', () => {
    const plan = planNotifications(
      [task({ startTime: new Date(NOW.getTime() - HOUR).toISOString() })],
      settings(),
      NOW,
    );
    expect(plan.some((n) => n.kind === 'best_time')).toBe(false);
  });

  it('fires a deadline reminder 24 hours before the due date', () => {
    const due = new Date(NOW.getTime() + 2 * DAY);
    const plan = planNotifications([task({ dueDate: due.toISOString() })], settings(), NOW);
    const deadline = plan.find((n) => n.kind === 'deadline');
    expect(deadline).toBeDefined();
    expect(new Date(deadline!.fireAt).getTime()).toBe(due.getTime() - DAY);
  });

  it('moves the "due tomorrow" reminder out of quiet hours to 17:00 the day before', () => {
    // regression: the default 23:59 due time put this reminder inside the default quiet hours,
    // so it never fired
    const due = new Date('2026-09-04T23:59:00');
    const plan = planNotifications(
      [task({ dueDate: due.toISOString() })],
      settings({ quietHoursStart: 23, quietHoursEnd: 8 }),
      NOW,
    );
    const deadline = plan.find((n) => n.kind === 'deadline');
    expect(deadline).toBeDefined();
    expect(new Date(deadline!.fireAt).getTime()).toBe(new Date('2026-09-03T17:00:00').getTime());
  });

  it('uses the latest non-quiet hour that day when 17:00 is itself quiet', () => {
    const due = new Date('2026-09-04T23:59:00');
    const plan = planNotifications(
      [task({ dueDate: due.toISOString() })],
      settings({ quietHoursStart: 16, quietHoursEnd: 8 }),
      NOW,
    );
    const deadline = plan.find((n) => n.kind === 'deadline');
    expect(new Date(deadline!.fireAt).getTime()).toBe(new Date('2026-09-03T15:00:00').getTime());
  });

  it('keeps the reminder at exactly 24 hours before when that is outside quiet hours', () => {
    const due = new Date('2026-09-04T15:00:00');
    const plan = planNotifications(
      [task({ dueDate: due.toISOString() })],
      settings({ quietHoursStart: 23, quietHoursEnd: 8 }),
      NOW,
    );
    const deadline = plan.find((n) => n.kind === 'deadline');
    expect(new Date(deadline!.fireAt).getTime()).toBe(due.getTime() - DAY);
  });

  it('fires an inactivity nudge only once the due date is within three days', () => {
    // touched 12 hours ago, so the nudge lands a day after that touch
    const recent = new Date(NOW.getTime() - 12 * HOUR).toISOString();
    const near = planNotifications(
      [task({ dueDate: new Date(NOW.getTime() + 2 * DAY).toISOString(), updatedAt: recent })],
      settings(),
      NOW,
    );
    const nudge = near.find((n) => n.kind === 'inactivity');
    expect(nudge).toBeDefined();
    expect(new Date(nudge!.fireAt).getTime()).toBe(NOW.getTime() + 12 * HOUR);

    // due in 6 days: waits until three days before due, however long it has been idle
    const later = planNotifications(
      [task({ dueDate: new Date(NOW.getTime() + 6 * DAY).toISOString() })],
      settings(),
      NOW,
    );
    const laterNudge = later.find((n) => n.kind === 'inactivity');
    expect(new Date(laterNudge!.fireAt).getTime()).toBe(NOW.getTime() + 3 * DAY);

    // three days before an 11-day due date is past the 7-day horizon
    const far = planNotifications(
      [task({ dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString() })],
      settings(),
      NOW,
    );
    expect(far.some((n) => n.kind === 'inactivity')).toBe(false);
  });

  it('does not chase a passed inactivity nudge to "now" on every replan', () => {
    // regression: a passed nudge was rescheduled to now + 1 minute, so it fired after every app open
    const stale = task({
      dueDate: new Date(NOW.getTime() + 2 * DAY).toISOString(),
      updatedAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
    });
    for (const minutesLater of [0, 30, 120, 600]) {
      const at = new Date(NOW.getTime() + minutesLater * 60_000);
      expect(planNotifications([stale], settings(), at).some((n) => n.kind === 'inactivity')).toBe(false);
    }
  });

  it('keeps the inactivity fire time fixed as the clock advances', () => {
    const t = task({
      dueDate: new Date(NOW.getTime() + 2 * DAY).toISOString(),
      updatedAt: new Date(NOW.getTime() - 6 * HOUR).toISOString(),
    });
    const fireAts = [0, 1, 3, 10].map((hoursLater) => {
      const plan = planNotifications([t], settings(), new Date(NOW.getTime() + hoursLater * HOUR));
      return plan.find((n) => n.kind === 'inactivity')?.fireAt;
    });
    expect(new Set(fireAts).size).toBe(1);
    expect(fireAts[0]).toBe(new Date(NOW.getTime() + 18 * HOUR).toISOString());
  });

  it('rule 1: never during quiet hours', () => {
    // the reminder would land at 02:15, inside 23-08
    const start = new Date('2026-09-02T02:30:00');
    const plan = planNotifications(
      [task({ startTime: start.toISOString(), dueDate: new Date(NOW.getTime() + 9 * DAY).toISOString() })],
      settings({ quietHoursStart: 23, quietHoursEnd: 8 }),
      NOW,
    );
    expect(plan.some((n) => n.kind === 'best_time')).toBe(false);
  });

  it('rule 3: never while a weekly busy block covers the fire time', () => {
    // 2026-09-02 is a wednesday, 14:30 is afternoon
    const start = new Date('2026-09-02T14:30:00');
    const blocked = planNotifications(
      [task({ startTime: start.toISOString(), dueDate: new Date(NOW.getTime() + 9 * DAY).toISOString() })],
      settings({ busyBlocks: [{ day: 'wed', period: 'afternoon' }] }),
      NOW,
    );
    expect(blocked.some((n) => n.kind === 'best_time')).toBe(false);

    const clear = planNotifications(
      [task({ startTime: start.toISOString(), dueDate: new Date(NOW.getTime() + 9 * DAY).toISOString() })],
      settings({ busyBlocks: [{ day: 'thu', period: 'afternoon' }] }),
      NOW,
    );
    expect(clear.some((n) => n.kind === 'best_time')).toBe(true);
  });

  it('rule 3: never while a one-off event covers the fire time', () => {
    const start = new Date('2026-09-02T14:30:00');
    const plan = planNotifications(
      [task({ startTime: start.toISOString(), dueDate: new Date(NOW.getTime() + 9 * DAY).toISOString() })],
      settings({
        calendarEvents: [
          {
            id: 'e1',
            title: 'Dentist',
            date: '2026-09-02',
            startTime: '14:00',
            endTime: '15:00',
            repeatDays: [],
            createdAt: NOW.toISOString(),
          },
        ],
      }),
      NOW,
    );
    expect(plan.some((n) => n.kind === 'best_time')).toBe(false);
  });

  // the horizon is 7 days, so the anchor date is in the past and the occurrence just ahead.
  // regression: matching on `date` alone covered only the anchor day
  const weeklyWednesday = {
    id: 'e1',
    title: 'Practice',
    date: '2026-08-05', // a wednesday, four weeks before the occurrence below
    startTime: '14:00',
    endTime: '15:00',
    repeatDays: ['wed'] as const,
    createdAt: NOW.toISOString(),
  };

  it('rule 3: never while a repeating event covers the fire time, weeks after its start date', () => {
    const start = new Date('2026-09-02T14:30:00'); // a wednesday
    const plan = planNotifications(
      [task({ startTime: start.toISOString(), dueDate: new Date(NOW.getTime() + 9 * DAY).toISOString() })],
      settings({ calendarEvents: [{ ...weeklyWednesday, repeatDays: ['wed'] }] }),
      NOW,
    );
    expect(plan.some((n) => n.kind === 'best_time')).toBe(false);
  });

  it('rule 3: a repeating event does not cover a weekday it does not list', () => {
    const start = new Date('2026-09-03T14:30:00'); // the thursday after
    const plan = planNotifications(
      [task({ startTime: start.toISOString(), dueDate: new Date(NOW.getTime() + 9 * DAY).toISOString() })],
      settings({ calendarEvents: [{ ...weeklyWednesday, repeatDays: ['wed'] }] }),
      NOW,
    );
    expect(plan.some((n) => n.kind === 'best_time')).toBe(true);
  });

  it('rule 3: a repeating event covers nothing before its own start date', () => {
    const start = new Date('2026-09-02T14:30:00'); // the wednesday before it begins
    const plan = planNotifications(
      [task({ startTime: start.toISOString(), dueDate: new Date(NOW.getTime() + 9 * DAY).toISOString() })],
      settings({
        calendarEvents: [{ ...weeklyWednesday, date: '2026-09-09', repeatDays: ['wed'] }],
      }),
      NOW,
    );
    expect(plan.some((n) => n.kind === 'best_time')).toBe(true);
  });

  it('rule 2: caps notifications per clock hour', () => {
    // regression: maxNotificationsPerHour used to be ignored entirely
    const base = new Date(NOW.getTime() + 3 * HOUR).getTime();
    const tasks = Array.from({ length: 6 }, (_, i) =>
      task({
        id: `task-${i}`,
        startTime: new Date(base + i * 60_000).toISOString(),
        dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
      }),
    );
    const plan = planNotifications(tasks, settings({ maxNotificationsPerHour: 1 }), NOW);
    expect(plan).toHaveLength(1);
  });

  it('rule 2: the earliest notification in a contested hour is the one kept', () => {
    const base = new Date(NOW.getTime() + 3 * HOUR).getTime();
    const tasks = [
      task({ id: 'late', startTime: new Date(base + 10 * 60_000).toISOString(), dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString() }),
      task({ id: 'early', startTime: new Date(base).toISOString(), dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString() }),
    ];
    const plan = planNotifications(tasks, settings({ maxNotificationsPerHour: 1 }), NOW);
    expect(plan).toHaveLength(1);
    expect(plan[0].taskId).toBe('early');
  });

  it('rule 2: a cap of zero schedules nothing', () => {
    const plan = planNotifications(
      [task({ startTime: new Date(NOW.getTime() + 2 * HOUR).toISOString() })],
      settings({ maxNotificationsPerHour: 0 }),
      NOW,
    );
    expect(plan).toEqual([]);
  });

  it('allows more per hour when the user raises the cap', () => {
    const base = new Date(NOW.getTime() + 3 * HOUR).getTime();
    const tasks = Array.from({ length: 4 }, (_, i) =>
      task({
        id: `task-${i}`,
        startTime: new Date(base + i * 60_000).toISOString(),
        dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
      }),
    );
    const plan = planNotifications(tasks, settings({ maxNotificationsPerHour: 3 }), NOW);
    expect(plan).toHaveLength(3);
  });

  it('gives every notification a stable id so a replan replaces rather than duplicates', () => {
    const t = task({ startTime: new Date(NOW.getTime() + 2 * HOUR).toISOString() });
    const first = planNotifications([t], settings({ maxNotificationsPerHour: 10 }), NOW);
    const second = planNotifications([t], settings({ maxNotificationsPerHour: 10 }), NOW);
    expect(first.map((n) => n.id)).toEqual(second.map((n) => n.id));
    expect(new Set(first.map((n) => n.id)).size).toBe(first.length);
  });

  it('writes copy that is direct and never guilt-inducing', () => {
    const plan = planNotifications(
      [task({ startTime: new Date(NOW.getTime() + 2 * HOUR).toISOString() })],
      settings({ maxNotificationsPerHour: 10 }),
      NOW,
    );
    const forbidden = /behind|failed|overdue|you should|why haven|still not/i;
    for (const n of plan) {
      expect(n.title).not.toMatch(forbidden);
      expect(n.body).not.toMatch(forbidden);
    }
  });

  it('schedules nothing beyond the horizon', () => {
    const plan = planNotifications(
      [task({ dueDate: new Date(NOW.getTime() + 60 * DAY).toISOString() })],
      settings(),
      NOW,
    );
    expect(plan).toEqual([]);
  });
});
