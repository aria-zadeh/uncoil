export type UrgencyLevel = 'none' | 'soon' | 'urgent';

export const URGENCY_HOURS = {
  urgent: 12,
  soon: 48,
} as const;

export function getUrgencyLevel(dueDate: string, now: Date = new Date()): UrgencyLevel {
  const hoursUntilDue = (new Date(dueDate).getTime() - now.getTime()) / 3_600_000;
  if (hoursUntilDue < URGENCY_HOURS.urgent) return 'urgent';
  if (hoursUntilDue < URGENCY_HOURS.soon) return 'soon';
  return 'none';
}

// colour is never the only carrier of meaning, so every level has an icon too
export const urgency: Record<UrgencyLevel, { color: string; icon: 'time-outline' | 'alert-circle-outline' | 'warning-outline' }> = {
  none: { color: 'text-content-secondary', icon: 'time-outline' },
  soon: { color: 'text-warning', icon: 'alert-circle-outline' },
  urgent: { color: 'text-danger', icon: 'warning-outline' },
};

export const MEDIUM_DAYS = 7;

// same names as Chip's dot
export type UrgencyTone = 'success' | 'warning' | 'danger';

export function urgencyChip(dueDate: string, now: Date): { dot: UrgencyTone; label: string } {
  const due = new Date(dueDate);
  if (due.getTime() < now.getTime()) return { dot: 'danger', label: 'Overdue' };
  const level = getUrgencyLevel(dueDate, now);
  if (level !== 'none') return { dot: 'danger', label: 'Urgent' };
  const days = (due.getTime() - now.getTime()) / 86_400_000;
  if (days <= MEDIUM_DAYS) return { dot: 'warning', label: 'Medium' };
  return { dot: 'success', label: 'Low' };
}
