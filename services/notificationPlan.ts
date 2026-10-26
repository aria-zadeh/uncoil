// pure notification planning, notifications.ts hands the result to the os. hard rules: never in quiet
// hours, never over the hourly cap, never during a busy block or event, never for a completed task
import { dayKeyFor, isQuietHour, periodFor } from '@/services/periods';
import type { CalendarEvent, Task, UserSettings } from '@/types';

export type NotificationKind = 'best_time' | 'deadline' | 'inactivity';

export interface PlannedNotification {
  // stable across replans so rescheduling replaces instead of duplicating
  id: string;
  taskId: string;
  kind: NotificationKind;
  // iso 8601
  fireAt: string;
  title: string;
  body: string;
}

export interface PlanOptions {
  // beyond this the next foreground replans
  horizonDays?: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const DEFAULTS = { horizonDays: 7 };

// ios keeps only the 64 soonest pending notifications and silently drops the rest. leave headroom,
// the next foreground replans anyway
export const MAX_SCHEDULED = 60;

// starterAction only describes step one, so once any step is done name the next undone one instead
function currentStep(task: Task): string | null {
  const steps = [...task.subtasks].sort((a, b) => a.order - b.order);
  if (steps.some((s) => s.isComplete)) {
    return steps.find((s) => !s.isComplete)?.title ?? null;
  }
  return task.starterAction ?? steps[0]?.title ?? null;
}

// copy is direct and warm, never urgent or guilt-inducing
function bestTimeCopy(task: Task): { title: string; body: string } {
  const step = currentStep(task);
  return {
    title: `Good time to start ${task.title}`,
    body: step ?? 'Fifteen minutes from now, if you want it.',
  };
}

function deadlineCopy(task: Task): { title: string; body: string } {
  return {
    title: `${task.title} is due tomorrow`,
    body: currentStep(task) ?? 'There is still time to make a start.',
  };
}

function inactivityCopy(task: Task): { title: string; body: string } {
  return {
    title: `${task.title} is still waiting`,
    body: currentStep(task) ?? 'The first step is small.',
  };
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

// a repeating event occurs on each of its repeatDays from its start date on, not just on date
function coveredByEvent(at: Date, events: readonly CalendarEvent[]): boolean {
  const y = at.getFullYear();
  const mo = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  const dateKey = `${y}-${mo}-${d}`;
  const weekday = dayKeyFor(at);
  const minute = at.getHours() * 60 + at.getMinutes();
  return events.some((e) => {
    const repeats = e.repeatDays.length > 0;
    // both are zero-padded yyyy-mm-dd, so comparing as strings is exact
    const onThisDay = repeats
      ? dateKey >= e.date && e.repeatDays.includes(weekday)
      : e.date === dateKey;
    if (!onThisDay) return false;
    return minute >= minutesOfDay(e.startTime) && minute < minutesOfDay(e.endTime);
  });
}

function coveredByBusyBlock(at: Date, settings: UserSettings): boolean {
  const day = dayKeyFor(at);
  const period = periodFor(at.getHours());
  if (period === null) return false;
  return settings.busyBlocks.some((b) => b.day === day && b.period === period);
}

export const DEADLINE_FALLBACK_HOUR = 17;

// with the default 23:59 due time and 23:00-08:00 quiet hours, 24 hours before due is always quiet.
// fall back to 17:00 that day, or the latest hour that day that isn't quiet
function deadlineFireTime(due: Date, settings: UserSettings): Date {
  const ideal = new Date(due.getTime() - DAY);
  if (Number.isNaN(ideal.getTime())) return ideal;
  if (!isQuietHour(ideal.getHours(), settings.quietHoursStart, settings.quietHoursEnd)) return ideal;
  const at = (hour: number): Date => new Date(ideal.getFullYear(), ideal.getMonth(), ideal.getDate(), hour, 0, 0, 0);
  if (!isQuietHour(DEADLINE_FALLBACK_HOUR, settings.quietHoursStart, settings.quietHoursEnd)) {
    return at(DEADLINE_FALLBACK_HOUR);
  }
  for (let hour = 23; hour >= 0; hour -= 1) {
    if (!isQuietHour(hour, settings.quietHoursStart, settings.quietHoursEnd)) return at(hour);
  }
  return ideal;
}

function isBlocked(at: Date, settings: UserSettings): boolean {
  if (isQuietHour(at.getHours(), settings.quietHoursStart, settings.quietHoursEnd)) return true;
  if (coveredByBusyBlock(at, settings)) return true;
  if (coveredByEvent(at, settings.calendarEvents)) return true;
  return false;
}

// per local clock hour, earliest wins. extras are dropped, not deferred: a late reminder is worse than none
function applyHourlyCap(
  candidates: readonly PlannedNotification[],
  maxPerHour: number,
): PlannedNotification[] {
  if (maxPerHour <= 0) return [];
  const countByHour = new Map<string, number>();
  const kept: PlannedNotification[] = [];
  for (const n of candidates) {
    // local hour, not utc. utc buckets straddle two local hours in half-hour-offset zones
    const at = new Date(n.fireAt);
    const bucket = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}-${at.getHours()}`;
    const used = countByHour.get(bucket) ?? 0;
    if (used >= maxPerHour) continue;
    countByHour.set(bucket, used + 1);
    kept.push(n);
  }
  return kept;
}

export function planNotifications(
  tasks: readonly Task[],
  settings: UserSettings,
  now: Date,
  options: PlanOptions = {},
): PlannedNotification[] {
  if (!settings.notificationsEnabled) return [];

  const horizonMs = (options.horizonDays ?? DEFAULTS.horizonDays) * DAY;
  const horizon = new Date(now.getTime() + horizonMs);
  const candidates: PlannedNotification[] = [];

  for (const task of tasks) {
    if (task.status === 'complete') continue;

    const start = task.startTime ?? task.proposedTime;
    if (start !== null) {
      const fire = new Date(new Date(start).getTime() - 15 * MINUTE);
      if (fire > now && fire <= horizon) {
        const copy = bestTimeCopy(task);
        candidates.push({
          id: `best-time:${task.id}`,
          taskId: task.id,
          kind: 'best_time',
          fireAt: fire.toISOString(),
          ...copy,
        });
      }
    }

    const due = new Date(task.dueDate);
    const deadlineFire = deadlineFireTime(due, settings);
    if (deadlineFire > now && deadlineFire < due && deadlineFire <= horizon) {
      const copy = deadlineCopy(task);
      candidates.push({
        id: `deadline:${task.id}`,
        taskId: task.id,
        kind: 'deadline',
        fireAt: deadlineFire.toISOString(),
        ...copy,
      });
    }

    // a day after the last touch or three days before due, whichever is later. a fixed instant so every
    // replan agrees, and never chased once passed, or it would fire again on every app open
    const idleSince = new Date(task.updatedAt).getTime();
    const fire = new Date(Math.max(idleSince + DAY, due.getTime() - 3 * DAY));
    if (fire > now && fire < due) {
      if (fire <= horizon) {
        const copy = inactivityCopy(task);
        candidates.push({
          id: `inactivity:${task.id}`,
          taskId: task.id,
          kind: 'inactivity',
          fireAt: fire.toISOString(),
          ...copy,
        });
      }
    }
  }

  const allowed = candidates
    .filter((n) => !isBlocked(new Date(n.fireAt), settings))
    .sort((a, b) => (a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : a.id < b.id ? -1 : 1));

  return applyHourlyCap(allowed, settings.maxNotificationsPerHour).slice(0, MAX_SCHEDULED);
}
