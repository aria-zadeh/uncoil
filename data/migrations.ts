// migrations are pure, snapshot in and snapshot out. each one has a unit test with a
// fixture of the shape before it. backup and crash recovery live in hydrate.ts
import {
  ALL_LEGACY_KEYS,
  LEGACY_KEYS,
  STORAGE_KEYS,
  type StorageMeta,
} from '@/data/keys';
import type { StorageSnapshot } from '@/data/repository';
import type {
  BreakdownSource,
  DayKey,
  DayOfWeek,
  FocusSession,
  ScheduleStatus,
  SchedulingSignal,
  SignalOutcome,
  Subtask,
  Task,
  TaskStatus,
  ThemePreference,
  UserSettings,
} from '@/types';

export const CURRENT_SCHEMA_VERSION = 3;

export interface Migration {
  to: number;
  describe: string;
  run(snapshot: StorageSnapshot): StorageSnapshot;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function nullableNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

// old data holds timestamps as Date, ISO string or epoch number depending on how it was stored
function iso(v: unknown, fallback: string): string {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? fallback : v.toISOString();
  if (typeof v === 'string' && v.length > 0) {
    const parsed = new Date(v);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
  }
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  return fallback;
}

function nullableIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const resolved = iso(v, '');
  return resolved === '' ? null : resolved;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

// zustand persist wraps values as { state, version }. read raw, every field comes back empty
function unwrapPersisted(v: unknown): Record<string, unknown> {
  if (!isRecord(v)) return {};
  if (isRecord(v.state)) return v.state;
  return v;
}

const TASK_STATUSES: readonly TaskStatus[] = ['not_started', 'in_progress', 'complete'];
const SCHEDULE_STATUSES: readonly ScheduleStatus[] = [
  'unscheduled',
  'proposed',
  'confirmed',
  'rescheduled',
];
const SIGNAL_OUTCOMES: readonly SignalOutcome[] = ['completed', 'partial', 'skipped'];
const THEMES: readonly ThemePreference[] = ['light', 'dark', 'system'];
const DAY_KEYS: readonly DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function migrateSubtask(raw: unknown, parentTaskId: string, index: number): Subtask {
  const s = isRecord(raw) ? raw : {};
  const isComplete = bool(s.isComplete, false);
  return {
    id: str(s.id, `${parentTaskId}-sub-${index}`),
    parentTaskId: str(s.parentTaskId, parentTaskId),
    title: str(s.title).slice(0, 80),
    estimatedMinutes: num(s.estimatedMinutes, 15),
    isComplete,
    // old data could leave gaps, so reassign from position
    order: index,
    // nothing to rebuild it from, and borrowing the parent's would fake insight history
    completedAt: null,
  };
}

function migrateTask(raw: unknown): Task | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (id === '') return null;

  const createdAt = iso(raw.createdAt, new Date(0).toISOString());
  const updatedAt = iso(raw.updatedAt, createdAt);
  const status = oneOf(raw.status, TASK_STATUSES, 'not_started');
  const subtasks = asArray(raw.subtasks).map((s, i) => migrateSubtask(s, id, i));

  // completion now lives on status and completedAt. for the schedule it meant confirmed
  const rawScheduleStatus = raw.scheduleStatus === 'completed_on_time' ? 'confirmed' : raw.scheduleStatus;

  return {
    id,
    title: str(raw.title),
    subject: nullableStr(raw.subject),
    description: nullableStr(raw.description),
    dueDate: iso(raw.dueDate, createdAt),
    startTime: nullableIso(raw.startTime),
    proposedTime: nullableIso(raw.proposedTime),
    durationMinutes: nullableNum(raw.durationMinutes),
    status,
    scheduleStatus: oneOf(rawScheduleStatus, SCHEDULE_STATUSES, 'unscheduled'),
    subtasks,
    starterAction: nullableStr(raw.starterAction),
    // approximate: the old source field can't tell model steps from template steps
    breakdownSource: subtasks.length > 0 ? ('model' satisfies BreakdownSource) : null,
    createdAt,
    updatedAt,
    // no completion time was recorded. updatedAt is the closest true value
    completedAt: status === 'complete' ? updatedAt : null,
  };
}

function migrateSession(
  raw: unknown,
  breaksBySession: Map<string, { count: number; seconds: number }>,
  taskTitles: Map<string, string>,
): FocusSession | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (id === '') return null;

  const taskId = str(raw.taskId);
  const startedAt = iso(raw.startTime, new Date(0).toISOString());
  const durationMinutes = nullableNum(raw.durationMinutes);
  const folded = breaksBySession.get(id);

  return {
    id,
    taskId,
    taskTitleSnapshot: taskTitles.get(taskId) ?? 'Deleted task',
    subtaskId: nullableStr(raw.subtaskId),
    startedAt,
    endedAt: nullableIso(raw.endTime),
    durationSeconds: durationMinutes === null ? null : Math.round(durationMinutes * 60),
    breaksTaken: folded?.count ?? num(raw.breaksTaken, 0),
    breakSecondsTotal: folded?.seconds ?? 0,
    completedSubtaskIds: asArray(raw.completedSubtasks).filter(
      (x): x is string => typeof x === 'string',
    ),
    endReason: null,
  };
}

function migrateSignal(raw: unknown): SchedulingSignal | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (id === '') return null;
  const dayOfWeek = num(raw.dayOfWeek, 0);
  return {
    id,
    taskId: nullableStr(raw.taskId),
    dayOfWeek: (dayOfWeek >= 0 && dayOfWeek <= 6 ? dayOfWeek : 0) as DayOfWeek,
    hourOfDay: Math.min(23, Math.max(0, Math.round(num(raw.hourOfDay, 0)))),
    outcome: oneOf(raw.outcome, SIGNAL_OUTCOMES, 'partial'),
    actualDurationMinutes: nullableNum(raw.actualDurationMinutes),
    estimatedDurationMinutes: null,
    recordedAt: iso(raw.recordedAt, new Date(0).toISOString()),
  };
}

export const DEFAULT_SETTINGS: UserSettings = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  displayName: null,
  onboardingComplete: false,
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
  breakMinutes: 5,
  themePreference: 'system',
  generationOptOut: false,
};

function migrateSettings(raw: unknown): UserSettings {
  const s = isRecord(raw) ? raw : {};
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    displayName: nullableStr(s.displayName),
    onboardingComplete: bool(s.onboardingComplete, false),
    // there was no toggle, only OS permission. default off and let onboarding ask
    notificationsEnabled: bool(s.notificationsEnabled, false),
    maxNotificationsPerHour: num(s.maxNotificationsPerHour, 1),
    quietHoursStart: num(s.quietHoursStart, 23),
    quietHoursEnd: num(s.quietHoursEnd, 8),
    busyBlocks: asArray(s.busyBlocks).filter(isRecord).map((b) => ({
      day: oneOf(b.day, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const, 'mon'),
      period: oneOf(b.period, ['morning', 'afternoon', 'evening'] as const, 'morning'),
    })),
    calendarEvents: asArray(s.calendarEvents).filter(isRecord).map((e) => ({
      id: str(e.id),
      title: str(e.title),
      date: str(e.date),
      startTime: str(e.startTime, '00:00'),
      endTime: str(e.endTime, '00:00'),
      // added without a schema bump: an older event has no key and lands on [], a one-off.
      // oneOf defaults instead of dropping, so comparing to the input keeps only real days
      repeatDays: [
        ...new Set(
          asArray(e.repeatDays).filter((d): d is DayKey => oneOf(d, DAY_KEYS, 'mon') === d),
        ),
      ],
      createdAt: iso(e.createdAt, new Date(0).toISOString()),
    })).filter((e) => e.id !== ''),
    availabilityNotes: str(s.availabilityNotes),
    energyPeakStart: num(s.energyPeakStart, 15),
    energyPeakEnd: num(s.energyPeakEnd, 17),
    typicalSessionMinutes: num(s.typicalSessionMinutes, 30),
    autoAcceptProposedSchedule: bool(s.autoAcceptProposedSchedule, true),
    // carry over the old pomodoro break length if the user set one
    breakMinutes: num(s.pomodoroBreakMinutes, num(s.breakMinutes, 5)),
    themePreference: oneOf(s.themePreference, THEMES, 'system'),
    generationOptOut: bool(s.generationOptOut, false),
  };
}

const migration1: Migration = {
  to: 1,
  describe:
    'Unwrap zustand persist envelopes, rekey dandelion-* to tether:v1:*, and reshape to DATA_MODEL.md section 2',
  run(snapshot) {
    const tasksState = unwrapPersisted(snapshot[LEGACY_KEYS.tasks]);
    const settingsState = unwrapPersisted(snapshot[LEGACY_KEYS.settings]);
    const sessionsState = unwrapPersisted(snapshot[LEGACY_KEYS.sessions]);
    const schedulingState = unwrapPersisted(snapshot[LEGACY_KEYS.scheduling]);

    const tasks = asArray(tasksState.tasks)
      .map(migrateTask)
      .filter((t): t is Task => t !== null);

    const taskTitles = new Map(tasks.map((t) => [t.id, t.title]));

    // old break events were never read. fold them into session counters, then drop them
    const breaksBySession = new Map<string, { count: number; seconds: number }>();
    for (const raw of asArray(sessionsState.breaks)) {
      if (!isRecord(raw)) continue;
      const sessionId = str(raw.sessionId);
      if (sessionId === '') continue;
      const entry = breaksBySession.get(sessionId) ?? { count: 0, seconds: 0 };
      if (bool(raw.breakTaken, false)) {
        entry.count += 1;
        entry.seconds += num(raw.breakDurationSeconds, 0);
      }
      breaksBySession.set(sessionId, entry);
    }

    const sessions = asArray(sessionsState.sessions)
      .map((s) => migrateSession(s, breaksBySession, taskTitles))
      .filter((s): s is FocusSession => s !== null);

    const signals = asArray(schedulingState.signals)
      .map(migrateSignal)
      .filter((s): s is SchedulingSignal => s !== null);

    const settings = migrateSettings(settingsState);

    const meta: StorageMeta = {
      schemaVersion: 1,
      lastRescheduleAt: nullableIso(snapshot[LEGACY_KEYS.lastReschedule]),
      installedAt: iso(
        tasks.length > 0
          ? tasks.reduce((min, t) => (t.createdAt < min ? t.createdAt : min), tasks[0].createdAt)
          : undefined,
        new Date(0).toISOString(),
      ),
    };

    const next: Record<string, unknown> = { ...snapshot };
    // this drops the old insights key too. it was a derived cache, and derived data isn't stored
    for (const key of ALL_LEGACY_KEYS) delete next[key];

    next[STORAGE_KEYS.tasks] = tasks;
    next[STORAGE_KEYS.sessions] = sessions;
    next[STORAGE_KEYS.signals] = signals;
    next[STORAGE_KEYS.settings] = settings;
    next[STORAGE_KEYS.meta] = meta;
    return next;
  },
};

const migration2: Migration = {
  to: 2,
  describe: 'Drop UserSettings.ambientAudio and UserSettings.ambientVolume (P1-6 cut)',
  run(snapshot) {
    const settingsRaw = snapshot[STORAGE_KEYS.settings];
    const settings: Record<string, unknown> = isRecord(settingsRaw) ? { ...settingsRaw } : {};
    delete settings.ambientAudio;
    delete settings.ambientVolume;
    // settings carries its own copy of the version, so keep it in step
    settings.schemaVersion = 2;

    const metaRaw = snapshot[STORAGE_KEYS.meta];
    const meta: StorageMeta = isRecord(metaRaw)
      ? { ...(metaRaw as unknown as StorageMeta), schemaVersion: 2 }
      : { schemaVersion: 2, lastRescheduleAt: null, installedAt: new Date(0).toISOString() };

    return {
      ...snapshot,
      [STORAGE_KEYS.settings]: settings,
      [STORAGE_KEYS.meta]: meta,
    };
  },
};

const migration3: Migration = {
  to: 3,
  describe:
    "Add 'auto', 'pinned' and 'unplaced' to ScheduleStatus (SCHEDULING.md section 1); version stamp only, no data changes",
  run(snapshot) {
    const settingsRaw = snapshot[STORAGE_KEYS.settings];
    const settings: Record<string, unknown> = isRecord(settingsRaw)
      ? { ...settingsRaw, schemaVersion: 3 }
      : { schemaVersion: 3 };

    const metaRaw = snapshot[STORAGE_KEYS.meta];
    const meta: StorageMeta = isRecord(metaRaw)
      ? { ...(metaRaw as unknown as StorageMeta), schemaVersion: 3 }
      : { schemaVersion: 3, lastRescheduleAt: null, installedAt: new Date(0).toISOString() };

    return {
      ...snapshot,
      [STORAGE_KEYS.settings]: settings,
      [STORAGE_KEYS.meta]: meta,
    };
  },
};

/** ordered by `to`. never reorder, never edit one that has shipped, add a new one instead */
export const MIGRATIONS: readonly Migration[] = [migration1, migration2, migration3];

export function runMigrations(snapshot: StorageSnapshot, fromVersion: number): StorageSnapshot {
  let current = snapshot;
  for (const migration of MIGRATIONS) {
    if (migration.to > fromVersion) current = migration.run(current);
  }
  return current;
}

/** anything unreadable counts as version 0 */
export function readSchemaVersion(snapshot: StorageSnapshot): number {
  const meta = snapshot[STORAGE_KEYS.meta];
  if (!isRecord(meta)) return 0;
  return num(meta.schemaVersion, 0);
}
