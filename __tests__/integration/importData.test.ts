import { describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '@/data/keys';
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS } from '@/data/migrations';
import { MemoryRepository } from '@/data/memoryRepository';
import { WriteQueue } from '@/data/writeQueue';
import { BACKUP_FORMAT_VERSION, buildBackup, serializeBackup } from '@/services/backup';
import { importAllData, type ImportDataDeps } from '@/store/importData';
import { createSchedulingStore } from '@/store/schedulingStore';
import { createSessionStore } from '@/store/sessionStore';
import { createSettingsStore } from '@/store/settingsStore';
import { createTaskStore } from '@/store/taskStore';
import type { BackupFile } from '@/types';

const NOW = new Date('2026-09-05T12:00:00.000Z');

function buildStores(debounceMs = 0) {
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

  const settings = createSettingsStore(base, { ...DEFAULT_SETTINGS, displayName: 'Original Name' });
  const scheduling = createSchedulingStore(base, []);
  const tasks = createTaskStore(
    {
      ...base,
      settingsStore: { getState: settings.getState },
      schedulingStore: { getState: scheduling.getState },
      sessionStore: { getState: () => ({ sessions: [] }) },
    },
    [],
  );
  const sessions = createSessionStore(
    { ...base, taskStore: { getState: tasks.getState }, schedulingStore: { getState: scheduling.getState } },
    [],
  );

  return { repository, queue, settings, scheduling, tasks, sessions };
}

function noopNotificationStore(): ImportDataDeps['notificationStore'] {
  return { getState: () => ({ syncNotifications: () => {}, flushNotifications: async () => {} }) };
}

function makeDeps(
  ctx: ReturnType<typeof buildStores>,
  notificationStore: ImportDataDeps['notificationStore'] = noopNotificationStore(),
): ImportDataDeps {
  return {
    repository: ctx.repository,
    flushWrites: () => ctx.queue.flush(),
    currentSchemaVersion: CURRENT_SCHEMA_VERSION,
    currentFormatVersion: BACKUP_FORMAT_VERSION,
    now: () => NOW,
    taskStore: ctx.tasks,
    settingsStore: ctx.settings,
    sessionStore: ctx.sessions,
    schedulingStore: ctx.scheduling,
    notificationStore,
  };
}

// ids distinct from anything the tests start with
function incomingFile(overrides: Partial<BackupFile> = {}): BackupFile {
  return buildBackup({
    tasks: [
      {
        id: 'incoming-task',
        title: 'Incoming task',
        subject: null,
        description: null,
        dueDate: '2026-09-12T00:00:00.000Z',
        startTime: null,
        proposedTime: null,
        durationMinutes: null,
        status: 'not_started',
        scheduleStatus: 'unscheduled',
        subtasks: [],
        starterAction: null,
        breakdownSource: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        completedAt: null,
      },
    ],
    sessions: [
      {
        id: 'incoming-session',
        taskId: 'incoming-task',
        taskTitleSnapshot: 'Incoming task',
        subtaskId: null,
        startedAt: '2026-09-01T15:00:00.000Z',
        endedAt: '2026-09-01T15:20:00.000Z',
        durationSeconds: 1200,
        breaksTaken: 0,
        breakSecondsTotal: 0,
        completedSubtaskIds: [],
        endReason: 'completed',
      },
    ],
    signals: [
      {
        id: 'incoming-signal',
        taskId: 'incoming-task',
        dayOfWeek: 3,
        hourOfDay: 15,
        outcome: 'completed',
        actualDurationMinutes: 20,
        estimatedDurationMinutes: 20,
        recordedAt: '2026-09-01T15:20:00.000Z',
      },
    ],
    settings: { ...DEFAULT_SETTINGS, displayName: 'Incoming Name' },
    schemaVersion: CURRENT_SCHEMA_VERSION,
    now: NOW,
    ...overrides,
  });
}

describe('importAllData', () => {
  it('replaces every store, never merges, and returns the counts imported', async () => {
    const ctx = buildStores();

    const existingTaskId = ctx.tasks.getState().addTask({
      title: 'Pre-existing task',
      dueDate: NOW.toISOString(),
    });
    await ctx.queue.flush();
    expect(ctx.tasks.getState().tasks.map((t) => t.id)).toEqual([existingTaskId]);

    const file = incomingFile();
    const result = await importAllData(serializeBackup(file), makeDeps(ctx));

    expect(result).toEqual({ ok: true, counts: { tasks: 1, sessions: 1 } });

    expect(ctx.tasks.getState().tasks.map((t) => t.id)).toEqual(['incoming-task']);
    expect(ctx.sessions.getState().sessions.map((s) => s.id)).toEqual(['incoming-session']);
    expect(ctx.sessions.getState().activeSession).toBeNull();
    expect(ctx.scheduling.getState().signals.map((s) => s.id)).toEqual(['incoming-signal']);
    expect(ctx.settings.getState().displayName).toBe('Incoming Name');

    expect(await ctx.repository.load(STORAGE_KEYS.tasks)).toEqual(file.tasks);
    expect(await ctx.repository.load(STORAGE_KEYS.sessions)).toEqual(file.sessions);
    expect(await ctx.repository.load(STORAGE_KEYS.signals)).toEqual(file.signals);
    expect(await ctx.repository.load(STORAGE_KEYS.settings)).toEqual(file.settings);
  });

  it('writes the pre-import state to tether:v1:backup-preImport before replacing anything, and removes it once every write landed', async () => {
    const ctx = buildStores();

    const existingTaskId = ctx.tasks.getState().addTask({
      title: 'Pre-existing task',
      dueDate: NOW.toISOString(),
    });
    ctx.settings.getState().updateSetting('displayName', 'Original Name');
    await ctx.queue.flush();

    // capture at write time, a successful import removes it
    let snapshotAtWrite: BackupFile | null = null;
    const realSave = ctx.repository.save.bind(ctx.repository);
    vi.spyOn(ctx.repository, 'save').mockImplementation(async (key: string, value: unknown) => {
      if (key === STORAGE_KEYS.backupPreImport) snapshotAtWrite = JSON.parse(JSON.stringify(value)) as BackupFile;
      return realSave(key as never, value);
    });
    const logStart = ctx.repository.writeLog.length;

    const result = await importAllData(serializeBackup(incomingFile()), makeDeps(ctx));
    expect(result.ok).toBe(true);

    expect(ctx.repository.writeLog.slice(logStart)[0]).toBe(STORAGE_KEYS.backupPreImport);
    const snapshot = snapshotAtWrite as BackupFile | null;
    expect(snapshot?.tasks.map((t) => t.id)).toEqual([existingTaskId]);
    expect(snapshot?.settings.displayName).toBe('Original Name');
    // left behind, it tells hydrate on next launch that an import died part-way
    expect(await ctx.repository.load(STORAGE_KEYS.backupPreImport)).toBeNull();
  });

  it('leaves every store and the repository untouched when the file fails to parse', async () => {
    const ctx = buildStores();

    const existingTaskId = ctx.tasks.getState().addTask({
      title: 'Pre-existing task',
      dueDate: NOW.toISOString(),
    });
    await ctx.queue.flush();
    const keysBefore = await ctx.repository.keys();
    const rawBefore = await ctx.repository.load(STORAGE_KEYS.tasks);

    const result = await importAllData('not json at all {{{', makeDeps(ctx));

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('not-json');

    expect(await ctx.repository.keys()).toEqual(keysBefore);
    expect(await ctx.repository.load(STORAGE_KEYS.backupPreImport)).toBeNull();
    expect(await ctx.repository.load(STORAGE_KEYS.tasks)).toEqual(rawBefore);

    expect(ctx.tasks.getState().tasks.map((t) => t.id)).toEqual([existingTaskId]);
  });

  it('leaves state untouched when the format is wrong', async () => {
    const ctx = buildStores();
    const existingTaskId = ctx.tasks.getState().addTask({ title: 'Keep me', dueDate: NOW.toISOString() });
    await ctx.queue.flush();

    const result = await importAllData(JSON.stringify({ format: 'something-else' }), makeDeps(ctx));

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('wrong-format');
    expect(ctx.tasks.getState().tasks.map((t) => t.id)).toEqual([existingTaskId]);
    expect(await ctx.repository.load(STORAGE_KEYS.backupPreImport)).toBeNull();
  });

  it('leaves state untouched when the schema version is newer than the app understands', async () => {
    const ctx = buildStores();
    const existingTaskId = ctx.tasks.getState().addTask({ title: 'Keep me', dueDate: NOW.toISOString() });
    await ctx.queue.flush();

    const file = incomingFile({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
    const result = await importAllData(serializeBackup(file), makeDeps(ctx));

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('newer-schema-version');
    expect(ctx.tasks.getState().tasks.map((t) => t.id)).toEqual([existingTaskId]);
    expect(await ctx.repository.load(STORAGE_KEYS.backupPreImport)).toBeNull();
  });

  it('does not let a write queued just before the import resurrect the old value afterward', async () => {
    vi.useFakeTimers();
    try {
      const ctx = buildStores(300); // a real debounce window this time
      ctx.tasks.getState().addTask({ title: 'Stale pending write', dueDate: NOW.toISOString() });
      // left debounced in the queue on purpose, not flushed before the import
      expect(ctx.queue.isDirty).toBe(true);

      const result = await importAllData(serializeBackup(incomingFile()), makeDeps(ctx));
      expect(result.ok).toBe(true);

      // had the import written before flushing, this would fire the old timer and restore the pre-import tasks
      await vi.advanceTimersByTimeAsync(500);
      expect(await ctx.repository.load(STORAGE_KEYS.tasks)).toEqual([
        expect.objectContaining({ id: 'incoming-task' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rolls back disk and keeps the pre-import in-memory state when a collection write rejects, and surfaces write-failed the way runtime.ts maps it', async () => {
    const ctx = buildStores();

    const existingTaskId = ctx.tasks.getState().addTask({ title: 'Pre-existing task', dueDate: NOW.toISOString() });
    await ctx.queue.flush();
    const preExistingSession = {
      id: 'pre-session',
      taskId: existingTaskId,
      taskTitleSnapshot: 'Pre-existing task',
      subtaskId: null,
      startedAt: '2026-09-01T10:00:00.000Z',
      endedAt: '2026-09-01T10:15:00.000Z',
      durationSeconds: 900,
      breaksTaken: 0,
      breakSecondsTotal: 0,
      completedSubtaskIds: [],
      endReason: 'completed' as const,
    };
    const preExistingSignal = {
      id: 'pre-signal',
      taskId: existingTaskId,
      dayOfWeek: 1 as const,
      hourOfDay: 10,
      outcome: 'completed' as const,
      actualDurationMinutes: 15,
      estimatedDurationMinutes: 15,
      recordedAt: '2026-09-01T10:15:00.000Z',
    };
    ctx.sessions.setState({ sessions: [preExistingSession], activeSession: null });
    ctx.scheduling.setState({ signals: [preExistingSignal] });
    const tasksBefore = ctx.tasks.getState().tasks;

    // fail the third of the four collection saves, leaving the write half-done
    const collectionKeys = new Set<string>([
      STORAGE_KEYS.tasks,
      STORAGE_KEYS.sessions,
      STORAGE_KEYS.signals,
      STORAGE_KEYS.settings,
    ]);
    let collectionSaveCount = 0;
    const realSave = ctx.repository.save.bind(ctx.repository);
    vi.spyOn(ctx.repository, 'save').mockImplementation(async (key: string, value: unknown) => {
      if (collectionKeys.has(key)) {
        collectionSaveCount += 1;
        if (collectionSaveCount === 3) {
          throw new Error('disk full');
        }
      }
      return realSave(key as never, value);
    });
    const syncNotifications = vi.fn();
    const flushNotifications = vi.fn(async () => {});

    // mirrors the write-failed mapping in store/runtime.ts, which cannot load in Node
    // because its platform imports resolve to the throwing stub
    let result: { ok: false; reason: string; detail?: string };
    try {
      await importAllData(
        serializeBackup(incomingFile()),
        makeDeps(ctx, { getState: () => ({ syncNotifications, flushNotifications }) }),
      );
      throw new Error('expected importAllData to reject');
    } catch (error) {
      result = { ok: false, reason: 'write-failed', detail: error instanceof Error ? error.message : String(error) };
    }
    expect(result).toEqual({ ok: false, reason: 'write-failed', detail: 'disk full' });

    expect(ctx.tasks.getState().tasks).toBe(tasksBefore);
    expect(ctx.sessions.getState().sessions).toEqual([preExistingSession]);
    expect(ctx.scheduling.getState().signals).toEqual([preExistingSignal]);
    expect(ctx.settings.getState().displayName).toBe('Original Name');

    // disk is rolled back too, including the two keys already overwritten
    expect((await ctx.repository.load<{ id: string }[]>(STORAGE_KEYS.tasks))?.map((t) => t.id)).toEqual([
      existingTaskId,
    ]);
    expect(await ctx.repository.load(STORAGE_KEYS.sessions)).toEqual([preExistingSession]);
    expect(await ctx.repository.load(STORAGE_KEYS.signals)).toEqual([preExistingSignal]);
    expect(await ctx.repository.load(STORAGE_KEYS.backupPreImport)).toBeNull();
    expect(syncNotifications).toHaveBeenCalledTimes(1);
  });

  it('leaves the crash marker for the next launch when the rollback itself fails', async () => {
    const ctx = buildStores();
    ctx.tasks.getState().addTask({ title: 'Pre-existing task', dueDate: NOW.toISOString() });
    await ctx.queue.flush();

    const realSave = ctx.repository.save.bind(ctx.repository);
    let failing = false;
    vi.spyOn(ctx.repository, 'save').mockImplementation(async (key: string, value: unknown) => {
      if (key === STORAGE_KEYS.sessions) failing = true;
      if (failing && key !== STORAGE_KEYS.backupPreImport) throw new Error('disk gone');
      return realSave(key as never, value);
    });

    await expect(importAllData(serializeBackup(incomingFile()), makeDeps(ctx))).rejects.toThrow('disk gone');
    expect(await ctx.repository.load(STORAGE_KEYS.backupPreImport)).not.toBeNull();
  });

  it('resyncs notifications after the setState calls, and a notification failure does not fail a completed import', async () => {
    const ctx = buildStores();
    const taskSetState = vi.spyOn(ctx.tasks, 'setState');
    const sessionSetState = vi.spyOn(ctx.sessions, 'setState');
    const schedulingSetState = vi.spyOn(ctx.scheduling, 'setState');
    const settingsSetState = vi.spyOn(ctx.settings, 'setState');
    const syncNotifications = vi.fn();
    const flushNotifications = vi.fn(async () => {
      throw new Error('notification sync failed');
    });

    const result = await importAllData(
      serializeBackup(incomingFile()),
      makeDeps(ctx, { getState: () => ({ syncNotifications, flushNotifications }) }),
    );

    expect(result).toEqual({ ok: true, counts: { tasks: 1, sessions: 1 } });

    expect(syncNotifications).toHaveBeenCalledTimes(1);
    expect(flushNotifications).toHaveBeenCalledTimes(1);

    const lastSetStateOrder = Math.max(
      ...[taskSetState, sessionSetState, schedulingSetState, settingsSetState].map(
        (spy) => spy.mock.invocationCallOrder[0] ?? -1,
      ),
    );
    const syncOrder = syncNotifications.mock.invocationCallOrder[0];
    const flushOrder = flushNotifications.mock.invocationCallOrder[0];
    expect(syncOrder).toBeGreaterThan(lastSetStateOrder);
    expect(flushOrder).toBeGreaterThan(syncOrder);
  });
});
