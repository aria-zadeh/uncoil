import { describe, expect, it, vi } from 'vitest';

import { ClearAllDataError } from '@/data/clearAll';
import { STORAGE_KEYS, type StorageKey, type StorageMeta } from '@/data/keys';
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS } from '@/data/migrations';
import { hydrate } from '@/data/hydrate';
import { MemoryRepository } from '@/data/memoryRepository';
import type { Repository } from '@/data/repository';
import { WriteQueue } from '@/data/writeQueue';
import type { PlannedNotification } from '@/services/notificationPlan';
import { resetAllData } from '@/store/resetAllData';
import { createNotificationStore, type NotificationAdapter } from '@/store/notificationStore';
import { createSchedulingStore } from '@/store/schedulingStore';
import { createSessionStore } from '@/store/sessionStore';
import { createSettingsStore } from '@/store/settingsStore';
import { createTaskStore, type StoreDeps } from '@/store/taskStore';
import type { BreakdownResult } from '@/types';

const NOW = new Date('2026-09-07T13:00:00'); // a Monday, mid-afternoon, outside quiet hours
const DAY = 24 * 60 * 60 * 1000;

function fakeAdapter(): {
  adapter: NotificationAdapter;
  live: Map<string, PlannedNotification>;
  cancelled: string[];
  // one entry per cancelAll() call
  cancelAllCalls: true[];
  setThrowOnGetPermissionStatus: (shouldThrow: boolean) => void;
  setThrowOnCancelOne: (shouldThrow: boolean) => void;
  setThrowOnCancelAll: (shouldThrow: boolean) => void;
} {
  const live = new Map<string, PlannedNotification>();
  const cancelled: string[] = [];
  const cancelAllCalls: true[] = [];
  let throwOnGetPermissionStatus = false;
  let throwOnCancelOne = false;
  let throwOnCancelAll = false;
  const adapter: NotificationAdapter = {
    requestPermission: async () => 'granted',
    getPermissionStatus: async () => {
      if (throwOnGetPermissionStatus) throw new Error('permission check unavailable');
      return 'granted';
    },
    cancelOne: async (id) => {
      if (throwOnCancelOne) throw new Error(`cancelOne unavailable for ${id}`);
      live.delete(id);
      cancelled.push(id);
    },
    scheduleOne: async (n) => {
      live.set(n.id, n);
    },
    cancelAll: async () => {
      cancelAllCalls.push(true);
      if (throwOnCancelAll) throw new Error('cancelAll unavailable');
      for (const id of live.keys()) cancelled.push(id);
      live.clear();
    },
    getScheduledIds: async () => [...live.keys()],
  };
  return {
    adapter,
    live,
    cancelled,
    cancelAllCalls,
    setThrowOnGetPermissionStatus: (shouldThrow) => {
      throwOnGetPermissionStatus = shouldThrow;
    },
    setThrowOnCancelOne: (shouldThrow) => {
      throwOnCancelOne = shouldThrow;
    },
    setThrowOnCancelAll: (shouldThrow) => {
      throwOnCancelAll = shouldThrow;
    },
  };
}

// rejects remove() for one key and delegates everything else, to exercise clearAll's allSettled handling
class FlakyRemoveRepository implements Repository {
  constructor(
    private readonly inner: Repository,
    private readonly failingKey: StorageKey,
  ) {}

  load<T>(key: StorageKey): Promise<T | null> {
    return this.inner.load<T>(key);
  }

  save<T>(key: StorageKey, value: T): Promise<void> {
    return this.inner.save(key, value);
  }

  async remove(key: StorageKey): Promise<void> {
    if (key === this.failingKey) throw new Error(`remove rejected for ${key}`);
    return this.inner.remove(key);
  }

  keys(): Promise<StorageKey[]> {
    return this.inner.keys();
  }
}

function buildStores(debounceMs = 0, taskDeps: Partial<StoreDeps> = {}) {
  const repository = new MemoryRepository();
  const queue = new WriteQueue(repository, { debounceMs });
  let clock = NOW.getTime();
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
    { ...DEFAULT_SETTINGS, onboardingComplete: true, notificationsEnabled: true, displayName: 'Sam' },
  );
  const scheduling = createSchedulingStore(base, []);
  const tasks = createTaskStore(
    {
      ...base,
      settingsStore: { getState: settings.getState },
      schedulingStore: { getState: scheduling.getState },
      sessionStore: { getState: () => ({ sessions: [] }) },
      notificationStore: { getState: () => notification.getState() },
      ...taskDeps,
    },
    [],
  );
  const sessions = createSessionStore(
    { ...base, taskStore: { getState: tasks.getState }, schedulingStore: { getState: scheduling.getState } },
    [],
  );
  const notification = createNotificationStore({
    taskStore: { getState: tasks.getState },
    settingsStore: { getState: settings.getState },
    adapter: fake.adapter,
    now: () => NOW,
    debounceMs: 0,
  });

  return { repository, queue, settings, scheduling, tasks, sessions, notification, fake };
}

describe('resetAllData', () => {
  it('clears every stored key, empties every store, and cancels every scheduled notification', async () => {
    const ctx = buildStores();

    // a schedulable start time so the adapter holds something real, or the cancel check passes vacuously
    const taskId = ctx.tasks.getState().addTask({
      title: 'Chapter 4 notes',
      startTime: new Date('2026-09-07T15:20:00').toISOString(), // fires 15:05, outside quiet hours
      dueDate: new Date(NOW.getTime() + 10 * DAY).toISOString(),
    });
    ctx.scheduling.getState().addSignal({
      taskId,
      dayOfWeek: 1,
      hourOfDay: 15,
      outcome: 'completed',
      actualDurationMinutes: 45,
      estimatedDurationMinutes: 30,
    });
    ctx.sessions.getState().startSession(taskId, null);
    ctx.sessions.getState().endSession('completed');

    await ctx.notification.getState().flushNotifications();
    await ctx.queue.flush();

    expect(ctx.fake.live.size).toBeGreaterThan(0);
    expect(ctx.notification.getState().scheduled.length).toBeGreaterThan(0);

    // a crash mid-migration leaves this key behind, and a wipe must remove it too
    await ctx.repository.save(STORAGE_KEYS.backupPreMigration, { tasks: [] });

    await resetAllData({
      repository: ctx.repository,
      flushWrites: () => ctx.queue.flush(),
      now: () => NOW,
      taskStore: ctx.tasks,
      settingsStore: ctx.settings,
      sessionStore: ctx.sessions,
      schedulingStore: ctx.scheduling,
      notificationStore: ctx.notification,
    });

    // only a fresh meta survives: hydrate must see the current schema version next launch, or it
    // runs migration 1 against missing legacy keys and wipes whatever the user adds next
    expect(await ctx.repository.keys()).toEqual([STORAGE_KEYS.meta]);
    expect(await ctx.repository.load(STORAGE_KEYS.backupPreMigration)).toBeNull();
    expect(await ctx.repository.load<StorageMeta>(STORAGE_KEYS.meta)).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      lastRescheduleAt: null,
      installedAt: NOW.toISOString(),
    });

    expect(ctx.tasks.getState().tasks).toHaveLength(0);
    expect(ctx.sessions.getState().sessions).toHaveLength(0);
    expect(ctx.sessions.getState().activeSession).toBeNull();
    expect(ctx.scheduling.getState().signals).toHaveLength(0);

    const finalSettings = ctx.settings.getState();
    expect(finalSettings.displayName).toBe(DEFAULT_SETTINGS.displayName);
    expect(finalSettings.onboardingComplete).toBe(DEFAULT_SETTINGS.onboardingComplete);
    expect(finalSettings.notificationsEnabled).toBe(DEFAULT_SETTINGS.notificationsEnabled);
    expect(finalSettings.quietHoursStart).toBe(DEFAULT_SETTINGS.quietHoursStart);

    // cancelled through the adapter, not just forgotten in memory
    expect(ctx.fake.live.size).toBe(0);
    expect(ctx.fake.cancelled).toContain(`best-time:${taskId}`);
    expect(ctx.notification.getState().scheduled).toHaveLength(0);
  });

  it('does not let a write queued just before the reset resurrect a key afterward', async () => {
    vi.useFakeTimers();
    try {
      const ctx = buildStores(300); // a real debounce window this time

      ctx.tasks.getState().addTask({ title: 'Read chapter 4', dueDate: NOW.toISOString() });
      // left debounced in the queue on purpose, not flushed before the reset
      expect(ctx.queue.isDirty).toBe(true);

      await resetAllData({
        repository: ctx.repository,
        flushWrites: () => ctx.queue.flush(),
        now: () => NOW,
        taskStore: ctx.tasks,
        settingsStore: ctx.settings,
        sessionStore: ctx.sessions,
        schedulingStore: ctx.scheduling,
        notificationStore: ctx.notification,
      });

      expect(await ctx.repository.keys()).toEqual([STORAGE_KEYS.meta]);

      // had the reset cleared before flushing, this would fire the old timer and recreate the tasks key
      await vi.advanceTimersByTimeAsync(500);
      expect(await ctx.repository.keys()).toEqual([STORAGE_KEYS.meta]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes every key it can when one remove() rejects, resets the stores anyway, and names the failed key', async () => {
    const ctx = buildStores();

    ctx.tasks.getState().addTask({ title: 'Read chapter 4', dueDate: NOW.toISOString() });
    ctx.settings.getState().updateSetting('displayName', 'Alex');
    await ctx.queue.flush();

    const keysBefore = await ctx.repository.keys();
    expect(keysBefore).toEqual(expect.arrayContaining([STORAGE_KEYS.tasks, STORAGE_KEYS.settings]));

    const flaky = new FlakyRemoveRepository(ctx.repository, STORAGE_KEYS.settings);

    let caught: unknown;
    try {
      await resetAllData({
        repository: flaky,
        flushWrites: () => ctx.queue.flush(),
        now: () => NOW,
        taskStore: ctx.tasks,
        settingsStore: ctx.settings,
        sessionStore: ctx.sessions,
        schedulingStore: ctx.scheduling,
        notificationStore: ctx.notification,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClearAllDataError);
    expect((caught as ClearAllDataError).failedKeys).toEqual([STORAGE_KEYS.settings]);

    // checked on the unwrapped repository, flaky only intercepts remove()
    expect(await ctx.repository.keys()).toEqual([STORAGE_KEYS.settings]);

    // the finally in store/resetAllData.ts, not an early return, is what resets the stores here
    expect(ctx.tasks.getState().tasks).toHaveLength(0);
    expect(ctx.sessions.getState().sessions).toHaveLength(0);
    expect(ctx.scheduling.getState().signals).toHaveLength(0);
    expect(ctx.settings.getState().displayName).toBe(DEFAULT_SETTINGS.displayName);
  });

  it('cancels every scheduled notification even when getPermissionStatus throws', async () => {
    const ctx = buildStores();
    ctx.tasks.getState().addTask({
      title: 'Chapter 4 notes',
      startTime: new Date('2026-09-07T15:20:00').toISOString(), // fires 15:05, outside quiet hours
      dueDate: new Date(NOW.getTime() + 10 * DAY).toISOString(),
    });
    await ctx.notification.getState().flushNotifications();
    expect(ctx.fake.live.size).toBeGreaterThan(0);

    ctx.fake.setThrowOnGetPermissionStatus(true);

    await resetAllData({
      repository: ctx.repository,
      flushWrites: () => ctx.queue.flush(),
      now: () => NOW,
      taskStore: ctx.tasks,
      settingsStore: ctx.settings,
      sessionStore: ctx.sessions,
      schedulingStore: ctx.scheduling,
      notificationStore: ctx.notification,
    });

    expect(ctx.fake.live.size).toBe(0);
    expect(ctx.notification.getState().scheduled).toHaveLength(0);
  });

  it('falls back to the unconditional cancelAll() when the diff path itself cannot cancel', async () => {
    const ctx = buildStores();
    ctx.tasks.getState().addTask({
      title: 'Chapter 4 notes',
      startTime: new Date('2026-09-07T15:20:00').toISOString(),
      dueDate: new Date(NOW.getTime() + 10 * DAY).toISOString(),
    });
    await ctx.notification.getState().flushNotifications();
    expect(ctx.fake.live.size).toBeGreaterThan(0);

    // with permission and per-id cancel both broken, applyDiff still drops entries from its own
    // bookkeeping, so only the unconditional cancelAll() actually empties the OS
    ctx.fake.setThrowOnGetPermissionStatus(true);
    ctx.fake.setThrowOnCancelOne(true);

    await resetAllData({
      repository: ctx.repository,
      flushWrites: () => ctx.queue.flush(),
      now: () => NOW,
      taskStore: ctx.tasks,
      settingsStore: ctx.settings,
      sessionStore: ctx.sessions,
      schedulingStore: ctx.scheduling,
      notificationStore: ctx.notification,
    });

    expect(ctx.fake.cancelAllCalls.length).toBe(1);
    expect(ctx.fake.live.size).toBe(0);
  });

  it('still clears the repository and resets the stores when adapter.cancelAll() itself rejects', async () => {
    const ctx = buildStores();

    ctx.tasks.getState().addTask({
      title: 'Chapter 4 notes',
      startTime: new Date('2026-09-07T15:20:00').toISOString(),
      dueDate: new Date(NOW.getTime() + 10 * DAY).toISOString(),
    });
    ctx.settings.getState().updateSetting('displayName', 'Alex');
    await ctx.queue.flush();
    expect(await ctx.repository.keys()).toEqual(
      expect.arrayContaining([STORAGE_KEYS.tasks, STORAGE_KEYS.settings]),
    );

    ctx.fake.setThrowOnCancelAll(true);

    await resetAllData({
      repository: ctx.repository,
      flushWrites: () => ctx.queue.flush(),
      now: () => NOW,
      taskStore: ctx.tasks,
      settingsStore: ctx.settings,
      sessionStore: ctx.sessions,
      schedulingStore: ctx.scheduling,
      notificationStore: ctx.notification,
    });

    // the await above not throwing is part of the check: a notification-only failure must not reach the caller
    expect(await ctx.repository.keys()).toEqual([STORAGE_KEYS.meta]);
    expect(ctx.tasks.getState().tasks).toHaveLength(0);
    expect(ctx.sessions.getState().sessions).toHaveLength(0);
    expect(ctx.scheduling.getState().signals).toHaveLength(0);
    expect(ctx.settings.getState().displayName).toBe(DEFAULT_SETTINGS.displayName);
  });

  it('writes a fresh current-version meta record after the wipe (regression: hydrate must not see version 0)', async () => {
    const ctx = buildStores();
    ctx.tasks.getState().addTask({ title: 'Read chapter 4', dueDate: NOW.toISOString() });
    await ctx.queue.flush();

    await resetAllData({
      repository: ctx.repository,
      flushWrites: () => ctx.queue.flush(),
      now: () => NOW,
      taskStore: ctx.tasks,
      settingsStore: ctx.settings,
      sessionStore: ctx.sessions,
      schedulingStore: ctx.scheduling,
      notificationStore: ctx.notification,
    });

    const meta = await ctx.repository.load<StorageMeta>(STORAGE_KEYS.meta);
    expect(meta).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      lastRescheduleAt: null,
      installedAt: NOW.toISOString(),
    });
  });

  it(
    'regression: a task added after resetAllData survives a later relaunch (hydrate does not ' +
      "run migration 1 against nonexistent legacy keys and empty the collections it just wrote)",
    async () => {
      const ctx = buildStores();
      ctx.tasks.getState().addTask({ title: 'Old task, about to be wiped', dueDate: NOW.toISOString() });
      await ctx.queue.flush();

      await resetAllData({
        repository: ctx.repository,
        flushWrites: () => ctx.queue.flush(),
        now: () => NOW,
        taskStore: ctx.tasks,
        settingsStore: ctx.settings,
        sessionStore: ctx.sessions,
        schedulingStore: ctx.scheduling,
        notificationStore: ctx.notification,
      });

      // onboard again and add a task, the exact steps from the bug report
      ctx.settings.getState().updateSetting('onboardingComplete', true);
      ctx.tasks.getState().addTask({ title: 'New task after wiping everything', dueDate: NOW.toISOString() });
      await ctx.queue.flush();

      // a fresh hydrate over the same repository stands in for the relaunch
      const hydrated = await hydrate(ctx.repository);

      expect(hydrated.migrated).toBe(false);
      expect(hydrated.tasks).toHaveLength(1);
      expect(hydrated.tasks[0].title).toBe('New task after wiping everything');
      expect(hydrated.settings.onboardingComplete).toBe(true);
    },
  );
});

describe('resetAllData with generation in flight', () => {
  it('cancels every generation kind and clears breakdownInFlight and lastBreakdown', async () => {
    const STEPS = [
      { title: 'Open the reading and go through it once', minutes: 10 },
      { title: 'Write down the three points to make', minutes: 10 },
      { title: 'Write the essay in one sitting', minutes: 30 },
    ];
    const result: BreakdownResult = {
      breakdown: { steps: STEPS, starterAction: STEPS[0].title },
      tier: 'model',
      latencyMs: 1,
    };
    let release: (value: BreakdownResult) => void = () => {};
    let calls = 0;
    const cancelGeneration = vi.fn<NonNullable<StoreDeps['cancelGeneration']>>();
    const ctx = buildStores(0, {
      generate: () => {
        calls += 1;
        // the first two answer at once (a breakdown, then a re-breakdown that sets lastBreakdown),
        // the third stays in flight across the reset
        if (calls <= 2) return Promise.resolve(result);
        return new Promise<BreakdownResult>((resolve) => { release = resolve; });
      },
      cancelGeneration,
    });
    const first = ctx.tasks.getState().addTask({
      title: 'Essay',
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    });
    await ctx.tasks.getState().breakdown(first);
    await ctx.tasks.getState().breakdown(first);
    expect(ctx.tasks.getState().lastBreakdown).not.toBeNull();
    const second = ctx.tasks.getState().addTask({
      title: 'Lab report',
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    });
    const pending = ctx.tasks.getState().breakdown(second);
    expect(ctx.tasks.getState().breakdownInFlight).toEqual([second]);

    await resetAllData({
      repository: ctx.repository,
      flushWrites: () => ctx.queue.flush(),
      now: () => NOW,
      taskStore: ctx.tasks,
      settingsStore: ctx.settings,
      sessionStore: ctx.sessions,
      schedulingStore: ctx.scheduling,
      notificationStore: ctx.notification,
    });

    // no kind argument: every generation is abandoned, not just breakdowns
    expect(cancelGeneration).toHaveBeenCalledWith();
    expect(ctx.tasks.getState().breakdownInFlight).toEqual([]);
    expect(ctx.tasks.getState().lastBreakdown).toBeNull();

    release(result);
    await expect(pending).resolves.toBe(false);
    expect(ctx.tasks.getState().tasks).toEqual([]);
  });
});
