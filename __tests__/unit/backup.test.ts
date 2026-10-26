import { describe, expect, it } from 'vitest';

import { BACKUP_FORMAT_VERSION, BACKUP_LIMITS, buildBackup, parseBackup, serializeBackup } from '@/services/backup';
import { TASK_TITLE_MAX_LENGTH, type BackupFile, type BackupParseFailureReason, type FocusSession, type SchedulingSignal, type Task, type UserSettings } from '@/types';

const NOW = new Date('2026-09-05T12:00:00.000Z');
const CURRENT_SCHEMA_VERSION = 1;

const TASK: Task = {
  id: 'task-1',
  title: 'Write a 5-paragraph essay',
  subject: 'English 2H',
  description: null,
  dueDate: '2026-09-10T00:00:00.000Z',
  startTime: null,
  proposedTime: null,
  durationMinutes: 90,
  status: 'not_started',
  scheduleStatus: 'unscheduled',
  subtasks: [
    {
      id: 'sub-1',
      parentTaskId: 'task-1',
      title: 'Open the assignment sheet',
      estimatedMinutes: 5,
      isComplete: false,
      order: 0,
      completedAt: null,
    },
  ],
  starterAction: 'Open the assignment sheet',
  breakdownSource: 'model',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  completedAt: null,
};

const SESSION: FocusSession = {
  id: 'session-1',
  taskId: 'task-1',
  taskTitleSnapshot: 'Write a 5-paragraph essay',
  subtaskId: null,
  startedAt: '2026-09-02T15:00:00.000Z',
  endedAt: '2026-09-02T15:30:00.000Z',
  durationSeconds: 1800,
  breaksTaken: 0,
  breakSecondsTotal: 0,
  completedSubtaskIds: [],
  endReason: 'completed',
};

const SIGNAL: SchedulingSignal = {
  id: 'signal-1',
  taskId: 'task-1',
  dayOfWeek: 2,
  hourOfDay: 15,
  outcome: 'completed',
  actualDurationMinutes: 30,
  estimatedDurationMinutes: 30,
  recordedAt: '2026-09-02T15:30:00.000Z',
};

const SETTINGS: UserSettings = {
  schemaVersion: 1,
  displayName: 'Sam',
  onboardingComplete: true,
  notificationsEnabled: true,
  maxNotificationsPerHour: 1,
  quietHoursStart: 23,
  quietHoursEnd: 8,
  busyBlocks: [{ day: 'mon', period: 'morning' }],
  calendarEvents: [
    {
      id: 'event-1',
      title: 'Practice',
      date: '2026-09-06',
      startTime: '15:00',
      endTime: '16:00',
      repeatDays: [],
      createdAt: '2026-09-01T00:00:00.000Z',
    },
  ],
  availabilityNotes: 'Free after 3pm',
  energyPeakStart: 15,
  energyPeakEnd: 17,
  typicalSessionMinutes: 30,
  autoAcceptProposedSchedule: true,
  breakMinutes: 5,
  themePreference: 'system',
  generationOptOut: false,
};

function goodFile(overrides: Partial<BackupFile> = {}): BackupFile {
  return {
    format: 'tether-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: NOW.toISOString(),
    tasks: [TASK],
    sessions: [SESSION],
    signals: [SIGNAL],
    settings: SETTINGS,
    ...overrides,
  };
}

function reasonOf(text: string): BackupParseFailureReason | 'ok' {
  const result = parseBackup(text, CURRENT_SCHEMA_VERSION, BACKUP_FORMAT_VERSION);
  return result.ok ? 'ok' : result.reason;
}

describe('buildBackup', () => {
  it('stamps the current format version and the given schema version', () => {
    const file = buildBackup({
      tasks: [TASK],
      sessions: [SESSION],
      signals: [SIGNAL],
      settings: SETTINGS,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      now: NOW,
    });
    expect(file.format).toBe('tether-backup');
    expect(file.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(file.exportedAt).toBe(NOW.toISOString());
    expect(file.tasks).toEqual([TASK]);
    expect(file.sessions).toEqual([SESSION]);
    expect(file.signals).toEqual([SIGNAL]);
    expect(file.settings).toEqual(SETTINGS);
  });
});

describe('round trip', () => {
  it('buildBackup -> serializeBackup -> parseBackup recovers exactly what was built', () => {
    const built = buildBackup({
      tasks: [TASK],
      sessions: [SESSION],
      signals: [SIGNAL],
      settings: SETTINGS,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      now: NOW,
    });
    const text = serializeBackup(built);

    // checked directly: a different indent would still round-trip through parseBackup
    expect(text).toBe(JSON.stringify(built, null, 2));

    const parsed = parseBackup(text, CURRENT_SCHEMA_VERSION, BACKUP_FORMAT_VERSION);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.file).toEqual(built);
  });
});

describe('parseBackup failures', () => {
  it('rejects text that is not JSON at all', () => {
    expect(reasonOf('not json {{{')).toBe('not-json');
  });

  it('rejects a JSON value that is not an object', () => {
    expect(reasonOf('[1, 2, 3]')).toBe('invalid-shape');
    expect(reasonOf('"a string"')).toBe('invalid-shape');
  });

  it('rejects the wrong format field', () => {
    const file = goodFile({ format: 'some-other-format' as 'tether-backup' });
    expect(reasonOf(JSON.stringify(file))).toBe('wrong-format');
  });

  it('rejects a formatVersion newer than the app understands', () => {
    const file = goodFile({ formatVersion: BACKUP_FORMAT_VERSION + 1 });
    expect(reasonOf(JSON.stringify(file))).toBe('newer-format-version');
  });

  it('rejects a schemaVersion newer than the app understands', () => {
    const file = goodFile({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
    expect(reasonOf(JSON.stringify(file))).toBe('newer-schema-version');
  });

  it('rejects missing formatVersion / schemaVersion as an invalid shape, not a crash', () => {
    const withoutFormatVersion = { ...goodFile() } as Record<string, unknown>;
    delete withoutFormatVersion.formatVersion;
    expect(reasonOf(JSON.stringify(withoutFormatVersion))).toBe('invalid-shape');

    const withoutSchemaVersion = { ...goodFile() } as Record<string, unknown>;
    delete withoutSchemaVersion.schemaVersion;
    expect(reasonOf(JSON.stringify(withoutSchemaVersion))).toBe('invalid-shape');
  });

  it('accepts an older schemaVersion (no migration exists for this shape, so it is gated on equality and stamped up)', () => {
    const file = goodFile({ schemaVersion: 0 });
    const result = parseBackup(JSON.stringify(file), CURRENT_SCHEMA_VERSION, BACKUP_FORMAT_VERSION);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.file.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('rejects a task with a wrong field type', () => {
    const file = goodFile({ tasks: [{ ...TASK, durationMinutes: 'ninety' as unknown as number }] });
    expect(reasonOf(JSON.stringify(file))).toBe('invalid-shape');
  });

  it('rejects a task with an invalid enum value', () => {
    const file = goodFile({ tasks: [{ ...TASK, status: 'archived' as unknown as Task['status'] }] });
    expect(reasonOf(JSON.stringify(file))).toBe('invalid-shape');
  });

  it('rejects a subtask with a wrong field type', () => {
    const file = goodFile({
      tasks: [{ ...TASK, subtasks: [{ ...TASK.subtasks[0], estimatedMinutes: '5' as unknown as number }] }],
    });
    expect(reasonOf(JSON.stringify(file))).toBe('invalid-shape');
  });

  it('rejects a session with a wrong field type', () => {
    const file = goodFile({ sessions: [{ ...SESSION, breaksTaken: 'zero' as unknown as number }] });
    expect(reasonOf(JSON.stringify(file))).toBe('invalid-shape');
  });

  it('rejects a signal with an out-of-range hourOfDay', () => {
    const file = goodFile({ signals: [{ ...SIGNAL, hourOfDay: 24 }] });
    expect(reasonOf(JSON.stringify(file))).toBe('invalid-shape');
  });

  it('rejects a signal with a non-integer dayOfWeek', () => {
    const file = goodFile({ signals: [{ ...SIGNAL, dayOfWeek: 2.5 as unknown as SchedulingSignal['dayOfWeek'] }] });
    expect(reasonOf(JSON.stringify(file))).toBe('invalid-shape');
  });

  it('rejects settings with an invalid enum value', () => {
    const file = goodFile({ settings: { ...SETTINGS, themePreference: 'sepia' as unknown as UserSettings['themePreference'] } });
    expect(reasonOf(JSON.stringify(file))).toBe('invalid-shape');
  });

  it('rejects a busyBlock with an invalid enum value', () => {
    const file = goodFile({
      settings: { ...SETTINGS, busyBlocks: [{ day: 'someday' as unknown as UserSettings['busyBlocks'][number]['day'], period: 'morning' }] },
    });
    expect(reasonOf(JSON.stringify(file))).toBe('invalid-shape');
  });

  it('clamps an accepted file\'s settings.schemaVersion to currentSchemaVersion instead of trusting the file', () => {
    const file = goodFile({ settings: { ...SETTINGS, schemaVersion: 999 } });
    const result = parseBackup(JSON.stringify(file), CURRENT_SCHEMA_VERSION, BACKUP_FORMAT_VERSION);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.file.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('rejects tasks with a duplicate id', () => {
    const file = goodFile({ tasks: [TASK, { ...TASK, id: TASK.id }] });
    expect(reasonOf(JSON.stringify(file))).toBe('invalid-shape');
  });

  it('rejects a task whose subtasks contain a duplicate id', () => {
    const dupedSubtask = { ...TASK.subtasks[0] };
    const file = goodFile({ tasks: [{ ...TASK, subtasks: [dupedSubtask, { ...dupedSubtask }] }] });
    expect(reasonOf(JSON.stringify(file))).toBe('invalid-shape');
  });

  it('accepts a task with no proposedAt key at all -- exported before the field existed', () => {
    // JSON.stringify drops undefined keys, so this is a real old export with no proposedAt key
    const file = goodFile({ tasks: [{ ...TASK, proposedAt: undefined }] });
    expect(JSON.stringify(file)).not.toContain('proposedAt');
    expect(reasonOf(JSON.stringify(file))).toBe('ok');
  });

  it('accepts a task with proposedAt set to an ISO string or null', () => {
    const withNull = goodFile({ tasks: [{ ...TASK, proposedAt: null }] });
    expect(reasonOf(JSON.stringify(withNull))).toBe('ok');

    const withValue = goodFile({ tasks: [{ ...TASK, proposedAt: '2026-09-02T15:00:00.000Z' }] });
    expect(reasonOf(JSON.stringify(withValue))).toBe('ok');
  });

  it('rejects a task with a wrong-typed proposedAt', () => {
    const file = goodFile({ tasks: [{ ...TASK, proposedAt: 12345 as unknown as string }] });
    expect(reasonOf(JSON.stringify(file))).toBe('invalid-shape');
  });

  it('accepts a task with no subtasks and every nullable field actually null', () => {
    const bareTask: Task = {
      ...TASK,
      subject: null,
      description: null,
      startTime: null,
      proposedTime: null,
      durationMinutes: null,
      subtasks: [],
      starterAction: null,
      breakdownSource: null,
      completedAt: null,
    };
    const file = goodFile({ tasks: [bareTask] });
    expect(reasonOf(JSON.stringify(file))).toBe('ok');
  });
});

describe('parseBackup, calendar event repeatDays', () => {
  const EVENT = SETTINGS.calendarEvents[0];

  function withEvents(events: unknown): string {
    return JSON.stringify(
      goodFile({
        settings: { ...SETTINGS, calendarEvents: events as UserSettings['calendarEvents'] },
      }),
    );
  }

  it('accepts an export written before repeatDays existed and imports it as a one-off', () => {
    // JSON.stringify drops undefined keys, so this is a real old export with no repeatDays key
    const text = withEvents([{ ...EVENT, repeatDays: undefined }]);
    expect(text).not.toContain('repeatDays');

    const result = parseBackup(text, CURRENT_SCHEMA_VERSION, BACKUP_FORMAT_VERSION);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.file.settings.calendarEvents[0].repeatDays).toEqual([]);
  });

  it('rejects a repeatDays that is not an array', () => {
    expect(reasonOf(withEvents([{ ...EVENT, repeatDays: 'tue' }]))).toBe('invalid-shape');
    expect(reasonOf(withEvents([{ ...EVENT, repeatDays: 3 }]))).toBe('invalid-shape');
    expect(reasonOf(withEvents([{ ...EVENT, repeatDays: { tue: true } }]))).toBe('invalid-shape');
  });

  it('rejects an array holding something that is not a DayKey', () => {
    expect(reasonOf(withEvents([{ ...EVENT, repeatDays: ['tue', 'Thursday'] }]))).toBe('invalid-shape');
    expect(reasonOf(withEvents([{ ...EVENT, repeatDays: [2, 4] }]))).toBe('invalid-shape');
  });

  it('round-trips a repeating event unchanged', () => {
    const repeating = { ...EVENT, repeatDays: ['tue', 'thu'] as UserSettings['calendarEvents'][number]['repeatDays'] };
    const built = buildBackup({
      tasks: [TASK],
      sessions: [SESSION],
      signals: [SIGNAL],
      settings: { ...SETTINGS, calendarEvents: [repeating] },
      schemaVersion: CURRENT_SCHEMA_VERSION,
      now: NOW,
    });
    const result = parseBackup(serializeBackup(built), CURRENT_SCHEMA_VERSION, BACKUP_FORMAT_VERSION);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.file.settings.calendarEvents).toEqual([repeating]);
  });
});

describe('parseBackup, a file exported before P1-6 was cut', () => {
  // files exported before ambient audio was removed still carry these two fields
  it('imports cleanly and drops ambientAudio and ambientVolume', () => {
    const staleSettings = { ...SETTINGS, ambientAudio: 'rain', ambientVolume: 0.7 };
    const file = goodFile({ settings: staleSettings as unknown as UserSettings });
    const result = parseBackup(JSON.stringify(file), CURRENT_SCHEMA_VERSION, BACKUP_FORMAT_VERSION);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const settings = result.file.settings as unknown as Record<string, unknown>;
    expect(settings.ambientAudio).toBeUndefined();
    expect(settings.ambientVolume).toBeUndefined();
    expect(result.file.settings.displayName).toBe(SETTINGS.displayName);
    expect(result.file.settings.breakMinutes).toBe(SETTINGS.breakMinutes);
  });
});

// hostile files. each of these used to pass validation and then hang or crash the app at launch
describe('parseBackup, numeric ranges', () => {
  function withTask(overrides: Record<string, unknown>): string {
    return JSON.stringify(goodFile({ tasks: [{ ...TASK, ...overrides } as Task] }));
  }
  function withSettings(overrides: Record<string, unknown>): string {
    return JSON.stringify(goodFile({ settings: { ...SETTINGS, ...overrides } as UserSettings }));
  }

  it('rejects a negative, zero, fractional or huge task duration', () => {
    expect(reasonOf(withTask({ durationMinutes: -60 }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ durationMinutes: 0 }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ durationMinutes: 30.5 }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ durationMinutes: 601 }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ durationMinutes: null }))).toBe('ok');
    expect(reasonOf(withTask({ durationMinutes: 600 }))).toBe('ok');
  });

  it('rejects an out-of-range subtask estimate', () => {
    const sub = TASK.subtasks[0];
    expect(reasonOf(withTask({ subtasks: [{ ...sub, estimatedMinutes: -5 }] }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ subtasks: [{ ...sub, estimatedMinutes: 1e9 }] }))).toBe('invalid-shape');
  });

  it('rejects settings numbers outside what the app can set', () => {
    expect(reasonOf(withSettings({ typicalSessionMinutes: -30 }))).toBe('invalid-shape');
    expect(reasonOf(withSettings({ typicalSessionMinutes: 0 }))).toBe('invalid-shape');
    expect(reasonOf(withSettings({ breakMinutes: -1 }))).toBe('invalid-shape');
    expect(reasonOf(withSettings({ breakMinutes: 10_000 }))).toBe('invalid-shape');
    expect(reasonOf(withSettings({ energyPeakStart: -3 }))).toBe('invalid-shape');
    expect(reasonOf(withSettings({ energyPeakEnd: 99 }))).toBe('invalid-shape');
    expect(reasonOf(withSettings({ maxNotificationsPerHour: -1 }))).toBe('invalid-shape');
    expect(reasonOf(withSettings({ maxNotificationsPerHour: 1.5 }))).toBe('invalid-shape');
  });

  it('rejects negative session and signal durations', () => {
    expect(reasonOf(JSON.stringify(goodFile({ sessions: [{ ...SESSION, durationSeconds: -1 }] })))).toBe('invalid-shape');
    expect(reasonOf(JSON.stringify(goodFile({ sessions: [{ ...SESSION, breaksTaken: -1 }] })))).toBe('invalid-shape');
    expect(reasonOf(JSON.stringify(goodFile({ signals: [{ ...SIGNAL, actualDurationMinutes: -10 }] })))).toBe(
      'invalid-shape',
    );
  });
});

describe('parseBackup, dates and times', () => {
  function withTask(overrides: Record<string, unknown>): string {
    return JSON.stringify(goodFile({ tasks: [{ ...TASK, ...overrides } as Task] }));
  }

  it('rejects unparseable or out-of-range task timestamps', () => {
    expect(reasonOf(withTask({ startTime: 'x', scheduleStatus: 'auto' }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ proposedTime: 'soon' }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ proposedAt: 'later' }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ dueDate: 'tomorrow' }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ dueDate: '9999-12-31T23:59:00.000Z' }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ dueDate: '1970-01-01T00:00:00.000Z' }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ createdAt: '' }))).toBe('invalid-shape');
    expect(reasonOf(withTask({ completedAt: 'done' }))).toBe('invalid-shape');
  });

  it('rejects unparseable session, signal and export timestamps', () => {
    expect(reasonOf(JSON.stringify(goodFile({ sessions: [{ ...SESSION, startedAt: 'x' }] })))).toBe('invalid-shape');
    expect(reasonOf(JSON.stringify(goodFile({ signals: [{ ...SIGNAL, recordedAt: 'x' }] })))).toBe('invalid-shape');
    expect(reasonOf(JSON.stringify(goodFile({ exportedAt: 'x' })))).toBe('invalid-shape');
  });

  it('rejects malformed event dates and clock times', () => {
    const event = SETTINGS.calendarEvents[0];
    const withEvent = (overrides: Record<string, unknown>) =>
      JSON.stringify(goodFile({ settings: { ...SETTINGS, calendarEvents: [{ ...event, ...overrides }] } as UserSettings }));
    expect(reasonOf(withEvent({ date: '2026-9-6' }))).toBe('invalid-shape');
    expect(reasonOf(withEvent({ date: '2026-02-30' }))).toBe('invalid-shape');
    expect(reasonOf(withEvent({ date: '9999-01-01' }))).toBe('invalid-shape');
    expect(reasonOf(withEvent({ startTime: '3pm' }))).toBe('invalid-shape');
    expect(reasonOf(withEvent({ startTime: '24:00' }))).toBe('invalid-shape');
    expect(reasonOf(withEvent({ endTime: '16:60' }))).toBe('invalid-shape');
    expect(reasonOf(withEvent({ createdAt: 'x' }))).toBe('invalid-shape');
    expect(reasonOf(withEvent({ date: '2026-02-28', startTime: '00:00', endTime: '23:59' }))).toBe('ok');
  });
});

describe('parseBackup, size limits and record rebuilding', () => {
  it('rejects more tasks, subtasks, sessions, signals or events than the limits allow', () => {
    const manyTasks = Array.from({ length: BACKUP_LIMITS.maxTasks + 1 }, (_, i) => ({ ...TASK, id: `t-${i}` }));
    expect(reasonOf(JSON.stringify(goodFile({ tasks: manyTasks })))).toBe('invalid-shape');

    const manySubs = Array.from({ length: BACKUP_LIMITS.maxSubtasksPerTask + 1 }, (_, i) => ({
      ...TASK.subtasks[0],
      id: `s-${i}`,
    }));
    expect(reasonOf(JSON.stringify(goodFile({ tasks: [{ ...TASK, subtasks: manySubs }] })))).toBe('invalid-shape');

    const manySessions = Array.from({ length: BACKUP_LIMITS.maxSessions + 1 }, (_, i) => ({ ...SESSION, id: `x-${i}` }));
    expect(reasonOf(JSON.stringify(goodFile({ sessions: manySessions })))).toBe('invalid-shape');

    const manySignals = Array.from({ length: BACKUP_LIMITS.maxSignals + 1 }, (_, i) => ({ ...SIGNAL, id: `g-${i}` }));
    expect(reasonOf(JSON.stringify(goodFile({ signals: manySignals })))).toBe('invalid-shape');

    const manyEvents = Array.from({ length: BACKUP_LIMITS.maxCalendarEvents + 1 }, (_, i) => ({
      ...SETTINGS.calendarEvents[0],
      id: `e-${i}`,
    }));
    expect(reasonOf(JSON.stringify(goodFile({ settings: { ...SETTINGS, calendarEvents: manyEvents } })))).toBe(
      'invalid-shape',
    );
  });

  it('says which limit a too-large file broke', () => {
    const manyTasks = Array.from({ length: BACKUP_LIMITS.maxTasks + 1 }, (_, i) => ({ ...TASK, id: `t-${i}` }));
    const result = parseBackup(JSON.stringify(goodFile({ tasks: manyTasks })), CURRENT_SCHEMA_VERSION, BACKUP_FORMAT_VERSION);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.detail).toContain(String(BACKUP_LIMITS.maxTasks));
  });

  it('rejects empty and duplicate session and signal ids', () => {
    expect(reasonOf(JSON.stringify(goodFile({ sessions: [{ ...SESSION, id: '' }] })))).toBe('invalid-shape');
    expect(reasonOf(JSON.stringify(goodFile({ signals: [{ ...SIGNAL, id: '' }] })))).toBe('invalid-shape');
    expect(reasonOf(JSON.stringify(goodFile({ tasks: [{ ...TASK, id: '' }] })))).toBe('invalid-shape');
    expect(reasonOf(JSON.stringify(goodFile({ sessions: [SESSION, SESSION] })))).toBe('invalid-shape');
    expect(reasonOf(JSON.stringify(goodFile({ signals: [SIGNAL, SIGNAL] })))).toBe('invalid-shape');
  });

  it('truncates over-long strings instead of rejecting the file', () => {
    const file = goodFile({
      tasks: [{ ...TASK, title: 'a'.repeat(500), description: 'b'.repeat(5000) }],
      settings: { ...SETTINGS, displayName: 'c'.repeat(200), availabilityNotes: 'd'.repeat(5000) },
    });
    const result = parseBackup(JSON.stringify(file), CURRENT_SCHEMA_VERSION, BACKUP_FORMAT_VERSION);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.file.tasks[0].title).toHaveLength(TASK_TITLE_MAX_LENGTH);
    expect(result.file.tasks[0].description).toHaveLength(BACKUP_LIMITS.maxDescriptionLength);
    expect(result.file.settings.displayName).toHaveLength(BACKUP_LIMITS.maxDisplayNameLength);
    expect(result.file.settings.availabilityNotes).toHaveLength(BACKUP_LIMITS.maxAvailabilityNotesLength);
  });

  it('drops unknown keys from every imported record', () => {
    const file = {
      ...goodFile(),
      tasks: [{ ...TASK, injected: 1, subtasks: [{ ...TASK.subtasks[0], injected: 2 }] }],
      sessions: [{ ...SESSION, injected: 3 }],
      signals: [{ ...SIGNAL, injected: 4 }],
      settings: {
        ...SETTINGS,
        busyBlocks: [{ ...SETTINGS.busyBlocks[0], injected: 5 }],
        calendarEvents: [{ ...SETTINGS.calendarEvents[0], injected: 6 }],
      },
    };
    const result = parseBackup(JSON.stringify(file), CURRENT_SCHEMA_VERSION, BACKUP_FORMAT_VERSION);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(JSON.stringify(result.file)).not.toContain('injected');
    expect(result.file.tasks).toStrictEqual([TASK]);
    expect(result.file.sessions).toStrictEqual([SESSION]);
    expect(result.file.signals).toStrictEqual([SIGNAL]);
  });
});
