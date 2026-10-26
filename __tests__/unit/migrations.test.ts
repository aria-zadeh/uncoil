import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ALL_LEGACY_KEYS, STORAGE_KEYS, type StorageMeta } from '@/data/keys';
import { CURRENT_SCHEMA_VERSION, readSchemaVersion, runMigrations } from '@/data/migrations';
import type { StorageSnapshot } from '@/data/repository';
import type { FocusSession, SchedulingSignal, Task, UserSettings } from '@/types';

// what older installs actually wrote: zustand persist envelopes under dandelion-* keys
function loadLegacySnapshot(): StorageSnapshot {
  const raw = JSON.parse(
    readFileSync('__tests__/fixtures/legacy-storage-v0.json', 'utf8'),
  ) as Record<string, string>;
  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;
    snapshot[key] =
      typeof value === 'string' && value.trim().startsWith('{') ? JSON.parse(value) : value;
  }
  return snapshot;
}

describe('migration 1, from the pre-strip shape', () => {
  const before = loadLegacySnapshot();
  const after = runMigrations(before, readSchemaVersion(before));

  const tasks = after[STORAGE_KEYS.tasks] as Task[];
  const sessions = after[STORAGE_KEYS.sessions] as FocusSession[];
  const signals = after[STORAGE_KEYS.signals] as SchedulingSignal[];
  const settings = after[STORAGE_KEYS.settings] as UserSettings;
  const meta = after[STORAGE_KEYS.meta] as StorageMeta;

  it('treats an unmigrated snapshot as version 0', () => {
    expect(readSchemaVersion(before)).toBe(0);
    expect(meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('unwraps the zustand persist envelope rather than reading the raw key', () => {
    // regression: reading dandelion-tasks without unwrapping .state emptied every install
    expect(tasks).toHaveLength(3);
    expect(tasks[0].title).toBe('Write a 5-paragraph essay on The Great Gatsby');
  });

  it('removes every legacy key', () => {
    for (const key of ALL_LEGACY_KEYS) expect(after[key]).toBeUndefined();
  });

  it('drops the removed Task fields', () => {
    const raw = tasks[0] as unknown as Record<string, unknown>;
    for (const field of ['isAbstract', 'difficulty', 'source', 'externalId']) {
      expect(raw[field]).toBeUndefined();
    }
  });

  it('normalizes absent optional timestamps to null rather than undefined', () => {
    const noStartTime = tasks.find((t) => t.title === 'Chapter 7 problem set');
    expect(noStartTime?.startTime).toBeNull();
    expect(noStartTime?.proposedTime).toBe('2026-08-31T16:00:00.000Z');
  });

  it('maps breakdownSource from the presence of subtasks, not from source', () => {
    expect(tasks[0].breakdownSource).toBe('model');
    expect(tasks.find((t) => t.title === 'Chapter 7 problem set')?.breakdownSource).toBeNull();
  });

  it('collapses completed_on_time, which is not in the new ScheduleStatus union', () => {
    const done = tasks.find((t) => t.status === 'complete');
    expect(done?.scheduleStatus).toBe('confirmed');
    expect(done?.completedAt).toBe(done?.updatedAt);
  });

  it('leaves completedAt null on tasks that are not complete', () => {
    for (const t of tasks.filter((x) => x.status !== 'complete')) {
      expect(t.completedAt).toBeNull();
    }
  });

  it('reassigns subtask order densely and adds completedAt', () => {
    expect(tasks[0].subtasks.map((s) => s.order)).toEqual([0, 1]);
    expect(tasks[0].subtasks[0].completedAt).toBeNull();
  });

  it('renames FocusSession fields and converts minutes to seconds', () => {
    const s = sessions[0];
    expect(s.startedAt).toBe('2026-08-31T08:30:00.000Z');
    expect(s.endedAt).toBe('2026-08-31T09:15:00.000Z');
    expect(s.durationSeconds).toBe(45 * 60);
    expect(s.completedSubtaskIds).toEqual(['1756500000001-b2c3d4e']);
    expect(s.endReason).toBeNull();
  });

  it('folds BreakEvent records into session counters and drops the collection', () => {
    expect(sessions[0].breaksTaken).toBe(2);
    expect(sessions[0].breakSecondsTotal).toBe(300 + 180);
    expect((after as Record<string, unknown>).breakEvents).toBeUndefined();
  });

  it('snapshots the task title so history survives task deletion', () => {
    expect(sessions[0].taskTitleSnapshot).toBe('Write a 5-paragraph essay on The Great Gatsby');
    expect(sessions[1].taskTitleSnapshot).toBe('Deleted task');
  });

  it('adds estimatedDurationMinutes as null and keeps every outcome', () => {
    expect(signals).toHaveLength(3);
    for (const s of signals) expect(s.estimatedDurationMinutes).toBeNull();
    expect(signals.map((s) => s.outcome)).toEqual(['completed', 'skipped', 'partial']);
  });

  it('drops the removed settings fields', () => {
    const raw = settings as unknown as Record<string, unknown>;
    for (const field of [
      'webPushSubscription',
      'pomodoroEnabled',
      'pomodoroWorkMinutes',
      'focusAudio',
      // the legacy focusAudio used to map into these; the feature is gone
      'ambientAudio',
      'ambientVolume',
    ]) {
      expect(raw[field]).toBeUndefined();
    }
  });

  it('carries the old pomodoro break length into breakMinutes', () => {
    expect(settings.breakMinutes).toBe(7);
  });

  it('defaults the added settings fields', () => {
    expect(settings.typicalSessionMinutes).toBe(30);
    expect(settings.generationOptOut).toBe(false);
    expect(settings.notificationsEnabled).toBe(false);
    expect(settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('preserves settings the user actually set', () => {
    expect(settings.displayName).toBe('Sam');
    expect(settings.busyBlocks).toHaveLength(3);
    expect(settings.calendarEvents[0].title).toBe('Dentist');
    expect(settings.availabilityNotes).toBe('swim practice Tues 4-6');
  });

  it('reads an event written before repeatDays existed as a one-off', () => {
    expect(settings.calendarEvents[0].repeatDays).toEqual([]);
  });

  it('carries lastRescheduleAt into meta', () => {
    expect(meta.lastRescheduleAt).toBe('2026-08-31T09:00:00.000Z');
  });

  it('is idempotent once the version has been written', () => {
    const again = runMigrations(after, readSchemaVersion(after));
    expect(again).toEqual(after);
  });

  it('produces empty collections and defaults for a fresh install', () => {
    const fresh = runMigrations({}, 0);
    expect(fresh[STORAGE_KEYS.tasks]).toEqual([]);
    expect((fresh[STORAGE_KEYS.settings] as UserSettings).onboardingComplete).toBe(false);
  });

  it('survives a snapshot whose collections are the wrong type', () => {
    const junk = runMigrations({ 'dandelion-tasks': { state: { tasks: 'not an array' } } }, 0);
    expect(junk[STORAGE_KEYS.tasks]).toEqual([]);
  });
});

describe('migration 2, dropping ambientAudio and ambientVolume', () => {
  // settings as a v1 device still has them on disk
  function v1SnapshotWithAmbientFields(): StorageSnapshot {
    return {
      [STORAGE_KEYS.tasks]: [],
      [STORAGE_KEYS.sessions]: [],
      [STORAGE_KEYS.signals]: [],
      [STORAGE_KEYS.settings]: {
        schemaVersion: 1,
        displayName: 'Sam',
        onboardingComplete: true,
        notificationsEnabled: false,
        maxNotificationsPerHour: 1,
        quietHoursStart: 23,
        quietHoursEnd: 8,
        busyBlocks: [],
        calendarEvents: [],
        availabilityNotes: '',
        energyPeakStart: 15,
        energyPeakEnd: 17,
        typicalSessionMinutes: 30,
        autoAcceptProposedSchedule: true,
        ambientAudio: 'rain',
        ambientVolume: 0.7,
        breakMinutes: 5,
        themePreference: 'system',
        generationOptOut: false,
      },
      [STORAGE_KEYS.meta]: {
        schemaVersion: 1,
        lastRescheduleAt: null,
        installedAt: '2026-01-01T00:00:00.000Z',
      },
    };
  }

  it('drops ambientAudio and ambientVolume from an already-migrated v1 snapshot', () => {
    const before = v1SnapshotWithAmbientFields();
    const after = runMigrations(before, readSchemaVersion(before));
    const settings = after[STORAGE_KEYS.settings] as unknown as Record<string, unknown>;

    expect(settings.ambientAudio).toBeUndefined();
    expect(settings.ambientVolume).toBeUndefined();
    expect(settings.displayName).toBe('Sam');
    expect(settings.breakMinutes).toBe(5);
  });

  it('bumps the settings record\'s own version alongside the shape change', () => {
    const before = v1SnapshotWithAmbientFields();
    const after = runMigrations(before, readSchemaVersion(before));
    const settings = after[STORAGE_KEYS.settings] as unknown as Record<string, unknown>;
    expect(settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('bumps meta.schemaVersion to the current version', () => {
    const before = v1SnapshotWithAmbientFields();
    const after = runMigrations(before, readSchemaVersion(before));
    expect((after[STORAGE_KEYS.meta] as StorageMeta).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('is idempotent once the version has been written', () => {
    const before = v1SnapshotWithAmbientFields();
    const once = runMigrations(before, readSchemaVersion(before));
    const twice = runMigrations(once, readSchemaVersion(once));
    expect(twice).toEqual(once);
  });
});

describe('calendar event repeatDays', () => {
  // repeatDays is additive, so there is no version bump. this pins the settings mapper's narrowing
  function legacySnapshotWithEvents(events: unknown): StorageSnapshot {
    return { 'dandelion-settings': { state: { calendarEvents: events } } };
  }

  function eventsAfterMigration(events: unknown): UserSettings['calendarEvents'] {
    const after = runMigrations(legacySnapshotWithEvents(events), 0);
    return (after[STORAGE_KEYS.settings] as UserSettings).calendarEvents;
  }

  it('defaults a missing repeatDays to [], keeping a one-off a one-off', () => {
    const events = eventsAfterMigration([
      { id: 'e1', title: 'Dentist', date: '2026-09-02', startTime: '14:00', endTime: '15:00' },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].repeatDays).toEqual([]);
  });

  it('drops a day that is not a DayKey rather than defaulting it to a real day', () => {
    // `oneOf` falls back to 'mon', so coercing instead of filtering would add monday practice
    const events = eventsAfterMigration([
      {
        id: 'e1',
        title: 'Practice',
        date: '2026-09-08',
        startTime: '16:00',
        endTime: '17:30',
        repeatDays: ['tue', 'Thursday', '', 3, null, 'thu'],
      },
    ]);
    expect(events[0].repeatDays).toEqual(['tue', 'thu']);
  });

  it('collapses a day listed twice, which types/index.ts says cannot happen', () => {
    const events = eventsAfterMigration([
      {
        id: 'e1',
        title: 'Practice',
        date: '2026-09-08',
        startTime: '16:00',
        endTime: '17:30',
        repeatDays: ['tue', 'thu', 'tue', 'thu', 'tue'],
      },
    ]);
    expect(events[0].repeatDays).toEqual(['tue', 'thu']);
  });

  it('reads a non-array repeatDays as a one-off rather than throwing', () => {
    const events = eventsAfterMigration([
      {
        id: 'e1',
        title: 'Practice',
        date: '2026-09-08',
        startTime: '16:00',
        endTime: '17:30',
        repeatDays: 'tue',
      },
    ]);
    expect(events[0].repeatDays).toEqual([]);
  });
});
