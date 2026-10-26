import { describe, expect, it } from 'vitest';

import { ALL_LEGACY_KEYS, STORAGE_KEYS, type StorageMeta } from '@/data/keys';
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS } from '@/data/migrations';
import { hydrate } from '@/data/hydrate';
import { MemoryRepository } from '@/data/memoryRepository';
import type { Task } from '@/types';

// regression: a missing meta key alone must not trigger migration 1. over current collections it
// would read the absent legacy keys as empty and overwrite the real data

const NOW = new Date('2026-09-19T12:00:00Z');

const TASK: Task = {
  id: 'task-1',
  title: 'Finish the lab report',
  subject: 'Chemistry',
  description: null,
  dueDate: NOW.toISOString(),
  startTime: null,
  proposedTime: null,
  durationMinutes: null,
  status: 'not_started',
  scheduleStatus: 'unscheduled',
  subtasks: [],
  starterAction: null,
  breakdownSource: null,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  completedAt: null,
};

describe('hydrate: meta-absent guard', () => {
  it('(c) current keys present, no meta, no legacy keys: keeps the data and writes a fresh meta instead of migrating', async () => {
    const repository = new MemoryRepository({
      initial: {
        [STORAGE_KEYS.tasks]: JSON.stringify([TASK]),
        [STORAGE_KEYS.settings]: JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true }),
        // no meta key, the shape a botched wipe left behind
      },
    });

    const hydrated = await hydrate(repository);

    expect(hydrated.migrated).toBe(false);
    expect(hydrated.recoveredFromBackup).toBe(false);
    expect(hydrated.tasks).toHaveLength(1);
    expect(hydrated.tasks[0].title).toBe('Finish the lab report');
    expect(hydrated.settings.onboardingComplete).toBe(true);
    expect(hydrated.meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    const storedMeta = await repository.load<StorageMeta>(STORAGE_KEYS.meta);
    expect(storedMeta).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      lastRescheduleAt: null,
      installedAt: expect.any(String),
    });

    const storedTasks = await repository.load<Task[]>(STORAGE_KEYS.tasks);
    expect(storedTasks).toHaveLength(1);
  });

  it('(d) legacy keys present, no meta: still migrates (existing behavior unchanged)', async () => {
    const repository = new MemoryRepository({
      initial: {
        'dandelion-tasks': JSON.stringify({
          state: {
            tasks: [
              {
                id: 'legacy-1',
                title: 'Legacy task',
                status: 'not_started',
                createdAt: NOW.toISOString(),
              },
            ],
          },
          version: 0,
        }),
      },
    });

    const hydrated = await hydrate(repository);

    expect(hydrated.migrated).toBe(true);
    expect(hydrated.tasks).toHaveLength(1);
    expect(hydrated.tasks[0].title).toBe('Legacy task');
    expect(hydrated.meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    for (const key of ALL_LEGACY_KEYS) {
      expect(await repository.load(key)).toBeNull();
    }
  });

  it('a genuinely fresh install (no keys at all) keeps its current behavior', async () => {
    const repository = new MemoryRepository();

    const hydrated = await hydrate(repository);

    expect(hydrated.tasks).toHaveLength(0);
    expect(hydrated.sessions).toHaveLength(0);
    expect(hydrated.signals).toHaveLength(0);
    expect(hydrated.settings).toEqual(DEFAULT_SETTINGS);
    expect(hydrated.meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('hydrate: interrupted import', () => {
  const META: StorageMeta = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    lastRescheduleAt: null,
    installedAt: NOW.toISOString(),
  };

  it('restores the pre-import snapshot when the marker survived a crash, and removes the marker last', async () => {
    const half = { ...TASK, id: 'half-imported', title: 'Half-imported task' };
    const repository = new MemoryRepository({
      initial: {
        [STORAGE_KEYS.meta]: JSON.stringify(META),
        // the import died after writing tasks
        [STORAGE_KEYS.tasks]: JSON.stringify([half]),
        [STORAGE_KEYS.settings]: JSON.stringify({ ...DEFAULT_SETTINGS, displayName: 'Imported' }),
        [STORAGE_KEYS.backupPreImport]: JSON.stringify({
          format: 'tether-backup',
          formatVersion: 1,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          exportedAt: NOW.toISOString(),
          tasks: [TASK],
          sessions: [],
          signals: [],
          settings: { ...DEFAULT_SETTINGS, displayName: 'Original', onboardingComplete: true },
        }),
      },
    });

    const hydrated = await hydrate(repository);

    expect(hydrated.recoveredFromBackup).toBe(true);
    expect(hydrated.tasks.map((t) => t.id)).toEqual(['task-1']);
    expect(hydrated.settings.displayName).toBe('Original');
    expect(await repository.load(STORAGE_KEYS.tasks)).toEqual([TASK]);
    expect(await repository.load(STORAGE_KEYS.backupPreImport)).toBeNull();
  });

  it('drops a marker too damaged to restore from without touching the data', async () => {
    const repository = new MemoryRepository({
      initial: {
        [STORAGE_KEYS.meta]: JSON.stringify(META),
        [STORAGE_KEYS.tasks]: JSON.stringify([TASK]),
        [STORAGE_KEYS.backupPreImport]: JSON.stringify({ tasks: 'nope' }),
      },
    });

    const hydrated = await hydrate(repository);

    expect(hydrated.tasks.map((t) => t.id)).toEqual(['task-1']);
    expect(hydrated.recoveredFromBackup).toBe(false);
    expect(await repository.load(STORAGE_KEYS.backupPreImport)).toBeNull();
  });
});

describe('hydrate: damaged settings', () => {
  it('tolerates calendarEvents that is not an array, or holds non-objects, instead of throwing', async () => {
    const meta: StorageMeta = { schemaVersion: CURRENT_SCHEMA_VERSION, lastRescheduleAt: null, installedAt: NOW.toISOString() };
    const notArray = new MemoryRepository({
      initial: {
        [STORAGE_KEYS.meta]: JSON.stringify(meta),
        [STORAGE_KEYS.settings]: JSON.stringify({ ...DEFAULT_SETTINGS, calendarEvents: 'oops' }),
      },
    });
    await expect(hydrate(notArray)).resolves.toMatchObject({ settings: { calendarEvents: [] } });

    const event = { id: 'e1', title: 'Practice', date: '2026-09-20', startTime: '15:00', endTime: '16:00', createdAt: NOW.toISOString() };
    const mixed = new MemoryRepository({
      initial: {
        [STORAGE_KEYS.meta]: JSON.stringify(meta),
        [STORAGE_KEYS.settings]: JSON.stringify({ ...DEFAULT_SETTINGS, calendarEvents: [null, 3, event] }),
      },
    });
    const hydrated = await hydrate(mixed);
    expect(hydrated.settings.calendarEvents).toEqual([{ ...event, repeatDays: [] }]);
  });
});
