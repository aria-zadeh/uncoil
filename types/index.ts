// timestamps are ISO 8601 strings, never Date, since Date doesn't survive JSON.
// this module imports nothing so the pure services that use it stay runnable in Node

export type TaskStatus = 'not_started' | 'in_progress' | 'complete';

export type ScheduleStatus =
  | 'unscheduled' // no placement attempted yet
  | 'auto' // placed by the app, the scheduler may move it
  | 'pinned' // the student chose this slot, the scheduler never moves it
  | 'unplaced' // nothing fits before the due date, retried every sweep
  // older statuses. backups can still hold them, and calendar drag and reschedule review still use them
  | 'proposed' // suggested, waiting for acceptance
  | 'confirmed' // set or accepted by the student
  | 'rescheduled'; // moved after confirming

export type BreakdownSource = 'model' | 'template' | 'user';

export interface Subtask {
  id: string;
  parentTaskId: string;
  // at most 80 characters
  title: string;
  // 5 to 45
  estimatedMinutes: number;
  isComplete: boolean;
  // 0-based and dense. a gap is a bug
  order: number;
  completedAt: string | null;
  // title before the first simplification. set once, so restore returns the original wording
  originalTitle?: string;
}

export interface Task {
  id: string;
  title: string;
  subject: string | null;
  description: string | null;

  // device-local date-time
  dueDate: string;
  // set or accepted by the student, kept apart from a proposal on purpose
  startTime: string | null;
  // scheduler output, not yet a commitment
  proposedTime: string | null;
  // when proposedTime was set, so auto-accept can wait 24 hours. a no-op resweep leaves it alone
  proposedAt?: string | null;
  // sum of step estimates, or set by the student
  durationMinutes: number | null;

  status: TaskStatus;
  scheduleStatus: ScheduleStatus;

  subtasks: Subtask[];
  // one imperative sentence, shown on Home
  starterAction: string | null;

  breakdownSource: BreakdownSource | null;

  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type SessionEndReason = 'completed' | 'abandoned' | 'interrupted';

export interface FocusSession {
  id: string;
  taskId: string;
  // kept so history survives deleting the task
  taskTitleSnapshot: string;
  subtaskId: string | null;

  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;

  breaksTaken: number;
  breakSecondsTotal: number;
  completedSubtaskIds: string[];

  endReason: SessionEndReason | null;
}

export type SignalOutcome = 'completed' | 'partial' | 'skipped';

/** 0 is Sunday, same as Date.getDay */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface SchedulingSignal {
  id: string;
  // null once the task is deleted, the signal stays
  taskId: string | null;
  dayOfWeek: DayOfWeek;
  hourOfDay: number;
  outcome: SignalOutcome;
  actualDurationMinutes: number | null;
  // kept beside the actual so estimates can be calibrated
  estimatedDurationMinutes: number | null;
  recordedAt: string;
}

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type PeriodKey = 'morning' | 'afternoon' | 'evening';

export interface BusyBlock {
  day: DayKey;
  period: PeriodKey;
}

export interface CalendarEvent {
  id: string;
  title: string;
  // date only. the single occurrence, or the first possible one when repeating
  date: string;
  // both "HH:MM", 24-hour
  startTime: string;
  endTime: string;
  // empty for a one-off. otherwise repeats on these weekdays from date onward, each listed once
  repeatDays: DayKey[];
  createdAt: string;
}

export type ThemePreference = 'light' | 'dark' | 'system';

export interface UserSettings {
  schemaVersion: number;

  displayName: string | null;
  onboardingComplete: boolean;

  // notifications
  notificationsEnabled: boolean;
  maxNotificationsPerHour: number;
  // hours, 0 to 23
  quietHoursStart: number;
  quietHoursEnd: number;

  // scheduling
  busyBlocks: BusyBlock[];
  calendarEvents: CalendarEvent[];
  availabilityNotes: string;
  energyPeakStart: number;
  energyPeakEnd: number;
  // prompt context for the model and block size for the scheduler
  typicalSessionMinutes: number;
  autoAcceptProposedSchedule: boolean;

  // focus
  breakMinutes: number;

  // appearance
  themePreference: ThemePreference;

  // use template steps instead of the model
  generationOptOut: boolean;
}

// generation contract. the JSON schemas are defined in docs/ON_DEVICE_MODEL.md

export type GenerationTier = 'model' | 'template';

export const TASK_TITLE_MAX_LENGTH = 120;

export type ModelStatus =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'failed'; reason: 'load_error' | 'out_of_memory' | 'unsupported' | 'disabled' };

// the validator and the prompt builder both read these so they can't drift apart
export const BREAKDOWN_LIMITS = {
  minSteps: 3,
  maxSteps: 7,
  minTitleLength: 4,
  maxTitleLength: 80,
  minMinutes: 5,
  maxMinutes: 45,
  minStarterActionLength: 8,
  maxStarterActionLength: 120,
  minTotalMinutes: 15,
  maxTotalMinutes: 300,
  // Jaccard overlap of content words between starterAction and step 1
  minStarterSimilarity: 0.3,
} as const;

export const EXTRACTION_LIMITS = {
  maxTasks: 8,
  minTitleLength: 3,
  maxTitleLength: 100,
  minDueInDays: 0,
  maxDueInDays: 365,
  maxSubjectLength: 40,
  // input is split by paragraph into chunks of this size
  maxChunkChars: 800,
} as const;

export const SIMPLIFY_LIMITS = {
  minTitleLength: 3,
  maxTitleLength: 80,
  minExplanationLength: 20,
  maxExplanationLength: 400,
} as const;

export interface BreakdownStep {
  title: string;
  minutes: number;
}

export interface Breakdown {
  steps: BreakdownStep[];
  starterAction: string;
}

export interface ExtractedTask {
  title: string;
  dueInDays: number;
  subject?: string;
  // "text" when a phrase in the source set dueInDays, "model" when the model's count was kept
  dueSource?: 'text' | 'model';
}

export interface Extraction {
  tasks: ExtractedTask[];
}

export interface Simplification {
  title: string;
  explanation: string;
}

export interface BreakdownInput {
  title: string;
  subject: string | null;
  description: string | null;
  // relative, like "in 3 days". absolute dates are never sent
  duePhrase: string;
  sessionMinutes: number;
}

export interface SimplifyInput {
  title: string;
  description: string | null;
}

export interface BreakdownResult {
  breakdown: Breakdown;
  tier: GenerationTier;
  latencyMs: number;
}

export interface ExtractionResult {
  extraction: Extraction;
  tier: GenerationTier;
  latencyMs: number;
}

export interface SimplifyResult {
  simplification: Simplification;
  tier: GenerationTier;
  latencyMs: number;
}

// enumerated so the eval harness can count which fires most, which steers the training set
export type RejectionCode =
  | 'empty_output'
  | 'no_json_object'
  | 'parse_error'
  | 'not_an_object'
  | 'missing_field'
  | 'unexpected_field'
  | 'wrong_type'
  | 'too_few_steps'
  | 'too_many_steps'
  | 'title_too_short'
  | 'title_too_long'
  | 'minutes_not_integer'
  | 'minutes_out_of_range'
  | 'starter_action_length'
  | 'not_a_physical_action'
  | 'vague_verb'
  | 'total_minutes_out_of_range'
  | 'starter_action_mismatch'
  | 'hallucinated_proper_noun'
  | 'duplicate_step'
  | 'too_many_tasks'
  | 'due_in_days_out_of_range'
  | 'subject_too_long'
  | 'explanation_length';

export interface Rejection {
  code: RejectionCode;
  // appended verbatim to the repair prompt
  reason: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; rejection: Rejection };

export interface BackupFile {
  format: 'tether-backup';
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  tasks: Task[];
  sessions: FocusSession[];
  signals: SchedulingSignal[];
  settings: UserSettings;
}

export type BackupParseFailureReason =
  | 'not-json'
  | 'wrong-format'
  | 'newer-format-version'
  | 'newer-schema-version'
  | 'invalid-shape'
  | 'write-failed';

export type ParseBackupResult =
  | { ok: true; file: BackupFile }
  | { ok: false; reason: BackupParseFailureReason; detail?: string };
