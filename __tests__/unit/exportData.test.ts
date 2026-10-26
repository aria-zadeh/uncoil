import { describe, expect, it } from 'vitest';

import { MemoryRepository } from '@/data/memoryRepository';
import { DEFAULT_SETTINGS } from '@/data/migrations';
import { WriteQueue } from '@/data/writeQueue';
import { parseBackup } from '@/services/backup';
import { exportAllData, type ExportDataDeps } from '@/store/exportData';
import { createSchedulingStore } from '@/store/schedulingStore';
import { createSessionStore } from '@/store/sessionStore';
import { createSettingsStore } from '@/store/settingsStore';
import { createTaskStore } from '@/store/taskStore';

// real stores and a fake writeAndShare, so expo-file-system stays out of the graph

const NOW = new Date('2026-09-05T12:00:00.000Z');
const CURRENT_SCHEMA_VERSION = 1;

function buildStores() {
  const repository = new MemoryRepository();
  const queue = new WriteQueue(repository, { debounceMs: 0 });
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

  const settings = createSettingsStore(base, { ...DEFAULT_SETTINGS, displayName: 'Sam' });
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

  return { queue, settings, scheduling, tasks, sessions };
}

function makeDeps(
  ctx: ReturnType<typeof buildStores>,
  writeAndShare: ExportDataDeps['writeAndShare'],
  now: () => Date = () => NOW,
): ExportDataDeps {
  return {
    taskStore: ctx.tasks,
    settingsStore: ctx.settings,
    sessionStore: ctx.sessions,
    schedulingStore: ctx.scheduling,
    currentSchemaVersion: CURRENT_SCHEMA_VERSION,
    now,
    writeAndShare,
  };
}

describe('exportAllData', () => {
  it('names the file uncoil-backup-YYYY-MM-DD.json from the injected date', async () => {
    const ctx = buildStores();
    let capturedFileName: string | undefined;
    const writeAndShare = async (_text: string, fileName: string): Promise<void> => {
      capturedFileName = fileName;
    };

    // noon UTC: backupFileName reads local calendar fields, so midnight UTC would
    // roll back a day anywhere west of UTC
    await exportAllData(makeDeps(ctx, writeAndShare, () => new Date('2026-01-03T12:00:00.000Z')));

    expect(capturedFileName).toBe('uncoil-backup-2026-01-03.json');
  });

  it('pads single-digit month and day in the file name', async () => {
    const ctx = buildStores();
    let capturedFileName: string | undefined;
    const writeAndShare = async (_text: string, fileName: string): Promise<void> => {
      capturedFileName = fileName;
    };

    await exportAllData(makeDeps(ctx, writeAndShare, () => new Date('2026-11-25T12:00:00.000Z')));

    expect(capturedFileName).toBe('uncoil-backup-2026-11-25.json');
  });

  it('hands writeAndShare a payload that parses back to a BackupFile matching the live stores\' tasks', async () => {
    const ctx = buildStores();
    const taskId = ctx.tasks.getState().addTask({ title: 'Write the essay', dueDate: NOW.toISOString() });
    await ctx.queue.flush();

    let capturedText: string | undefined;
    const writeAndShare = async (text: string, _fileName: string): Promise<void> => {
      capturedText = text;
    };

    await exportAllData(makeDeps(ctx, writeAndShare));

    expect(capturedText).toBeDefined();
    const parsed = parseBackup(capturedText as string, CURRENT_SCHEMA_VERSION, 1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected the exported payload to parse as a valid backup');

    expect(parsed.file.tasks.map((t) => t.id)).toEqual([taskId]);
    expect(parsed.file.tasks).toEqual(ctx.tasks.getState().tasks);
  });
});
