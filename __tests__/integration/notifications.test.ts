import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '@/data/migrations';
import { MemoryRepository } from '@/data/memoryRepository';
import { WriteQueue } from '@/data/writeQueue';
import { dayKeyFor, periodFor } from '@/services/periods';
import type { PlannedNotification } from '@/services/notificationPlan';
import type { PermissionOutcome } from '@/services/notifications';
import { createNotificationStore, type NotificationAdapter } from '@/store/notificationStore';
import { createSchedulingStore } from '@/store/schedulingStore';
import { createSettingsStore } from '@/store/settingsStore';
import { createTaskStore, type ProposeContext, type ProposedSlot } from '@/store/taskStore';
import type { Task } from '@/types';

// the notification hard rules, checked through real task and settings stores with a fake adapter.
// local (non-Z) date strings keep getHours() and the written clock time in agreement on any host

const NOW = new Date('2026-09-07T13:00:00'); // a Monday, mid-afternoon, outside quiet hours
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function fakeAdapter(): {
  adapter: NotificationAdapter;
  live: Map<string, PlannedNotification>;
  cancelled: string[];
  scheduled: string[];
  setPermission: (outcome: PermissionOutcome) => void;
} {
  const live = new Map<string, PlannedNotification>();
  const cancelled: string[] = [];
  const scheduled: string[] = [];
  let permission: PermissionOutcome = 'granted';
  const adapter: NotificationAdapter = {
    requestPermission: async () => permission,
    getPermissionStatus: async () => permission,
    cancelOne: async (id) => {
      live.delete(id);
      cancelled.push(id);
    },
    scheduleOne: async (n) => {
      live.set(n.id, n);
      scheduled.push(n.id);
    },
    // required by NotificationAdapter, unused by the diff path tested here
    cancelAll: async () => {
      for (const id of live.keys()) cancelled.push(id);
      live.clear();
    },
    getScheduledIds: async () => [...live.keys()],
  };
  return { adapter, live, cancelled, scheduled, setPermission: (outcome) => (permission = outcome) };
}

function buildStores(
  options: {
    propose?: (context: ProposeContext) => ProposedSlot | null;
    // set earlier for a task whose updatedAt starts well in the past
    clockStart?: number;
    notificationNow?: () => Date;
  } = {},
) {
  const repository = new MemoryRepository();
  const queue = new WriteQueue(repository, { debounceMs: 0 });
  let clock = options.clockStart ?? NOW.getTime();
  let counter = 0;
  const base = {
    queue,
    now: () => {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    newId: () => `id-${String(counter++).padStart(4, '0')}`,
  };

  const fake = fakeAdapter();

  // forward references: nothing calls these closures until a later sync, when `notification` is assigned
  const settings = createSettingsStore(
    { ...base, notificationStore: { getState: () => notification.getState() } },
    { ...DEFAULT_SETTINGS, onboardingComplete: true, notificationsEnabled: true },
  );
  const scheduling = createSchedulingStore(base, []);
  const tasks = createTaskStore(
    {
      ...base,
      settingsStore: { getState: settings.getState },
      schedulingStore: { getState: scheduling.getState },
      sessionStore: { getState: () => ({ sessions: [] }) },
      notificationStore: { getState: () => notification.getState() },
      propose: options.propose,
    },
    [],
  );
  const notification = createNotificationStore({
    taskStore: { getState: tasks.getState },
    settingsStore: { getState: settings.getState },
    adapter: fake.adapter,
    now: options.notificationNow ?? (() => NOW),
    debounceMs: 0,
  });

  return { repository, queue, settings, scheduling, tasks, notification, fake };
}

function fixtureTask(overrides: Partial<Task> = {}): Task {
  const created = new Date(NOW.getTime() - DAY).toISOString();
  return {
    id: 'task-1',
    title: 'Chapter 4 notes',
    subject: null,
    description: null,
    dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
    startTime: new Date('2026-09-07T16:00:00').toISOString(), // fires 15:45, outside quiet hours
    proposedTime: null,
    durationMinutes: 30,
    status: 'not_started',
    scheduleStatus: 'unscheduled',
    subtasks: [],
    starterAction: null,
    breakdownSource: null,
    createdAt: created,
    updatedAt: created,
    completedAt: null,
    ...overrides,
  };
}

describe('notification sync through the store layer', () => {
  it('never schedules a notification during quiet hours', async () => {
    const ctx = buildStores();

    // a 07:10 start puts the reminder at 06:55, inside the default 23:00-08:00 quiet range
    const start = new Date('2026-09-08T07:10:00');
    const id = ctx.tasks.getState().addTask({
      title: 'Chapter 4 notes',
      startTime: start.toISOString(),
      // beyond the 7-day horizon, so no deadline notification joins in
      dueDate: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    });

    await ctx.notification.getState().flushNotifications();

    expect(ctx.notification.getState().scheduled.find((n) => n.taskId === id)).toBeUndefined();
    expect(ctx.fake.live.has(`best-time:${id}`)).toBe(false);
  });

  it('never schedules more than maxNotificationsPerHour', async () => {
    const ctx = buildStores();
    expect(ctx.settings.getState().maxNotificationsPerHour).toBe(1);

    // both reminders fire in clock hour 15, outside quiet hours, with nothing in the way
    const earlyId = ctx.tasks.getState().addTask({
      title: 'Read chapter 4',
      startTime: new Date('2026-09-07T15:20:00').toISOString(), // fires 15:05
      dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
    });
    const lateId = ctx.tasks.getState().addTask({
      title: 'Problem set 3',
      startTime: new Date('2026-09-07T15:35:00').toISOString(), // fires 15:20
      dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
    });

    await ctx.notification.getState().flushNotifications();

    const scheduled = ctx.notification.getState().scheduled;
    expect(scheduled).toHaveLength(1);
    // the earlier one wins the hour, the later is dropped rather than deferred
    expect(scheduled[0].taskId).toBe(earlyId);
    expect(scheduled.some((n) => n.taskId === lateId)).toBe(false);
  });

  it('never schedules while a busy block covers the fire time, and cancels one that no longer clears it', async () => {
    const ctx = buildStores();

    const start = new Date('2026-09-07T15:20:00'); // fires 15:05, afternoon
    const id = ctx.tasks.getState().addTask({
      title: 'Bio lab report',
      startTime: start.toISOString(),
      dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
    });

    await ctx.notification.getState().flushNotifications();
    const beforeId = `best-time:${id}`;
    expect(ctx.fake.live.has(beforeId)).toBe(true);

    const fireAt = new Date(start.getTime() - 15 * MINUTE);
    const day = dayKeyFor(fireAt);
    const period = periodFor(fireAt.getHours());
    expect(period).not.toBeNull();
    ctx.settings.getState().toggleBusyBlock({ day, period: period! });

    await ctx.notification.getState().flushNotifications();

    expect(ctx.fake.live.has(beforeId)).toBe(false);
    expect(ctx.fake.cancelled).toContain(beforeId);
    expect(ctx.notification.getState().scheduled.find((n) => n.taskId === id)).toBeUndefined();
  });

  it('cancels a task\'s notifications on completion, never duplicates, and leaves an unchanged plan alone', async () => {
    const ctx = buildStores();

    const id = ctx.tasks.getState().addTask({
      title: 'English essay',
      startTime: new Date('2026-09-07T16:00:00').toISOString(), // fires 15:45
      dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
    });

    await ctx.notification.getState().flushNotifications();
    const bestTimeId = `best-time:${id}`;
    expect(ctx.fake.live.has(bestTimeId)).toBe(true);
    expect(ctx.fake.scheduled.filter((scheduledId) => scheduledId === bestTimeId)).toHaveLength(1);

    ctx.notification.getState().syncNotifications();
    await ctx.notification.getState().flushNotifications();
    expect(ctx.fake.scheduled.filter((scheduledId) => scheduledId === bestTimeId)).toHaveLength(1);
    expect(ctx.fake.cancelled).not.toContain(bestTimeId);

    const ids = ctx.notification.getState().scheduled.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);

    ctx.tasks.getState().completeTask(id);
    await ctx.notification.getState().flushNotifications();

    expect(ctx.notification.getState().scheduled.find((n) => n.taskId === id)).toBeUndefined();
    expect(ctx.fake.live.has(bestTimeId)).toBe(false);
    expect(ctx.fake.cancelled).toContain(bestTimeId);
  });

  it('requests permission only through the store action, and records the outcome', async () => {
    const ctx = buildStores();
    expect(ctx.notification.getState().permissionStatus).toBe('unknown');

    const outcome = await ctx.notification.getState().requestPermission();

    expect(outcome).toBe('granted');
    expect(ctx.notification.getState().permissionStatus).toBe('granted');
  });

  it("cancels a completed task's notifications when completion comes from toggling its last subtask", async () => {
    // regression: toggleSubtask can complete a task without setTaskStatus, and it is the focus
    // screen's checkbox, so dropping its sync call must fail here
    const ctx = buildStores();
    const id = ctx.tasks.getState().addTask({
      title: 'Read chapter 4',
      startTime: new Date('2026-09-07T16:00:00').toISOString(), // fires 15:45
      dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
    });
    ctx.tasks.getState().addSubtasks(id, [{ title: 'Open the book', estimatedMinutes: 5 }]);

    await ctx.notification.getState().flushNotifications();
    const bestTimeId = `best-time:${id}`;
    expect(ctx.fake.live.has(bestTimeId)).toBe(true);

    const subtaskId = ctx.tasks.getState().tasks.find((t) => t.id === id)!.subtasks[0].id;
    ctx.tasks.getState().toggleSubtask(id, subtaskId);
    expect(ctx.tasks.getState().tasks.find((t) => t.id === id)!.status).toBe('complete');

    await ctx.notification.getState().flushNotifications();

    expect(ctx.fake.live.has(bestTimeId)).toBe(false);
    expect(ctx.fake.cancelled).toContain(bestTimeId);
  });

  it('records a sync failure on lastError instead of throwing, so nothing escapes as an unhandled rejection', async () => {
    // the debounced path has no caller to catch a rejection, and vitest fails on unhandled
    // rejections, so passing at all is part of the proof
    let calls = 0;
    const fake = fakeAdapter();
    const notification = createNotificationStore({
      taskStore: {
        getState: () => {
          calls += 1;
          if (calls === 1) throw new Error('boom');
          return { tasks: [] };
        },
      },
      settingsStore: { getState: () => ({ ...DEFAULT_SETTINGS, notificationsEnabled: true }) },
      adapter: fake.adapter,
      now: () => NOW,
      debounceMs: 0,
    });

    expect(notification.getState().lastError).toBeNull();
    notification.getState().syncNotifications();
    await expect(notification.getState().flushNotifications()).resolves.toBeUndefined();

    expect(notification.getState().lastError).toBeInstanceOf(Error);
    expect(notification.getState().lastError?.message).toBe('boom');

    notification.getState().syncNotifications();
    await notification.getState().flushNotifications();
    expect(notification.getState().lastError).toBeNull();
  });

  it('serializes overlapping syncs so each entry is scheduled exactly once', async () => {
    // regression: a second sync arriving mid-flight must chain after the first, not race it from the same stale baseline
    const ctx = buildStores();
    const id = ctx.tasks.getState().addTask({
      title: 'Bio lab report',
      startTime: new Date('2026-09-07T16:00:00').toISOString(), // fires 15:45
      dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
    });

    // addTask already armed a sync. both flushes start in the same turn, so the second enqueues
    // while the first is still unsettled
    const first = ctx.notification.getState().flushNotifications();
    ctx.notification.getState().syncNotifications();
    const second = ctx.notification.getState().flushNotifications();
    await Promise.all([first, second]);

    const bestTimeId = `best-time:${id}`;
    expect(ctx.fake.scheduled.filter((scheduledId) => scheduledId === bestTimeId)).toHaveLength(1);
  });

  it('schedules nothing and cancels everything once OS permission is no longer granted', async () => {
    // permission can be revoked in system settings at any time, so each sync reads it fresh
    const ctx = buildStores();
    const id = ctx.tasks.getState().addTask({
      title: 'Chapter 4 notes',
      startTime: new Date('2026-09-07T16:00:00').toISOString(), // fires 15:45
      dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
    });
    await ctx.notification.getState().flushNotifications();
    const bestTimeId = `best-time:${id}`;
    expect(ctx.fake.live.has(bestTimeId)).toBe(true);
    expect(ctx.fake.scheduled).toHaveLength(1);

    ctx.fake.setPermission('denied');
    ctx.notification.getState().syncNotifications();
    await ctx.notification.getState().flushNotifications();

    expect(ctx.fake.live.size).toBe(0);
    expect(ctx.fake.cancelled).toContain(bestTimeId);
    expect(ctx.fake.scheduled).toHaveLength(1);
    expect(ctx.notification.getState().permissionStatus).toBe('denied');
    expect(ctx.notification.getState().scheduled).toHaveLength(0);
  });

  it('never stamps updatedAt on a system-initiated reschedule, across repeated sweeps', async () => {
    // the inactivity nudge counts from updatedAt, so a sweep that bumped it would keep the nudge from ever firing
    const FIXED_SLOT = new Date('2026-09-08T10:00:00').toISOString();
    const ctx = buildStores({ propose: () => ({ startTime: FIXED_SLOT }) });

    const id = ctx.tasks.getState().addTask({
      title: 'Read chapter 4',
      dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
    });
    const before = ctx.tasks.getState().tasks.find((t) => t.id === id)!.updatedAt;

    ctx.tasks.getState().rescheduleAll();
    const afterFirstSweep = ctx.tasks.getState().tasks.find((t) => t.id === id)!.updatedAt;
    ctx.tasks.getState().rescheduleAll();
    const afterSecondSweep = ctx.tasks.getState().tasks.find((t) => t.id === id)!.updatedAt;

    expect(afterFirstSweep).toBe(before);
    expect(afterSecondSweep).toBe(before);
  });

  it('makes no OS calls, and does not even write or resync, when a sweep proposes the same slot again', async () => {
    // re-proposing the same slot must neither persist nor resync. notificationStore's own diff would hide
    // the OS churn anyway, so the write-log check is what pins the no-op
    const FIXED_SLOT = new Date('2026-09-08T10:00:00').toISOString();
    const ctx = buildStores({ propose: () => ({ startTime: FIXED_SLOT }) });

    ctx.tasks.getState().addTask({
      title: 'Read chapter 4',
      dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
    });

    ctx.tasks.getState().rescheduleAll();
    await ctx.queue.flush();
    await ctx.notification.getState().flushNotifications();
    const scheduledAfterFirst = ctx.fake.scheduled.length;
    const writesAfterFirst = ctx.repository.writeLog.length;
    expect(scheduledAfterFirst).toBeGreaterThan(0);

    ctx.tasks.getState().rescheduleAll(); // the exact same slot, again
    await ctx.queue.flush();
    await ctx.notification.getState().flushNotifications();

    expect(ctx.repository.writeLog).toHaveLength(writesAfterFirst);
    expect(ctx.fake.scheduled).toHaveLength(scheduledAfterFirst);
    expect(ctx.fake.cancelled).toHaveLength(0);
  });

  it("keeps the inactivity nudge's fire time stable across repeated sweeps, and never re-fires it once passed", async () => {
    // regression: once the nudge's moment passed, every sweep moved it to now + 1 minute, so it
    // fired again on every open. the notification clock advances here so that shows
    const FIXED_SLOT = new Date('2026-09-08T10:00:00').toISOString();
    let notificationNow = NOW.getTime();
    const ctx = buildStores({
      propose: () => ({ startTime: FIXED_SLOT }),
      // last touched 20 hours before NOW, so the nudge is due 4 hours after it
      clockStart: NOW.getTime() - 20 * HOUR,
      notificationNow: () => new Date(notificationNow),
    });

    const id = ctx.tasks.getState().addTask({
      title: 'Read chapter 4',
      dueDate: new Date(NOW.getTime() + 2 * DAY).toISOString(),
    });
    const nudgeOf = () =>
      ctx.notification.getState().scheduled.find((n) => n.taskId === id && n.kind === 'inactivity')?.fireAt;

    ctx.tasks.getState().rescheduleAll();
    await ctx.notification.getState().flushNotifications();
    const firstFire = nudgeOf();
    expect(firstFire).toBeDefined();

    // an hour later, same fire time
    notificationNow += HOUR;
    ctx.tasks.getState().rescheduleAll();
    ctx.notification.getState().syncNotifications();
    await ctx.notification.getState().flushNotifications();
    expect(nudgeOf()).toBe(firstFire);

    // the OS drops a delivered nudge, and later opens must not schedule it again
    ctx.fake.live.delete(`inactivity:${id}`);
    const scheduledBefore = ctx.fake.scheduled.filter((n) => n === `inactivity:${id}`).length;
    for (const hoursLater of [5, 6, 9]) {
      notificationNow = NOW.getTime() + hoursLater * HOUR;
      ctx.notification.getState().syncNotifications();
      await ctx.notification.getState().flushNotifications();
    }
    expect(ctx.fake.scheduled.filter((n) => n === `inactivity:${id}`)).toHaveLength(scheduledBefore);
    expect(nudgeOf()).toBeUndefined();
  });

  it("recomputes a completed task's notifications when the completion comes through updateSubtask", async () => {
    // regression: updateSubtask accepts isComplete but never recomputed the parent status or synced
    const ctx = buildStores();
    const id = ctx.tasks.getState().addTask({
      title: 'Read chapter 4',
      startTime: new Date('2026-09-07T16:00:00').toISOString(), // fires 15:45
      dueDate: new Date(NOW.getTime() + 11 * DAY).toISOString(),
    });
    ctx.tasks.getState().addSubtasks(id, [{ title: 'Open the book', estimatedMinutes: 5 }]);

    await ctx.notification.getState().flushNotifications();
    const bestTimeId = `best-time:${id}`;
    expect(ctx.fake.live.has(bestTimeId)).toBe(true);

    const subtaskId = ctx.tasks.getState().tasks.find((t) => t.id === id)!.subtasks[0].id;
    ctx.tasks.getState().updateSubtask(id, subtaskId, { isComplete: true });
    expect(ctx.tasks.getState().tasks.find((t) => t.id === id)!.status).toBe('complete');

    await ctx.notification.getState().flushNotifications();

    expect(ctx.fake.live.has(bestTimeId)).toBe(false);
    expect(ctx.fake.cancelled).toContain(bestTimeId);
  });

  it('records the first per-entry rejection as lastError, and never counts a failed schedule as scheduled', async () => {
    const fake = fakeAdapter();
    const adapter: NotificationAdapter = {
      ...fake.adapter,
      scheduleOne: async () => {
        throw new Error('OS schedule failed');
      },
    };
    const notification = createNotificationStore({
      taskStore: { getState: () => ({ tasks: [fixtureTask()] }) },
      settingsStore: { getState: () => ({ ...DEFAULT_SETTINGS, notificationsEnabled: true }) },
      adapter,
      now: () => NOW,
      debounceMs: 0,
    });

    notification.getState().syncNotifications();
    await notification.getState().flushNotifications();

    expect(notification.getState().lastError).toBeInstanceOf(Error);
    expect(notification.getState().scheduled).toHaveLength(0);
  });

  it('treats a permission-status check that throws as not-granted, and still cancels stale entries', async () => {
    // regression: a throw here used to skip cancelling what was already scheduled, failing open
    const fake = fakeAdapter();
    let permissionCalls = 0;
    const adapter: NotificationAdapter = {
      ...fake.adapter,
      getPermissionStatus: async () => {
        permissionCalls += 1;
        if (permissionCalls === 1) return 'granted';
        throw new Error('OS permission query failed');
      },
    };
    const notification = createNotificationStore({
      taskStore: { getState: () => ({ tasks: [fixtureTask()] }) },
      settingsStore: { getState: () => ({ ...DEFAULT_SETTINGS, notificationsEnabled: true }) },
      adapter,
      now: () => NOW,
      debounceMs: 0,
    });

    notification.getState().syncNotifications();
    await notification.getState().flushNotifications();
    expect(fake.live.size).toBe(1); // scheduled while permission was granted

    notification.getState().syncNotifications();
    await notification.getState().flushNotifications();

    expect(notification.getState().lastError).toBeInstanceOf(Error);
    expect(notification.getState().permissionStatus).toBe('undetermined');
    expect(fake.live.size).toBe(0);
    expect(notification.getState().scheduled).toHaveLength(0);
  });

  it('cancels, on the first sync of a launch, OS reminders the plan no longer wants', async () => {
    // the last launch scheduled this, then the task was completed and the app killed before the
    // sync ran. `scheduled` starts empty on launch, so a plain diff would never name it
    const fake = fakeAdapter();
    const orphan: PlannedNotification = {
      id: 'best-time:completed-task',
      taskId: 'completed-task',
      kind: 'best_time',
      fireAt: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
      title: 'Good time to start',
      body: 'x',
    };
    fake.live.set(orphan.id, orphan);
    const kept = fixtureTask();
    const notification = createNotificationStore({
      taskStore: { getState: () => ({ tasks: [kept] }) },
      settingsStore: { getState: () => ({ ...DEFAULT_SETTINGS, notificationsEnabled: true }) },
      adapter: fake.adapter,
      now: () => NOW,
      debounceMs: 0,
    });

    notification.getState().syncNotifications();
    await notification.getState().flushNotifications();

    expect(fake.live.has(orphan.id)).toBe(false);
    expect(fake.cancelled).toContain(orphan.id);
    expect(fake.live.has(`best-time:${kept.id}`)).toBe(true);
    expect(notification.getState().lastError).toBeNull();
  });

  it('reads the OS list once per launch, and retries a reconcile read that failed', async () => {
    const fake = fakeAdapter();
    let reads = 0;
    const adapter: NotificationAdapter = {
      ...fake.adapter,
      getScheduledIds: async () => {
        reads += 1;
        if (reads === 1) throw new Error('OS list unavailable');
        return [...fake.live.keys()];
      },
    };
    const notification = createNotificationStore({
      taskStore: { getState: () => ({ tasks: [fixtureTask()] }) },
      settingsStore: { getState: () => ({ ...DEFAULT_SETTINGS, notificationsEnabled: true }) },
      adapter,
      now: () => NOW,
      debounceMs: 0,
    });

    for (let i = 0; i < 3; i += 1) {
      notification.getState().syncNotifications();
      await notification.getState().flushNotifications();
    }
    expect(reads).toBe(2);
  });

  it('retries a failed cancel on the next sync', async () => {
    const fake = fakeAdapter();
    let failCancels = true;
    const adapter: NotificationAdapter = {
      ...fake.adapter,
      cancelOne: async (id) => {
        if (failCancels) throw new Error('OS cancel failed');
        await fake.adapter.cancelOne(id);
      },
    };
    let tasks = [fixtureTask()];
    const notification = createNotificationStore({
      taskStore: { getState: () => ({ tasks }) },
      settingsStore: { getState: () => ({ ...DEFAULT_SETTINGS, notificationsEnabled: true }) },
      adapter,
      now: () => NOW,
      debounceMs: 0,
    });
    notification.getState().syncNotifications();
    await notification.getState().flushNotifications();
    const id = 'best-time:task-1';
    expect(fake.live.has(id)).toBe(true);

    tasks = [fixtureTask({ status: 'complete', completedAt: NOW.toISOString() })];
    notification.getState().syncNotifications();
    await notification.getState().flushNotifications();
    expect(fake.live.has(id)).toBe(true);
    expect(notification.getState().lastError).toBeInstanceOf(Error);

    failCancels = false;
    notification.getState().syncNotifications();
    await notification.getState().flushNotifications();
    expect(fake.live.has(id)).toBe(false);
  });
});
