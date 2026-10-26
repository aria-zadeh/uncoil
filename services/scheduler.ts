// slot scoring and proposal selection. pure, `now` is passed in so tests use fixtures.
// rules live in docs/SCHEDULING.md
import { blockLengthMultiplier, weekdayCapacities, type WeekdayCapacity } from '@/services/insights';
import { PERIOD_HOURS, dayKeyFor, isQuietHour, periodFor } from '@/services/periods';
import type { DayOfWeek, FocusSession, SchedulingSignal, Task, UserSettings } from '@/types';

export const SLOT_MINUTES = 15;
// gap after every block so nothing is back to back
export const BUFFER_MINUTES = 15;
export const CONTINUOUS_WORK_LIMIT_MINUTES = 90;
// half-life in days. no hard cutoff, old signals just count for less
export const RECENCY_HALF_LIFE_DAYS = 14;
// pseudo-observations pulling a thin bucket toward the person's own overall rate
export const HISTORY_SHRINKAGE_K = 4;
// past this multiple of a day's learned capacity a slot is discarded, not just penalised
export const DAY_CAPACITY_DISCARD_MULTIPLIER = 1.25;
// how much better a new slot must score before an auto-placed block moves to it
export const REPLACEMENT_IMPROVEMENT_THRESHOLD = 0.75;
// with auto-accept on, a proposal nobody dismissed confirms itself after this
export const AUTO_ACCEPT_DELAY_MS = 24 * 60 * 60 * 1000;
export const FEASIBILITY_HORIZON_DAYS = 60;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MIN_REPLACEMENT_LEAD_MS = 2 * HOUR;
// history buckets are weekday x 3-hour band
const BAND_HOURS = 3;
const BANDS_PER_DAY = 24 / BAND_HOURS;

export const WEIGHTS = {
  energyWindow: 2,
  // applied to the shrunk (p_b - p̄) estimate
  history: 2,
  nearDeadline: -3,
  continuousWork: -3,
  // the heaviest term on purpose, it has to outrank every preference
  dayCapacity: -4,
  lateEvening: -1,
  earlier: 0.5,
} as const;

export interface SchedulerInput {
  task: Task;
  // excludes the task being scheduled
  otherTasks: readonly Task[];
  settings: UserSettings;
  signals: readonly SchedulingSignal[];
  now: Date;
  horizonDays?: number;
  // for learned daily capacity. without it every weekday uses the typicalSessionMinutes * 2 fallback
  sessions?: readonly FocusSession[];
}

export interface Proposal {
  startIso: string;
  endIso: string;
  score: number;
}

interface Interval {
  start: number;
  end: number;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

// matches localDayKey in insights.ts so committed minutes and capacity agree on what a day is
function dateKeyFor(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function occupiedIntervals(tasks: readonly Task[]): Interval[] {
  const intervals: Interval[] = [];
  for (const t of tasks) {
    if (t.status === 'complete') continue;
    const when = t.startTime ?? t.proposedTime;
    if (when === null) continue;
    const start = new Date(when).getTime();
    const duration = (t.durationMinutes ?? 60) * MINUTE;
    intervals.push({ start, end: start + duration + BUFFER_MINUTES * MINUTE });
  }
  return intervals.sort((a, b) => a.start - b.start);
}

// a repeating event has no end date, so occurrences are expanded over the window only, widened to local
// midnight so one that started before windowStart still blocks. dates are built in local time:
// new Date(date) would read utc, and setDate keeps local midnight across dst where adding 24 hours wouldn't
function eventIntervals(settings: UserSettings, windowStart: number, windowEnd: number): Interval[] {
  const intervals: Interval[] = [];
  for (const e of settings.calendarEvents) {
    const [y, m, d] = e.date.split('-').map(Number);
    if (!y || !m || !d) continue;
    const startMinutes = minutesOfDay(e.startTime);
    const endMinutes = minutesOfDay(e.endTime);
    // ending at or before the start spans nothing, and a zero-length interval would block nothing
    if (!(endMinutes > startMinutes)) continue;
    const firstDay = new Date(y, m - 1, d, 0, 0, 0, 0);
    // local-time constructor, midnight plus minutes lands an hour off on a dst change day
    const occurrence = (day: Date): Interval => ({
      start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, startMinutes).getTime(),
      end: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, endMinutes).getTime(),
    });

    if (e.repeatDays.length === 0) {
      intervals.push(occurrence(firstDay));
      continue;
    }

    const lastDay = new Date(windowEnd);
    lastDay.setHours(0, 0, 0, 0);
    const cursor = new Date(windowStart);
    cursor.setHours(0, 0, 0, 0);
    if (cursor.getTime() < firstDay.getTime()) cursor.setTime(firstDay.getTime());
    while (cursor.getTime() <= lastDay.getTime()) {
      if (e.repeatDays.includes(dayKeyFor(cursor))) {
        intervals.push(occurrence(cursor));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return intervals;
}

// walks every hour of the span, not just the start, so a slot can't straddle a busy boundary.
// calendar events are minute-precise and checked separately through overlaps
function spanTouchesBlockedHour(start: number, end: number, settings: UserSettings): boolean {
  const cursor = new Date(start);
  cursor.setMinutes(0, 0, 0);
  for (let t = cursor.getTime(); t < end; t += 60 * MINUTE) {
    const at = new Date(t);
    if (t + 60 * MINUTE <= start) continue;
    const hour = at.getHours();
    if (isQuietHour(hour, settings.quietHoursStart, settings.quietHoursEnd)) return true;
    const period = periodFor(hour);
    if (period !== null) {
      const day = dayKeyFor(at);
      if (settings.busyBlocks.some((b) => b.day === day && b.period === period)) return true;
    } else {
      // outside 06:00-23:00 there's no period to be busy in, but it isn't a time for schoolwork either
      return true;
    }
  }
  return false;
}

export interface HistoryBucket {
  // shrunk completion rate for this weekday and band, 0 to 1
  probability: number;
  // the person's overall rate, the same for every bucket, kept so scoreSlot can read the difference
  overallRate: number;
}

interface WeightedCounts {
  completed: number;
  attempts: number;
}

function addWeighted(map: Map<number, WeightedCounts>, key: number, weight: number, completed: boolean): void {
  const entry = map.get(key) ?? { completed: 0, attempts: 0 };
  entry.attempts += weight;
  if (completed) entry.completed += weight;
  map.set(key, entry);
}

// p_b = (c + k*p̄) / (n + k)
function shrink(completed: number, attempts: number, overallRate: number): number {
  return (completed + HISTORY_SHRINKAGE_K * overallRate) / (attempts + HISTORY_SHRINKAGE_K);
}

// computed once instead of per candidate slot. a bucket with under one weighted observation backs off to
// its band across weekdays, then to the overall rate, which is just shrink(0, 0, overallRate)
export function buildHistory(signals: readonly SchedulingSignal[], now: Date): Map<number, HistoryBucket> {
  const byWeekdayBand = new Map<number, WeightedCounts>();
  const byBand = new Map<number, WeightedCounts>();
  let globalCompleted = 0;
  let globalAttempts = 0;

  for (const s of signals) {
    // partial moves no estimate in either direction
    if (s.outcome === 'partial') continue;
    const recordedAt = new Date(s.recordedAt).getTime();
    const ageDays = Math.max(0, (now.getTime() - recordedAt) / DAY);
    const weight = 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
    const completed = s.outcome === 'completed';
    const band = Math.floor(s.hourOfDay / BAND_HOURS);
    const weekdayBandKey = s.dayOfWeek * BANDS_PER_DAY + band;

    addWeighted(byWeekdayBand, weekdayBandKey, weight, completed);
    addWeighted(byBand, band, weight, completed);
    globalAttempts += weight;
    if (completed) globalCompleted += weight;
  }

  const overallRate = globalAttempts > 0 ? globalCompleted / globalAttempts : 0.5;

  const history = new Map<number, HistoryBucket>();
  for (let day = 0; day < 7; day += 1) {
    for (let band = 0; band < BANDS_PER_DAY; band += 1) {
      const ownBucket = byWeekdayBand.get(day * BANDS_PER_DAY + band);
      const bandAcrossDays = byBand.get(band);
      let probability = overallRate;
      if (ownBucket !== undefined && ownBucket.attempts >= 1) {
        probability = shrink(ownBucket.completed, ownBucket.attempts, overallRate);
      } else if (bandAcrossDays !== undefined && bandAcrossDays.attempts >= 1) {
        probability = shrink(bandAcrossDays.completed, bandAcrossDays.attempts, overallRate);
      }
      const bucket: HistoryBucket = { probability, overallRate };
      for (let h = 0; h < BAND_HOURS; h += 1) {
        history.set(day * 24 + band * BAND_HOURS + h, bucket);
      }
    }
  }
  return history;
}

export interface CapacityContext {
  capacityByWeekday: ReadonlyMap<DayOfWeek, WeekdayCapacity>;
  committedMinutesByDate: ReadonlyMap<string, number>;
}

function committedMinutesByDate(tasks: readonly Task[]): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const t of tasks) {
    if (t.status === 'complete') continue;
    const when = t.startTime ?? t.proposedTime;
    if (when === null) continue;
    const key = dateKeyFor(new Date(when));
    const minutes = t.durationMinutes ?? 60;
    byDate.set(key, (byDate.get(key) ?? 0) + minutes);
  }
  return byDate;
}

// once per proposeSlot run, not per candidate slot
export function buildCapacityContext(
  otherTasks: readonly Task[],
  sessions: readonly FocusSession[] | undefined,
  settings: UserSettings,
  now: Date,
): CapacityContext {
  return {
    capacityByWeekday: weekdayCapacities(sessions ?? [], now, settings.typicalSessionMinutes),
    committedMinutesByDate: committedMinutesByDate(otherTasks),
  };
}

// a gap of 30 minutes or less counts as the same stretch
function continuousWorkBefore(start: number, occupied: readonly Interval[]): number {
  const GAP = 30 * MINUTE;
  let total = 0;
  let boundary = start;
  // occupied is sorted by start
  for (let i = occupied.length - 1; i >= 0; i -= 1) {
    const interval = occupied[i];
    if (interval.end > boundary) continue;
    if (boundary - interval.end > GAP) break;
    total += (interval.end - interval.start) / MINUTE - BUFFER_MINUTES;
    boundary = interval.start;
  }
  return Math.max(0, total);
}

export function scoreSlot(
  start: number,
  durationMs: number,
  input: SchedulerInput,
  history: Map<number, HistoryBucket>,
  occupied: readonly Interval[],
  capacity?: CapacityContext,
): number {
  const { settings, task, now } = input;
  const at = new Date(start);
  const hour = at.getHours();
  let score = 0;

  if (hour >= settings.energyPeakStart && hour < settings.energyPeakEnd) {
    score += WEIGHTS.energyWindow;
  }

  const bucket = history.get(at.getDay() * 24 + hour);
  if (bucket !== undefined) {
    // an hour is good when it beats this person's own average, not because something got done in it
    score += WEIGHTS.history * (bucket.probability - bucket.overallRate);
  }

  const due = new Date(task.dueDate).getTime();
  if (start + durationMs > due - DAY) {
    score += WEIGHTS.nearDeadline;
  }

  if (continuousWorkBefore(start, occupied) + durationMs / MINUTE > CONTINUOUS_WORK_LIMIT_MINUTES) {
    score += WEIGHTS.continuousWork;
  }

  if (capacity !== undefined) {
    // the only term that can discard a slot. gated on learned: the fallback is a rough guess meant for
    // the feasibility forecast, and it shouldn't make a normal task unplaceable before capacity is known
    const dayCapacity = capacity.capacityByWeekday.get(at.getDay() as DayOfWeek);
    if (dayCapacity !== undefined && dayCapacity.learned) {
      const committed = capacity.committedMinutesByDate.get(dateKeyFor(at)) ?? 0;
      const projectedMinutes = committed + durationMs / MINUTE;
      if (projectedMinutes > dayCapacity.minutes * DAY_CAPACITY_DISCARD_MULTIPLIER) {
        return Number.NEGATIVE_INFINITY;
      }
      if (projectedMinutes > dayCapacity.minutes) {
        score += WEIGHTS.dayCapacity;
      }
    }
  }

  if (hour >= PERIOD_HOURS.evening[1] - 1) score += WEIGHTS.lateEvening;

  // earlier, all else equal. normalised over the horizon so it stays small next to the other terms
  const horizonMs = Math.max(MINUTE, due - now.getTime());
  score += WEIGHTS.earlier * (1 - (start - now.getTime()) / horizonMs);

  return score;
}

function roundUpToSlot(time: number): number {
  const slotMs = SLOT_MINUTES * MINUTE;
  return Math.ceil(time / slotMs) * slotMs;
}

export interface ReplacementCheck {
  // null means a first placement, not a move
  currentStartIso: string | null;
  // a string, not ScheduleStatus, so rows from older installs with retired values still read
  currentScheduleStatus: string;
  currentScore: number;
  candidateScore: number;
  // the current slot is no longer legal (busy block, event, quiet hours, another task). scoring can't
  // see that, so it's passed in
  currentSlotUnusable?: boolean;
  now: Date;
}

// whether a placed block may move. the once-per-foreground throttle lives in app/_layout.tsx
export function canReplaceBlock(check: ReplacementCheck): boolean {
  const { currentStartIso, currentScheduleStatus, currentScore, candidateScore, now } = check;
  if (currentStartIso === null) return true;
  // pinned never moves, whatever the lead time or score
  if (currentScheduleStatus === 'pinned') return false;
  const currentStart = new Date(currentStartIso).getTime();
  if (currentStart <= now.getTime()) return false;
  if (currentStart - now.getTime() < MIN_REPLACEMENT_LEAD_MS) return false;
  // an unusable slot always moves. the score threshold only chooses between valid slots
  if (check.currentSlotUnusable) return true;
  // an auto block only moves for a solid improvement, not noise
  return candidateScore - currentScore >= REPLACEMENT_IMPROVEMENT_THRESHOLD;
}

export function proposeSlot(input: SchedulerInput): Proposal | null {
  const { task, otherTasks, settings, signals, now, sessions } = input;
  const baseDurationMinutes = task.durationMinutes ?? settings.typicalSessionMinutes ?? 60;
  // calibrated by how long this person's work actually takes against the estimate
  const durationMinutes = baseDurationMinutes * blockLengthMultiplier(signals);
  const durationMs = durationMinutes * MINUTE;
  // a zero, negative or NaN duration from a bad import would make the slot walk effectively endless
  if (!(durationMs > 0)) return null;

  const due = new Date(task.dueDate).getTime();
  if (Number.isNaN(due) || due <= now.getTime()) return null;

  const horizonMs = (input.horizonDays ?? 14) * DAY;
  // the latest any candidate can end, so also the window repeating events are expanded over
  const windowEnd = Math.min(due, now.getTime() + horizonMs);
  const latestStart = windowEnd - durationMs;
  if (latestStart < now.getTime()) return null;

  const occupied = [
    ...occupiedIntervals(otherTasks),
    ...eventIntervals(settings, now.getTime(), windowEnd),
  ].sort((a, b) => a.start - b.start);
  const history = buildHistory(signals, now);
  const capacity = buildCapacityContext(otherTasks, sessions, settings, now);

  let best: Proposal | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (
    let start = roundUpToSlot(now.getTime());
    start <= latestStart;
    start += SLOT_MINUTES * MINUTE
  ) {
    const end = start + durationMs;
    if (spanTouchesBlockedHour(start, end, settings)) continue;
    if (occupied.some((interval) => overlaps({ start, end }, interval))) continue;

    const score = scoreSlot(start, durationMs, input, history, occupied, capacity);
    // strictly greater: the earliest slot wins a tie, and a discarded slot (-Infinity) never wins
    if (score > bestScore) {
      bestScore = score;
      best = {
        startIso: new Date(start).toISOString(),
        endIso: new Date(end).toISOString(),
        score,
      };
    }
  }

  // a task already on the calendar is being reconsidered, so moving it goes through canReplaceBlock
  const currentStartIso = task.startTime ?? task.proposedTime ?? null;
  // an unparseable current start isn't a placement, so the task counts as unplaced
  const currentStartMs = currentStartIso === null ? Number.NaN : new Date(currentStartIso).getTime();
  if (
    currentStartIso !== null &&
    Number.isFinite(currentStartMs) &&
    best !== null &&
    best.startIso !== currentStartIso
  ) {
    const currentStart = currentStartMs;
    const currentScore = scoreSlot(currentStart, durationMs, input, history, occupied, capacity);
    // the same tests the slot loop applies. if the current slot fails them it isn't a slot any more
    const currentEnd = currentStart + durationMs;
    const currentSlotUnusable =
      spanTouchesBlockedHour(currentStart, currentEnd, settings) ||
      occupied.some((interval) => overlaps({ start: currentStart, end: currentEnd }, interval));
    const allowed = canReplaceBlock({
      currentStartIso,
      currentScheduleStatus: task.scheduleStatus,
      currentScore,
      candidateScore: bestScore,
      currentSlotUnusable,
      now,
    });
    if (!allowed) {
      return {
        startIso: currentStartIso,
        endIso: new Date(currentStart + durationMs).toISOString(),
        score: currentScore,
      };
    }
  }

  return best;
}

export interface FeasibilityInput {
  task: Task;
  otherTasks: readonly Task[];
  sessions: readonly FocusSession[];
  settings: UserSettings;
  signals: readonly SchedulingSignal[];
  now: Date;
}

export interface FeasibilityResult {
  fits: boolean;
  availableMinutes: number;
  requiredMinutes: number;
}

// free minutes in the window after quiet hours, busy blocks, placed tasks and calendar events
function freeMinutesInWindow(
  windowStart: number,
  windowEnd: number,
  settings: UserSettings,
  occupied: readonly Interval[],
): number {
  if (windowEnd <= windowStart) return 0;
  let free = 0;
  const cursor = new Date(windowStart);
  cursor.setMinutes(0, 0, 0);
  for (let t = cursor.getTime(); t < windowEnd; t += 60 * MINUTE) {
    const hourStart = Math.max(t, windowStart);
    const hourEnd = Math.min(t + 60 * MINUTE, windowEnd);
    if (hourEnd <= hourStart) continue;
    const at = new Date(t);
    const hour = at.getHours();
    if (isQuietHour(hour, settings.quietHoursStart, settings.quietHoursEnd)) continue;
    const period = periodFor(hour);
    if (period === null) continue;
    const day = dayKeyFor(at);
    if (settings.busyBlocks.some((b) => b.day === day && b.period === period)) continue;
    free += (hourEnd - hourStart) / MINUTE;
  }
  for (const interval of occupied) {
    const overlapStart = Math.max(interval.start, windowStart);
    const overlapEnd = Math.min(interval.end, windowEnd);
    if (overlapEnd > overlapStart) free -= (overlapEnd - overlapStart) / MINUTE;
  }
  return Math.max(0, free);
}

/** does the calibrated duration fit before the due date? read-only, never places anything */
// each day adds the smaller of its free wall-clock time and its remaining learned capacity
export function forecastFeasibility(input: FeasibilityInput): FeasibilityResult {
  const { task, otherTasks, sessions, settings, signals, now } = input;
  // capped so a far due date (a typo, an imported year 9999) isn't millions of iterations on render
  const due = Math.min(
    new Date(task.dueDate).getTime(),
    now.getTime() + FEASIBILITY_HORIZON_DAYS * DAY,
  );
  const baseDuration = task.durationMinutes ?? settings.typicalSessionMinutes ?? 60;
  const requiredMinutes = baseDuration * blockLengthMultiplier(signals);

  if (Number.isNaN(due) || due <= now.getTime()) {
    return { fits: false, availableMinutes: 0, requiredMinutes };
  }

  const capacities = weekdayCapacities(sessions, now, settings.typicalSessionMinutes);
  const committed = committedMinutesByDate(otherTasks);
  // the day walk starts at local midnight today, so that's where repeating events expand from
  const firstDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const occupied = [
    ...occupiedIntervals(otherTasks),
    ...eventIntervals(settings, firstDayStart, due),
  ];

  let availableMinutes = 0;
  const cursor = new Date(firstDayStart);
  while (cursor.getTime() < due) {
    const dayStart = cursor.getTime();
    // calendar arithmetic, not + DAY: across dst a day is 23 or 25 hours
    cursor.setDate(cursor.getDate() + 1);
    const dayEnd = cursor.getTime();
    const windowStart = Math.max(dayStart, now.getTime());
    const windowEnd = Math.min(dayEnd, due);
    const weekday = new Date(dayStart).getDay() as DayOfWeek;
    const dayCapacity = capacities.get(weekday)?.minutes ?? settings.typicalSessionMinutes * 2;
    const alreadyCommitted = committed.get(dateKeyFor(new Date(dayStart))) ?? 0;
    const remainingCapacity = Math.max(0, dayCapacity - alreadyCommitted);
    const wallClockFree = freeMinutesInWindow(windowStart, windowEnd, settings, occupied);
    availableMinutes += Math.min(wallClockFree, remainingCapacity);
  }

  return { fits: availableMinutes >= requiredMinutes, availableMinutes, requiredMinutes };
}

// "not dismissed" is just "still proposed", dismissing clears it. proposedAt only changes when the
// proposal does, so this measures time since it was first made
export function shouldAutoAcceptProposal(task: Task, settings: UserSettings, now: Date): boolean {
  if (!settings.autoAcceptProposedSchedule) return false;
  if (task.scheduleStatus !== 'proposed') return false;
  if (task.proposedTime === null) return false;
  if (task.proposedAt === undefined || task.proposedAt === null) return false;
  const proposedAt = new Date(task.proposedAt).getTime();
  if (Number.isNaN(proposedAt)) return false;
  return now.getTime() - proposedAt >= AUTO_ACCEPT_DELAY_MS;
}
