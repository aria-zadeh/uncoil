// backup format, the pure half (backupFiles.ts does the file work). parseBackup is the trust boundary:
// import replaces everything and never merges, so any wrong type or out-of-range value rejects the whole file
import type {
  BackupFile,
  BackupParseFailureReason,
  BusyBlock,
  CalendarEvent,
  DayKey,
  FocusSession,
  ParseBackupResult,
  SchedulingSignal,
  Subtask,
  Task,
  UserSettings,
} from '@/types';
import { TASK_TITLE_MAX_LENGTH } from '@/types';

// the export format's own version, independent of schemaVersion
export const BACKUP_FORMAT_VERSION = 1;

// an imported file is untrusted and these numbers feed loops (slot walks, day walks), so counts reject
// the file. long free text is truncated instead, a long note isn't a corrupt file
export const BACKUP_LIMITS = {
  // checked before the file is read at all
  maxFileBytes: 5 * 1024 * 1024,
  maxTasks: 2000,
  maxSubtasksPerTask: 50,
  maxSessions: 20000,
  maxSignals: 20000,
  maxCalendarEvents: 500,
  maxDescriptionLength: 2000,
  maxAvailabilityNotesLength: 2000,
  maxDisplayNameLength: 50,
  // Task.durationMinutes and typicalSessionMinutes
  maxDurationMinutes: 600,
  maxBreakMinutes: 120,
  maxNotificationsPerHour: 60,
  minYear: 2000,
  maxYear: 2100,
} as const;

export interface BuildBackupInput {
  tasks: Task[];
  sessions: FocusSession[];
  signals: SchedulingSignal[];
  settings: UserSettings;
  schemaVersion: number;
  now: Date;
}

export function buildBackup(input: BuildBackupInput): BackupFile {
  return {
    format: 'tether-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: input.schemaVersion,
    exportedAt: input.now.toISOString(),
    tasks: input.tasks,
    sessions: input.sessions,
    signals: input.signals,
    settings: input.settings,
  };
}

export function serializeBackup(file: BackupFile): string {
  return JSON.stringify(file, null, 2);
}

// strict, unlike data/migrations.ts: a migration repairs and defaults, an import rejects

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function isIntInRange(v: unknown, min: number, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function isOneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isDayKeyArray(v: unknown): v is DayKey[] {
  return Array.isArray(v) && v.every((x) => isOneOf(x, DAY_KEYS));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNumberInRange(v: unknown, min: number, max: number): v is number {
  return isFiniteNumber(v) && v >= min && v <= max;
}

function isNullableNumberInRange(v: unknown, min: number, max: number): v is number | null {
  return v === null || isNumberInRange(v, min, max);
}

// every timestamp goes through this: an unparseable one makes toISOString throw, and a year-9999 due
// date turns a day-by-day walk into millions of iterations
function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return false;
  const year = new Date(ms).getUTCFullYear();
  return year >= BACKUP_LIMITS.minYear && year <= BACKUP_LIMITS.maxYear;
}

function isNullableIsoDate(v: unknown): v is string | null {
  return v === null || isIsoDate(v);
}

// yyyy-mm-dd, and a real calendar date
function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (y < BACKUP_LIMITS.minYear || y > BACKUP_LIMITS.maxYear) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}

function isClockTime(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{2}:\d{2}$/.test(v)) return false;
  const [h, m] = v.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function hasUniqueIds(items: readonly { id: string }[]): boolean {
  return new Set(items.map((x) => x.id)).size === items.length;
}

function clampText(v: string, max: number): string {
  return v.length > max ? v.slice(0, max) : v;
}

const TASK_STATUSES = ['not_started', 'in_progress', 'complete'] as const;
const SCHEDULE_STATUSES = [
  'unscheduled',
  'auto',
  'pinned',
  'unplaced',
  'proposed',
  'confirmed',
  'rescheduled',
] as const;
const BREAKDOWN_SOURCES = ['model', 'template', 'user'] as const;
const SESSION_END_REASONS = ['completed', 'abandoned', 'interrupted'] as const;
const SIGNAL_OUTCOMES = ['completed', 'partial', 'skipped'] as const;
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const PERIOD_KEYS = ['morning', 'afternoon', 'evening'] as const;
const THEMES = ['light', 'dark', 'system'] as const;

function isValidSubtask(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id) || !isString(v.parentTaskId) || !isString(v.title)) return false;
  if (!isNumberInRange(v.estimatedMinutes, 0, BACKUP_LIMITS.maxDurationMinutes)) return false;
  if (!isBoolean(v.isComplete)) return false;
  if (!isFiniteNumber(v.order)) return false;
  if (!isNullableIsoDate(v.completedAt)) return false;
  if (v.originalTitle !== undefined && !isString(v.originalTitle)) return false;
  return true;
}

function isValidTask(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id) || !isString(v.title)) return false;
  if (!isNullableString(v.subject) || !isNullableString(v.description)) return false;
  if (!isIsoDate(v.dueDate)) return false;
  if (!isNullableIsoDate(v.startTime) || !isNullableIsoDate(v.proposedTime)) return false;
  // optional, tasks exported before this field existed have no key for it
  if (v.proposedAt !== undefined && !isNullableIsoDate(v.proposedAt)) return false;
  // bounded, not just finite: a huge duration makes the scheduler's slot walk effectively endless
  if (v.durationMinutes !== null && !isIntInRange(v.durationMinutes, 1, BACKUP_LIMITS.maxDurationMinutes)) {
    return false;
  }
  if (!isOneOf(v.status, TASK_STATUSES)) return false;
  if (!isOneOf(v.scheduleStatus, SCHEDULE_STATUSES)) return false;
  if (!Array.isArray(v.subtasks) || v.subtasks.length > BACKUP_LIMITS.maxSubtasksPerTask) return false;
  if (!v.subtasks.every(isValidSubtask)) return false;
  if (!isNullableString(v.starterAction)) return false;
  if (v.breakdownSource !== null && !isOneOf(v.breakdownSource, BREAKDOWN_SOURCES)) return false;
  if (!isIsoDate(v.createdAt) || !isIsoDate(v.updatedAt)) return false;
  if (!isNullableIsoDate(v.completedAt)) return false;
  return true;
}

function isValidFocusSession(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id) || !isString(v.taskId) || !isString(v.taskTitleSnapshot)) return false;
  if (!isNullableString(v.subtaskId)) return false;
  if (!isIsoDate(v.startedAt) || !isNullableIsoDate(v.endedAt)) return false;
  if (!isNullableNumberInRange(v.durationSeconds, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isNumberInRange(v.breaksTaken, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isNumberInRange(v.breakSecondsTotal, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isStringArray(v.completedSubtaskIds)) return false;
  if (v.endReason !== null && !isOneOf(v.endReason, SESSION_END_REASONS)) return false;
  return true;
}

function isValidSchedulingSignal(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id) || !isNullableString(v.taskId)) return false;
  if (!isIntInRange(v.dayOfWeek, 0, 6)) return false;
  if (!isIntInRange(v.hourOfDay, 0, 23)) return false;
  if (!isOneOf(v.outcome, SIGNAL_OUTCOMES)) return false;
  if (!isNullableNumberInRange(v.actualDurationMinutes, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isNullableNumberInRange(v.estimatedDurationMinutes, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isIsoDate(v.recordedAt)) return false;
  return true;
}

function isValidBusyBlock(v: unknown): v is BusyBlock {
  return isRecord(v) && isOneOf(v.day, DAY_KEYS) && isOneOf(v.period, PERIOD_KEYS);
}

function isValidCalendarEvent(v: unknown): v is CalendarEvent {
  if (!isRecord(v)) return false;
  // optional, older exports describe a one-off with no key. present but malformed still rejects
  if (v.repeatDays !== undefined && !isDayKeyArray(v.repeatDays)) return false;
  return (
    isNonEmptyString(v.id) &&
    isString(v.title) &&
    isCalendarDate(v.date) &&
    isClockTime(v.startTime) &&
    isClockTime(v.endTime) &&
    isIsoDate(v.createdAt)
  );
}

function isValidSettings(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (!isFiniteNumber(v.schemaVersion)) return false;
  if (!isNullableString(v.displayName)) return false;
  if (!isBoolean(v.onboardingComplete) || !isBoolean(v.notificationsEnabled)) return false;
  if (!isIntInRange(v.maxNotificationsPerHour, 0, BACKUP_LIMITS.maxNotificationsPerHour)) return false;
  if (!isIntInRange(v.quietHoursStart, 0, 23) || !isIntInRange(v.quietHoursEnd, 0, 23)) return false;
  if (!Array.isArray(v.busyBlocks) || !v.busyBlocks.every(isValidBusyBlock)) return false;
  if (!Array.isArray(v.calendarEvents) || v.calendarEvents.length > BACKUP_LIMITS.maxCalendarEvents) return false;
  if (!v.calendarEvents.every(isValidCalendarEvent)) return false;
  if (!hasUniqueIds(v.calendarEvents as CalendarEvent[])) return false;
  if (!isString(v.availabilityNotes)) return false;
  // hours compared against getHours(), 24 is a legal exclusive end
  if (!isIntInRange(v.energyPeakStart, 0, 24) || !isIntInRange(v.energyPeakEnd, 0, 24)) return false;
  if (!isIntInRange(v.typicalSessionMinutes, 1, BACKUP_LIMITS.maxDurationMinutes)) return false;
  if (!isBoolean(v.autoAcceptProposedSchedule)) return false;
  if (!isIntInRange(v.breakMinutes, 1, BACKUP_LIMITS.maxBreakMinutes)) return false;
  if (!isOneOf(v.themePreference, THEMES)) return false;
  if (!isBoolean(v.generationOptOut)) return false;
  return true;
}

// rebuilt field by field so extra keys in a file never ride onto a typed object. only called after the
// matching isValid* check, so each cast is a validated read
function sanitizeSubtask(v: Record<string, unknown>): Subtask {
  const subtask: Subtask = {
    id: v.id as string,
    parentTaskId: v.parentTaskId as string,
    title: v.title as string,
    estimatedMinutes: v.estimatedMinutes as number,
    isComplete: v.isComplete as boolean,
    order: v.order as number,
    completedAt: v.completedAt as string | null,
  };
  if (v.originalTitle !== undefined) subtask.originalTitle = v.originalTitle as string;
  return subtask;
}

function sanitizeTask(v: Record<string, unknown>): Task {
  const description = v.description as string | null;
  const task: Task = {
    id: v.id as string,
    title: clampText(v.title as string, TASK_TITLE_MAX_LENGTH),
    subject: v.subject as string | null,
    description: description === null ? null : clampText(description, BACKUP_LIMITS.maxDescriptionLength),
    dueDate: v.dueDate as string,
    startTime: v.startTime as string | null,
    proposedTime: v.proposedTime as string | null,
    durationMinutes: v.durationMinutes as number | null,
    status: v.status as Task['status'],
    scheduleStatus: v.scheduleStatus as Task['scheduleStatus'],
    subtasks: (v.subtasks as Record<string, unknown>[]).map(sanitizeSubtask),
    starterAction: v.starterAction as string | null,
    breakdownSource: v.breakdownSource as Task['breakdownSource'],
    createdAt: v.createdAt as string,
    updatedAt: v.updatedAt as string,
    completedAt: v.completedAt as string | null,
  };
  if (v.proposedAt !== undefined) task.proposedAt = v.proposedAt as string | null;
  return task;
}

function sanitizeSession(v: Record<string, unknown>): FocusSession {
  return {
    id: v.id as string,
    taskId: v.taskId as string,
    taskTitleSnapshot: v.taskTitleSnapshot as string,
    subtaskId: v.subtaskId as string | null,
    startedAt: v.startedAt as string,
    endedAt: v.endedAt as string | null,
    durationSeconds: v.durationSeconds as number | null,
    breaksTaken: v.breaksTaken as number,
    breakSecondsTotal: v.breakSecondsTotal as number,
    completedSubtaskIds: [...(v.completedSubtaskIds as string[])],
    endReason: v.endReason as FocusSession['endReason'],
  };
}

function sanitizeSignal(v: Record<string, unknown>): SchedulingSignal {
  return {
    id: v.id as string,
    taskId: v.taskId as string | null,
    dayOfWeek: v.dayOfWeek as SchedulingSignal['dayOfWeek'],
    hourOfDay: v.hourOfDay as number,
    outcome: v.outcome as SchedulingSignal['outcome'],
    actualDurationMinutes: v.actualDurationMinutes as number | null,
    estimatedDurationMinutes: v.estimatedDurationMinutes as number | null,
    recordedAt: v.recordedAt as string,
  };
}

// listed field by field, not spread, so keys the type no longer declares (ambientAudio, ambientVolume)
// are dropped
function sanitizeSettings(v: Record<string, unknown>, currentSchemaVersion: number): UserSettings {
  const displayName = v.displayName as string | null;
  return {
    schemaVersion: currentSchemaVersion,
    displayName: displayName === null ? null : clampText(displayName, BACKUP_LIMITS.maxDisplayNameLength),
    onboardingComplete: v.onboardingComplete as boolean,
    notificationsEnabled: v.notificationsEnabled as boolean,
    maxNotificationsPerHour: v.maxNotificationsPerHour as number,
    quietHoursStart: v.quietHoursStart as number,
    quietHoursEnd: v.quietHoursEnd as number,
    busyBlocks: (v.busyBlocks as BusyBlock[]).map((b) => ({ day: b.day, period: b.period })),
    // rebuilt per event so a one-off without repeatDays gets [] instead of undefined
    calendarEvents: (v.calendarEvents as Record<string, unknown>[]).map((e) => ({
      id: e.id as string,
      title: e.title as string,
      date: e.date as string,
      startTime: e.startTime as string,
      endTime: e.endTime as string,
      repeatDays: [...((e.repeatDays as DayKey[] | undefined) ?? [])],
      createdAt: e.createdAt as string,
    })),
    availabilityNotes: clampText(v.availabilityNotes as string, BACKUP_LIMITS.maxAvailabilityNotesLength),
    energyPeakStart: v.energyPeakStart as number,
    energyPeakEnd: v.energyPeakEnd as number,
    typicalSessionMinutes: v.typicalSessionMinutes as number,
    autoAcceptProposedSchedule: v.autoAcceptProposedSchedule as boolean,
    breakMinutes: v.breakMinutes as number,
    themePreference: v.themePreference as UserSettings['themePreference'],
    generationOptOut: v.generationOptOut as boolean,
  };
}

function fail(reason: BackupParseFailureReason, detail?: string): ParseBackupResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

export function parseBackup(
  text: string,
  currentSchemaVersion: number,
  currentFormatVersion: number,
): ParseBackupResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('not-json', 'the file was not valid JSON');
  }

  if (!isRecord(parsed)) {
    return fail('invalid-shape', 'the file was not a JSON object');
  }

  if (parsed.format !== 'tether-backup') {
    return fail('wrong-format', 'the file is not an Uncoil backup');
  }

  if (!isFiniteNumber(parsed.formatVersion)) {
    return fail('invalid-shape', 'formatVersion was missing or not a number');
  }
  if (parsed.formatVersion > currentFormatVersion) {
    return fail(
      'newer-format-version',
      'this backup was made by a newer version of Uncoil',
    );
  }

  if (!isFiniteNumber(parsed.schemaVersion)) {
    return fail('invalid-shape', 'schemaVersion was missing or not a number');
  }
  if (parsed.schemaVersion > currentSchemaVersion) {
    return fail('newer-schema-version', 'this backup was made by a newer version of Uncoil');
  }

  if (!isIsoDate(parsed.exportedAt)) {
    return fail('invalid-shape', 'exportedAt was missing or not a date');
  }

  // counts first, so an oversized file is rejected without walking it
  if (Array.isArray(parsed.tasks) && parsed.tasks.length > BACKUP_LIMITS.maxTasks) {
    return fail('invalid-shape', `the backup has more than ${BACKUP_LIMITS.maxTasks} tasks`);
  }
  if (Array.isArray(parsed.sessions) && parsed.sessions.length > BACKUP_LIMITS.maxSessions) {
    return fail('invalid-shape', `the backup has more than ${BACKUP_LIMITS.maxSessions} focus sessions`);
  }
  if (Array.isArray(parsed.signals) && parsed.signals.length > BACKUP_LIMITS.maxSignals) {
    return fail('invalid-shape', `the backup has more than ${BACKUP_LIMITS.maxSignals} scheduling records`);
  }

  if (!Array.isArray(parsed.tasks) || !parsed.tasks.every(isValidTask)) {
    return fail('invalid-shape', 'tasks contained an entry with the wrong shape');
  }
  {
    // import replaces rather than merges, but duplicate ids inside the file are still corrupt: every
    // lookup by id assumes they're unique
    const taskIds = (parsed.tasks as Task[]).map((t) => t.id);
    if (new Set(taskIds).size !== taskIds.length) {
      return fail('invalid-shape', 'tasks contained a duplicate id');
    }
    for (const task of parsed.tasks as Task[]) {
      const subtaskIds = task.subtasks.map((s) => s.id);
      if (new Set(subtaskIds).size !== subtaskIds.length) {
        return fail('invalid-shape', 'a task contained a duplicate subtask id');
      }
    }
  }
  if (!Array.isArray(parsed.sessions) || !parsed.sessions.every(isValidFocusSession)) {
    return fail('invalid-shape', 'sessions contained an entry with the wrong shape');
  }
  if (!hasUniqueIds(parsed.sessions as FocusSession[])) {
    return fail('invalid-shape', 'sessions contained a duplicate id');
  }
  if (!Array.isArray(parsed.signals) || !parsed.signals.every(isValidSchedulingSignal)) {
    return fail('invalid-shape', 'signals contained an entry with the wrong shape');
  }
  if (!hasUniqueIds(parsed.signals as SchedulingSignal[])) {
    return fail('invalid-shape', 'signals contained a duplicate id');
  }
  if (!isValidSettings(parsed.settings)) {
    return fail('invalid-shape', 'settings had the wrong shape');
  }

  // no migration applies to this shape, it has only ever existed with the current fields, so an older
  // schemaVersion that still validates is stamped up to the current one
  const file: BackupFile = {
    format: 'tether-backup',
    formatVersion: parsed.formatVersion,
    schemaVersion: currentSchemaVersion,
    exportedAt: parsed.exportedAt,
    tasks: (parsed.tasks as Record<string, unknown>[]).map(sanitizeTask),
    sessions: (parsed.sessions as Record<string, unknown>[]).map(sanitizeSession),
    signals: (parsed.signals as Record<string, unknown>[]).map(sanitizeSignal),
    settings: sanitizeSettings(parsed.settings as Record<string, unknown>, currentSchemaVersion),
  };

  return { ok: true, file };
}
