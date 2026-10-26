import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '@/data/migrations';
import { planNotifications } from '@/services/notificationPlan';
import type { Task } from '@/types';

// pinned to UTC+05:30, where a UTC hour straddles two local hours, so a cap
// bucketed by UTC hour would let two reminders through in one local hour
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'Asia/Kolkata';
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

function task(id: string, startTime: Date, now: Date): Task {
  return {
    id,
    title: 'Chapter 4 notes',
    subject: null,
    description: null,
    dueDate: new Date(now.getTime() + 20 * 86_400_000).toISOString(),
    startTime: startTime.toISOString(),
    proposedTime: null,
    durationMinutes: 30,
    status: 'not_started',
    scheduleStatus: 'pinned',
    subtasks: [],
    starterAction: null,
    breakdownSource: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
  };
}

describe('planNotifications hourly cap, half-hour offset zone', () => {
  it('runs in the zone it claims to', () => {
    expect(new Date('2026-09-01T00:00:00Z').getTimezoneOffset()).toBe(-330);
  });

  it('allows one reminder per local clock hour, not per UTC hour', () => {
    const now = new Date(2026, 8, 1, 8, 0);
    // 10:10 and 10:40 local share an hour but are 04:40Z and 05:10Z
    const plan = planNotifications(
      [task('a', new Date(2026, 8, 1, 10, 25), now), task('b', new Date(2026, 8, 1, 10, 55), now)],
      { ...DEFAULT_SETTINGS, notificationsEnabled: true, quietHoursStart: 0, quietHoursEnd: 0, maxNotificationsPerHour: 1 },
      now,
    );
    expect(plan.filter((n) => n.kind === 'best_time').map((n) => n.taskId)).toEqual(['a']);
  });
});
