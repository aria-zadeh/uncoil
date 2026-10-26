import { describe, expect, it } from 'vitest';

import { COLLECTION_KEYS, STORAGE_KEYS } from '@/data/keys';
import { MemoryRepository } from '@/data/memoryRepository';
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS } from '@/data/migrations';
import { hydrate } from '@/data/hydrate';
import {
  completionRate,
  currentStreak,
  estimateCalibration,
  highestPriorityTask,
  productiveWindow,
  scheduledToday,
} from '@/services/insights';
import type { FocusSession, SchedulingSignal, Subtask, Task } from '@/types';

// catches algorithmic blowups in the read and derive path. not the on-device cold-start
// figure, which also covers React mount, bridge startup and first paint

// generous, but still catches something going quadratic
const READ_AND_DERIVE_BUDGET_MS = 400;

const NOW = new Date(2026, 8, 7, 9, 0, 0, 0);
const DAY = 86_400_000;

// a heavy user over one school year
const TASK_COUNT = 500;
const SUBTASKS_PER_TASK = 5;
const SESSION_COUNT = 400;
const SIGNAL_COUNT = 400;
const EVENT_COUNT = 200;

function buildFixture() {
  const tasks: Task[] = [];
  for (let i = 0; i < TASK_COUNT; i += 1) {
    const created = new Date(NOW.getTime() - (TASK_COUNT - i) * 3_600_000).toISOString();
    const subtasks: Subtask[] = Array.from({ length: SUBTASKS_PER_TASK }, (_, j) => ({
      id: `task-${i}-sub-${j}`,
      parentTaskId: `task-${i}`,
      title: `Write section number ${j + 1} of the assignment`,
      estimatedMinutes: 15,
      isComplete: i % 3 === 0,
      order: j,
      completedAt: i % 3 === 0 ? created : null,
    }));
    tasks.push({
      id: `task-${i}`,
      title: `Assignment number ${i} for the term`,
      subject: ['English 2H', 'Biology', 'Algebra II', 'Chemistry'][i % 4],
      description: i % 5 === 0 ? null : `Some context for assignment ${i}.`,
      dueDate: new Date(NOW.getTime() + ((i % 30) - 10) * DAY).toISOString(),
      startTime: i % 4 === 0 ? new Date(NOW.getTime() + (i % 20) * 3_600_000).toISOString() : null,
      proposedTime: i % 4 === 1 ? new Date(NOW.getTime() + (i % 20) * 3_600_000).toISOString() : null,
      durationMinutes: 45,
      status: i % 3 === 0 ? 'complete' : 'not_started',
      scheduleStatus: i % 4 === 0 ? 'confirmed' : 'unscheduled',
      subtasks,
      starterAction: 'Open the assignment sheet and read the prompt',
      breakdownSource: 'template',
      createdAt: created,
      updatedAt: created,
      completedAt: i % 3 === 0 ? new Date(NOW.getTime() - (i % 12) * DAY).toISOString() : null,
    });
  }

  const sessions: FocusSession[] = Array.from({ length: SESSION_COUNT }, (_, i) => ({
    id: `session-${i}`,
    taskId: `task-${i % TASK_COUNT}`,
    taskTitleSnapshot: `Assignment number ${i % TASK_COUNT} for the term`,
    subtaskId: null,
    startedAt: new Date(NOW.getTime() - i * 3_600_000).toISOString(),
    endedAt: new Date(NOW.getTime() - i * 3_600_000 + 2_700_000).toISOString(),
    durationSeconds: 2700,
    breaksTaken: i % 3,
    breakSecondsTotal: (i % 3) * 300,
    completedSubtaskIds: [],
    endReason: 'completed',
  }));

  const signals: SchedulingSignal[] = Array.from({ length: SIGNAL_COUNT }, (_, i) => ({
    id: `signal-${i}`,
    taskId: `task-${i % TASK_COUNT}`,
    dayOfWeek: (i % 7) as SchedulingSignal['dayOfWeek'],
    hourOfDay: 8 + (i % 14),
    outcome: (['completed', 'partial', 'skipped'] as const)[i % 3],
    actualDurationMinutes: 40 + (i % 30),
    estimatedDurationMinutes: 30,
    recordedAt: new Date(NOW.getTime() - (i % 28) * DAY).toISOString(),
  }));

  const settings = {
    ...DEFAULT_SETTINGS,
    onboardingComplete: true,
    calendarEvents: Array.from({ length: EVENT_COUNT }, (_, i) => ({
      id: `event-${i}`,
      title: `Event ${i}`,
      date: '2026-09-07',
      startTime: '14:00',
      endTime: '15:00',
      createdAt: NOW.toISOString(),
    })),
  };

  return { tasks, sessions, signals, settings };
}

describe('cold start with a heavy-user fixture', () => {
  const fixture = buildFixture();

  it('serializes to roughly the volume DATA_MODEL.md section 6 predicts', () => {
    const bytes = Buffer.byteLength(
      JSON.stringify(fixture.tasks) +
        JSON.stringify(fixture.sessions) +
        JSON.stringify(fixture.signals) +
        JSON.stringify(fixture.settings),
      'utf8',
    );
    // a real heavy install is on the order of 1 MB
    expect(bytes).toBeGreaterThan(200_000);
    expect(bytes).toBeLessThan(4_000_000);
  });

  it('reads and derives inside the budget', async () => {
    const repository = new MemoryRepository({
      initial: {
        [STORAGE_KEYS.tasks]: JSON.stringify(fixture.tasks),
        [STORAGE_KEYS.sessions]: JSON.stringify(fixture.sessions),
        [STORAGE_KEYS.signals]: JSON.stringify(fixture.signals),
        [STORAGE_KEYS.settings]: JSON.stringify(fixture.settings),
        [STORAGE_KEYS.meta]: JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          lastRescheduleAt: null,
          installedAt: NOW.toISOString(),
        }),
      },
    });

    const started = performance.now();

    // the whole launch path, not just JSON.parse, which is the cheap half
    const hydrated = await hydrate(repository);
    highestPriorityTask(hydrated.tasks, NOW);
    scheduledToday(hydrated.tasks, NOW);
    completionRate(hydrated.tasks, NOW, 30);
    currentStreak(hydrated.tasks, NOW);
    productiveWindow(hydrated.signals);
    estimateCalibration(hydrated.signals);

    const elapsed = performance.now() - started;

    expect(hydrated.tasks).toHaveLength(TASK_COUNT);
    expect(hydrated.sessions).toHaveLength(SESSION_COUNT);
    expect(hydrated.signals).toHaveLength(SIGNAL_COUNT);
    expect(hydrated.migrated).toBe(false);
    expect(
      elapsed,
      `read and derive took ${elapsed.toFixed(0)}ms against a ${READ_AND_DERIVE_BUDGET_MS}ms budget`,
    ).toBeLessThan(READ_AND_DERIVE_BUDGET_MS);
  });

  it('reads every collection key in one pass', async () => {
    // launch reads every key once in parallel, backup key included, with no second round trip
    const repository = new MemoryRepository();
    const loaded: string[] = [];
    const original = repository.load.bind(repository);
    repository.load = async <T>(key: Parameters<typeof original>[0]) => {
      loaded.push(key);
      return original<T>(key);
    };
    await hydrate(repository);
    for (const key of COLLECTION_KEYS) expect(loaded).toContain(key);
    expect(loaded).toContain(STORAGE_KEYS.backupPreMigration);
  });

  it('migration of a 500-task legacy snapshot also fits the budget', async () => {
    // migration runs before first render, so its once-per-upgrade cost counts too
    const legacy = {
      state: {
        tasks: fixture.tasks.map((t) => ({
          ...t,
          isAbstract: true,
          difficulty: 'medium',
          source: 'manual',
          externalId: null,
          startTime: t.startTime ?? undefined,
        })),
      },
      version: 0,
    };
    const repository = new MemoryRepository({
      initial: { 'dandelion-tasks': JSON.stringify(legacy) },
    });

    const started = performance.now();
    const hydrated = await hydrate(repository);
    const elapsed = performance.now() - started;

    expect(hydrated.migrated).toBe(true);
    expect(hydrated.tasks).toHaveLength(TASK_COUNT);
    expect(
      elapsed,
      `migration took ${elapsed.toFixed(0)}ms against a ${READ_AND_DERIVE_BUDGET_MS}ms budget`,
    ).toBeLessThan(READ_AND_DERIVE_BUDGET_MS);
  });

  // repeatDays was added without a schema bump. a current-version install skips migrateSettings
  // and the settings spread cannot reach into stored arrays, so normalizeSettings has to fill it
  it('fills in a settings field added since an already-current install last wrote', async () => {
    const storedWithoutRepeatDays = {
      ...DEFAULT_SETTINGS,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      calendarEvents: [
        {
          id: 'e1',
          title: 'Practice',
          date: '2026-09-02',
          startTime: '16:00',
          endTime: '17:30',
          createdAt: NOW.toISOString(),
        },
      ],
    };
    const repository = new MemoryRepository({
      initial: {
        'tether:v1:settings': JSON.stringify(storedWithoutRepeatDays),
        'tether:v1:meta': JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          lastRescheduleAt: null,
          installedAt: NOW.toISOString(),
        }),
      },
    });

    const hydrated = await hydrate(repository);

    expect(hydrated.migrated).toBe(false);
    expect(hydrated.settings.calendarEvents[0].repeatDays).toEqual([]);
  });
});
