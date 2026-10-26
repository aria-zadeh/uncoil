// derived values, computed on read and memoized in the store. every aggregate has a minimum sample and
// returns null below it, so a tile never shows a number built from three data points
import type { DayOfWeek, FocusSession, SchedulingSignal, Task } from '@/types';

export const MIN_SIGNALS_FOR_WINDOW = 10;
export const MIN_SIGNALS_FOR_CALIBRATION = 8;

// progress toward a gated insight, so its tile can say "3 of 10 logged" while the value is still null
export interface LearningProgress {
  // capped at need
  have: number;
  need: number;
}

const MS_PER_DAY = 86_400_000;

// local calendar day, yyyy-mm-dd. the scheduler uses it too so day buckets agree everywhere
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export interface CompletionCounts {
  completed: number;
  created: number;
}

export function completionCounts(
  tasks: readonly Task[],
  now: Date,
  days: number,
): CompletionCounts {
  const cutoff = now.getTime() - days * MS_PER_DAY;
  let completed = 0;
  let created = 0;
  for (const task of tasks) {
    if (task.completedAt !== null && new Date(task.completedAt).getTime() >= cutoff) completed += 1;
    if (new Date(task.createdAt).getTime() >= cutoff) created += 1;
  }
  return { completed, created };
}

// on-time share of tasks created in the window. null when there were none, a rate over zero tasks says nothing
export function completionRate(tasks: readonly Task[], now: Date, days: number): number | null {
  const cutoff = now.getTime() - days * MS_PER_DAY;
  const inPeriod = tasks.filter((t) => new Date(t.createdAt).getTime() >= cutoff);
  if (inPeriod.length === 0) return null;
  const onTime = inPeriod.filter(
    (t) => t.completedAt !== null && new Date(t.completedAt).getTime() <= new Date(t.dueDate).getTime(),
  );
  return onTime.length / inPeriod.length;
}

// a streak not extended yet today is alive until midnight, so count from yesterday. otherwise it would
// read zero every morning
export function currentStreak(tasks: readonly Task[], now: Date): number {
  const days = new Set<string>();
  for (const task of tasks) {
    if (task.completedAt !== null) days.add(localDayKey(task.completedAt));
  }
  if (days.size === 0) return 0;

  const todayKey = localDayKey(now.toISOString());
  let cursor = new Date(now);
  if (!days.has(todayKey)) {
    cursor = new Date(now.getTime() - MS_PER_DAY);
    if (!days.has(localDayKey(cursor.toISOString()))) return 0;
  }

  let streak = 0;
  while (days.has(localDayKey(cursor.toISOString()))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - MS_PER_DAY);
  }
  return streak;
}

export interface ProductiveWindow {
  dayOfWeek: DayOfWeek;
  hourOfDay: number;
  completionRate: number;
  sampleCount: number;
}

// only buckets with three or more signals count, so one lucky tuesday can't become "your most productive time"
export function productiveWindow(signals: readonly SchedulingSignal[]): ProductiveWindow | null {
  if (signals.length < MIN_SIGNALS_FOR_WINDOW) return null;

  const buckets = new Map<string, { completed: number; total: number; day: DayOfWeek; hour: number }>();
  for (const s of signals) {
    const key = `${s.dayOfWeek}:${s.hourOfDay}`;
    const bucket = buckets.get(key) ?? { completed: 0, total: 0, day: s.dayOfWeek, hour: s.hourOfDay };
    bucket.total += 1;
    if (s.outcome === 'completed') bucket.completed += 1;
    buckets.set(key, bucket);
  }

  let best: ProductiveWindow | null = null;
  for (const bucket of buckets.values()) {
    if (bucket.total < 3) continue;
    const rate = bucket.completed / bucket.total;
    const candidate: ProductiveWindow = {
      dayOfWeek: bucket.day,
      hourOfDay: bucket.hour,
      completionRate: rate,
      sampleCount: bucket.total,
    };
    if (
      best === null ||
      candidate.completionRate > best.completionRate ||
      (candidate.completionRate === best.completionRate && candidate.sampleCount > best.sampleCount)
    ) {
      best = candidate;
    }
  }
  return best;
}

// same gate as productiveWindow. reaching need doesn't promise any bucket clears its own three-signal bar
export function windowProgress(signals: readonly SchedulingSignal[]): LearningProgress {
  return {
    have: Math.min(signals.length, MIN_SIGNALS_FOR_WINDOW),
    need: MIN_SIGNALS_FOR_WINDOW,
  };
}

export interface EstimateCalibration {
  // median actual / estimated. 1.4 means work takes about 40% longer than planned
  ratio: number;
  sampleCount: number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// shared with calibrationProgress so the tile's count can't drift from the samples the median uses
function calibrationRatios(signals: readonly SchedulingSignal[]): number[] {
  const ratios: number[] = [];
  for (const s of signals) {
    if (s.actualDurationMinutes === null || s.estimatedDurationMinutes === null) continue;
    if (s.estimatedDurationMinutes <= 0) continue;
    ratios.push(s.actualDurationMinutes / s.estimatedDurationMinutes);
  }
  return ratios;
}

export function estimateCalibration(
  signals: readonly SchedulingSignal[],
): EstimateCalibration | null {
  const ratios = calibrationRatios(signals);
  if (ratios.length < MIN_SIGNALS_FOR_CALIBRATION) return null;
  return { ratio: median(ratios), sampleCount: ratios.length };
}

// counts the same samples as estimateCalibration, so have reaching need is exactly when it turns non-null
export function calibrationProgress(signals: readonly SchedulingSignal[]): LearningProgress {
  return {
    have: Math.min(calibrationRatios(signals).length, MIN_SIGNALS_FOR_CALIBRATION),
    need: MIN_SIGNALS_FOR_CALIBRATION,
  };
}

// the scheduler leans on the same ratio from five samples, before the profile card shows it at eight
export const MIN_SAMPLES_FOR_DURATION_MULTIPLIER = 5;
export const DURATION_MULTIPLIER_MIN = 0.6;
export const DURATION_MULTIPLIER_MAX = 2.0;

/** how much longer a block should run than planned, clamped. exactly 1.0 below five samples */
export function blockLengthMultiplier(signals: readonly SchedulingSignal[]): number {
  const ratios: number[] = [];
  for (const s of signals) {
    if (s.actualDurationMinutes === null || s.estimatedDurationMinutes === null) continue;
    if (s.estimatedDurationMinutes <= 0) continue;
    ratios.push(s.actualDurationMinutes / s.estimatedDurationMinutes);
  }
  if (ratios.length < MIN_SAMPLES_FOR_DURATION_MULTIPLIER) return 1.0;
  const ratio = median(ratios);
  return Math.min(DURATION_MULTIPLIER_MAX, Math.max(DURATION_MULTIPLIER_MIN, ratio));
}

// fewer of a weekday's last four occurrences than this and there's nothing to learn from
export const MIN_OBSERVATIONS_FOR_CAPACITY = 3;
export const CAPACITY_OCCURRENCES = 4;

export interface WeekdayCapacity {
  minutes: number;
  // false when there's too little history and minutes is the typicalSessionMinutes * 2 fallback
  learned: boolean;
}

interface DailyFocusTotal {
  minutes: number;
  weekday: DayOfWeek;
}

function dailyFocusTotals(sessions: readonly FocusSession[]): Map<string, DailyFocusTotal> {
  const byDay = new Map<string, DailyFocusTotal>();
  for (const s of sessions) {
    if (s.durationSeconds === null) continue;
    const key = localDayKey(s.startedAt);
    const weekday = new Date(s.startedAt).getDay() as DayOfWeek;
    const entry = byDay.get(key) ?? { minutes: 0, weekday };
    entry.minutes += s.durationSeconds / 60;
    byDay.set(key, entry);
  }
  return byDay;
}

// learned from each weekday's last four occurrences, shrunk toward the median across weekdays by how
// many of the four exist. below three it's the typicalSessionMinutes * 2 fallback
export function weekdayCapacities(
  sessions: readonly FocusSession[],
  now: Date,
  typicalSessionMinutes: number,
): Map<DayOfWeek, WeekdayCapacity> {
  const byDay = dailyFocusTotals(sessions);
  const todayKey = localDayKey(now.toISOString());

  const perWeekday = new Map<DayOfWeek, number[]>();
  const dated = Array.from(byDay.entries())
    .filter(([key]) => key <= todayKey)
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));
  for (const [, entry] of dated) {
    const list = perWeekday.get(entry.weekday) ?? [];
    if (list.length < CAPACITY_OCCURRENCES) list.push(entry.minutes);
    perWeekday.set(entry.weekday, list);
  }

  const weekdayMedians = new Map<DayOfWeek, number>();
  for (let d = 0; d < 7; d += 1) {
    const values = perWeekday.get(d as DayOfWeek);
    if (values !== undefined && values.length > 0) weekdayMedians.set(d as DayOfWeek, median(values));
  }
  const overallMedian =
    weekdayMedians.size > 0 ? median(Array.from(weekdayMedians.values())) : typicalSessionMinutes * 2;

  const result = new Map<DayOfWeek, WeekdayCapacity>();
  for (let d = 0; d < 7; d += 1) {
    const weekday = d as DayOfWeek;
    const observations = perWeekday.get(weekday) ?? [];
    if (observations.length < MIN_OBSERVATIONS_FOR_CAPACITY) {
      result.set(weekday, { minutes: typicalSessionMinutes * 2, learned: false });
      continue;
    }
    const ownMedian = weekdayMedians.get(weekday) as number;
    const weight = observations.length / CAPACITY_OCCURRENCES;
    const minutes = weight * ownMedian + (1 - weight) * overallMedian;
    result.set(weekday, { minutes, learned: true });
  }
  return result;
}

export function focusSecondsInPeriod(
  sessions: readonly FocusSession[],
  now: Date,
  days: number,
): number {
  const cutoff = now.getTime() - days * MS_PER_DAY;
  let total = 0;
  for (const s of sessions) {
    if (s.durationSeconds === null) continue;
    if (new Date(s.startedAt).getTime() < cutoff) continue;
    total += s.durationSeconds;
  }
  return total;
}

export function isOverdue(task: Task, now: Date): boolean {
  return task.status !== 'complete' && new Date(task.dueDate).getTime() < now.getTime();
}

export function scheduledToday(tasks: readonly Task[], now: Date): Task[] {
  const today = localDayKey(now.toISOString());
  return tasks.filter((t) => {
    if (t.status === 'complete') return false;
    const when = t.startTime ?? t.proposedTime;
    return when !== null && localDayKey(when) === today;
  });
}

// home shows exactly one task, so this ordering is the whole feature
export function highestPriorityTask(tasks: readonly Task[], now: Date): Task | null {
  const open = tasks.filter((t) => t.status !== 'complete');
  if (open.length === 0) return null;

  const score = (t: Task): [number, number, number, number] => [
    isOverdue(t, now) ? 0 : 1,
    new Date(t.dueDate).getTime(),
    t.startTime !== null || t.proposedTime !== null ? 0 : 1,
    new Date(t.createdAt).getTime(),
  ];

  return [...open].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i += 1) {
      if (sa[i] !== sb[i]) return sa[i] - sb[i];
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}
