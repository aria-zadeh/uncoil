// thin adapter over expo-notifications. policy lives in notificationPlan.ts.
// local only: no push token, no remote notifications
import * as Notifications from 'expo-notifications';

import { planNotifications, type PlannedNotification } from '@/services/notificationPlan';
import type { Task, UserSettings } from '@/types';

export type PermissionOutcome = 'granted' | 'denied' | 'undetermined';

// only called from the onboarding allow tap, never at launch
export async function requestNotificationPermission(): Promise<PermissionOutcome> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return 'granted';
  if (!existing.canAskAgain) return 'denied';
  const asked = await Notifications.requestPermissionsAsync();
  if (asked.granted) return 'granted';
  return asked.canAskAgain ? 'undetermined' : 'denied';
}

export async function getPermissionStatus(): Promise<PermissionOutcome> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return 'granted';
  return existing.canAskAgain ? 'undetermined' : 'denied';
}

export async function cancelAll(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

export async function cancelOne(id: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(id);
}

export async function getScheduledIds(): Promise<string[]> {
  const pending = await Notifications.getAllScheduledNotificationsAsync();
  return pending.map((n) => n.identifier);
}

// ids are stable across replans, so callers can diff and schedule only what changed
export async function scheduleOne(notification: PlannedNotification): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    identifier: notification.id,
    content: {
      title: notification.title,
      body: notification.body,
      data: { taskId: notification.taskId, kind: notification.kind },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(notification.fireAt),
    },
  });
}

// full resync. the store's sync action diffs and uses cancelOne / scheduleOne instead
export async function syncScheduledNotifications(
  tasks: readonly Task[],
  settings: UserSettings,
  now: Date = new Date(),
): Promise<PlannedNotification[]> {
  const plan = planNotifications(tasks, settings, now);
  await cancelAll();
  const results = await Promise.allSettled(plan.map(scheduleOne));
  return plan.filter((_, i) => results[i].status === 'fulfilled');
}
