// day periods shared by the scheduler and the notification planner so the two can't drift.
// contiguous from 06:00 to 23:00, so a busy period leaves no gap for a slot to hide in
import type { DayKey, PeriodKey } from '@/types';

// [startHour, endHour)
export const PERIOD_HOURS: Readonly<Record<PeriodKey, readonly [number, number]>> = {
  morning: [6, 12],
  afternoon: [12, 18],
  evening: [18, 23],
} as const;

export const DAY_KEYS: readonly DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function dayKeyFor(date: Date): DayKey {
  return DAY_KEYS[date.getDay()];
}

export function periodFor(hour: number): PeriodKey | null {
  for (const [period, [start, end]] of Object.entries(PERIOD_HOURS) as [
    PeriodKey,
    readonly [number, number],
  ][]) {
    if (hour >= start && hour < end) return period;
  }
  return null;
}

export function isQuietHour(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  return hour >= quietStart || hour < quietEnd;
}
