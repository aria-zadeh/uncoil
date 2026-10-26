// the only store file that imports expo-crypto or AsyncStorage. every other store gets its
// deps injected so it runs in node tests
import * as Crypto from 'expo-crypto';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { UserSettings } from '@/types';

import { AsyncStorageRepository } from '@/data/asyncStorageRepository';
import { hydrate } from '@/data/hydrate';
import { CURRENT_SCHEMA_VERSION } from '@/data/migrations';
import { WriteQueue } from '@/data/writeQueue';
import { BACKUP_FORMAT_VERSION } from '@/services/backup';
import { pickBackupText, writeBackupAndShare } from '@/services/backupFiles';
import {
  cancel as cancelGeneration,
  generateBreakdown,
  generateExtraction,
  generateSimplification,
  getModelStatus,
  installModelRuntime,
  isCancellation,
  onStatusChange,
  setGenerationEnabled,
} from '@/services/generation';
import { createExecutorchRuntime, initExecutorchRuntime } from '@/services/executorchRuntime';
import {
  cancelAll as cancelAllNotifications,
  cancelOne as cancelNotification,
  getPermissionStatus,
  getScheduledIds as getScheduledNotificationIds,
  requestNotificationPermission,
  scheduleOne as scheduleNotification,
} from '@/services/notifications';
import { duePhraseFor } from '@/services/prompt';
import { createGenerationStore, type GenerationState } from '@/store/generationStore';
import { createNotificationStore, type NotificationState } from '@/store/notificationStore';
import { createSchedulingStore, type SchedulingState } from '@/store/schedulingStore';
import { createSessionStore, type SessionState } from '@/store/sessionStore';
import { createSettingsStore, toUserSettings, type SettingsState } from '@/store/settingsStore';
import { proposeForTask } from '@/store/schedulerAdapter';
import { resetAllData as resetAllDataCore } from '@/store/resetAllData';
import { exportAllData as exportAllDataCore } from '@/store/exportData';
import { importAllData as importAllDataCore, type ImportResult } from '@/store/importData';
import { createTaskStore, type TaskState } from '@/store/taskStore';
import { createWriteStatusStore, type WriteStatusState } from '@/store/writeStatusStore';

const repository = new AsyncStorageRepository();
// built before the queue so a failure right after hydration is still recorded
const writeStatusStoreApi = createWriteStatusStore();
const queue = new WriteQueue(repository, {
  onFailure: (failure) => writeStatusStoreApi.getState().recordFailure(failure),
});

const now = (): string => new Date().toISOString();
const newId = (): string => Crypto.randomUUID();
const nowDate = (): Date => new Date();

let taskStoreApi: StoreApi<TaskState> | undefined;
let settingsStoreApi: StoreApi<SettingsState> | undefined;
let sessionStoreApi: StoreApi<SessionState> | undefined;
let schedulingStoreApi: StoreApi<SchedulingState> | undefined;
let generationStoreApi: StoreApi<GenerationState> | undefined;
let notificationStoreApi: StoreApi<NotificationState> | undefined;

export let storesReady = false;

/** hydration is async, so screens must not render before this resolves */
export async function initializeStores(): Promise<void> {
  if (storesReady) return;

  // set up here because app/ never imports services. it doesn't touch storage, so it runs
  // before hydration
  initExecutorchRuntime();
  installModelRuntime(createExecutorchRuntime());

  const hydrated = await hydrate(repository);

  const settings = createSettingsStore(
    {
      queue,
      now,
      newId,
      // forward reference. nothing calls it before this function resolves
      notificationStore: { getState: () => getStore(notificationStoreApi, 'notificationStore').getState() },
    },
    hydrated.settings,
  );
  // services can't import stores, so the opt-out is pushed from here: once now, then on change
  setGenerationEnabled(!settings.getState().generationOptOut);
  settings.subscribe((state, prevState) => {
    if (state.generationOptOut !== prevState.generationOptOut) {
      setGenerationEnabled(!state.generationOptOut);
    }
  });

  const scheduling = createSchedulingStore({ queue, now, newId }, hydrated.signals);
  // built before the task store, which writes the tier and last failure into it
  const generation = createGenerationStore();
  generation.getState().setStatus(getModelStatus());
  // a load failure can come long after launch, on the first breakdown, so keep following it
  onStatusChange((status) => generation.getState().setStatus(status));
  const tasks = createTaskStore(
    {
      queue,
      now,
      newId,
      settingsStore: { getState: settings.getState },
      schedulingStore: { getState: scheduling.getState },
      // day capacity for the feasibility forecast. forward reference, sessions read tasks
      sessionStore: { getState: () => getStore(sessionStoreApi, 'sessionStore').getState() },
      // same forward reference as above
      notificationStore: { getState: () => getStore(notificationStoreApi, 'notificationStore').getState() },
      propose: (context) => proposeForTask(context),
      generate: generateBreakdown,
      generateExtraction,
      generateSimplification,
      cancelGeneration,
      isCancellation,
      generationStore: { getState: () => generation.getState() },
      // absolute dates are never sent to the model
      duePhraseFor: (dueDateIso) => duePhraseFor(dueDateIso, new Date()),
    },
    hydrated.tasks,
  );
  const sessions = createSessionStore(
    {
      queue,
      now,
      newId,
      taskStore: { getState: tasks.getState },
      schedulingStore: { getState: scheduling.getState },
    },
    hydrated.sessions,
  );

  const notification = createNotificationStore({
    taskStore: { getState: tasks.getState },
    settingsStore: { getState: settings.getState },
    adapter: {
      requestPermission: requestNotificationPermission,
      getPermissionStatus,
      cancelOne: cancelNotification,
      scheduleOne: scheduleNotification,
      cancelAll: cancelAllNotifications,
      getScheduledIds: getScheduledNotificationIds,
    },
  });

  settingsStoreApi = settings;
  schedulingStoreApi = scheduling;
  taskStoreApi = tasks;
  sessionStoreApi = sessions;
  generationStoreApi = generation;
  notificationStoreApi = notification;

  storesReady = true;
}

function getStore<T>(api: StoreApi<T> | undefined, name: string): StoreApi<T> {
  if (!api) {
    throw new Error(`${name} was read before initializeStores() resolved.`);
  }
  return api;
}

export function useTaskStore<T>(selector: (state: TaskState) => T): T {
  return useStore(getStore(taskStoreApi, 'taskStore'), selector);
}

export function useSettingsStore<T>(selector: (state: SettingsState) => T): T {
  return useStore(getStore(settingsStoreApi, 'settingsStore'), selector);
}

export function useSessionStore<T>(selector: (state: SessionState) => T): T {
  return useStore(getStore(sessionStoreApi, 'sessionStore'), selector);
}

export function useSchedulingStore<T>(selector: (state: SchedulingState) => T): T {
  return useStore(getStore(schedulingStoreApi, 'schedulingStore'), selector);
}

export function useGenerationStore<T>(selector: (state: GenerationState) => T): T {
  return useStore(getStore(generationStoreApi, 'generationStore'), selector);
}

export function useNotificationStore<T>(selector: (state: NotificationState) => T): T {
  return useStore(getStore(notificationStoreApi, 'notificationStore'), selector);
}

/** safe before initializeStores() */
export function useWriteStatusStore<T>(selector: (state: WriteStatusState) => T): T {
  return useStore(writeStatusStoreApi, selector);
}

/** call when the app leaves the foreground */
export function flushWrites(): Promise<void> {
  return queue.flush();
}

// call beside flushWrites on backgrounding, so a task finished just before the app is killed
// still cancels its reminders. never rejects
export function flushNotifications(): Promise<void> {
  if (!notificationStoreApi) return Promise.resolve();
  return notificationStoreApi.getState().flushNotifications();
}

export function resetAllData(): Promise<void> {
  return resetAllDataCore({
    repository,
    flushWrites,
    now: nowDate,
    taskStore: getStore(taskStoreApi, 'taskStore'),
    settingsStore: getStore(settingsStoreApi, 'settingsStore'),
    sessionStore: getStore(sessionStoreApi, 'sessionStore'),
    schedulingStore: getStore(schedulingStoreApi, 'schedulingStore'),
    notificationStore: getStore(notificationStoreApi, 'notificationStore'),
  });
}

/** live settings outside React, for code that can't call a hook */
export function getSettingsSnapshot(): UserSettings {
  return toUserSettings(getStore(settingsStoreApi, 'settingsStore').getState());
}

export function exportAllData(): Promise<void> {
  return exportAllDataCore({
    taskStore: getStore(taskStoreApi, 'taskStore'),
    settingsStore: getStore(settingsStoreApi, 'settingsStore'),
    sessionStore: getStore(sessionStoreApi, 'sessionStore'),
    schedulingStore: getStore(schedulingStoreApi, 'schedulingStore'),
    currentSchemaVersion: CURRENT_SCHEMA_VERSION,
    now: nowDate,
    writeAndShare: writeBackupAndShare,
  });
}

/** replaces all local data with the backup in text, usually from pickBackupText */
export async function importAllData(text: string): Promise<ImportResult> {
  try {
    return await importAllDataCore(text, {
      repository,
      flushWrites,
      currentSchemaVersion: CURRENT_SCHEMA_VERSION,
      currentFormatVersion: BACKUP_FORMAT_VERSION,
      now: nowDate,
      taskStore: getStore(taskStoreApi, 'taskStore'),
      settingsStore: getStore(settingsStoreApi, 'settingsStore'),
      sessionStore: getStore(sessionStoreApi, 'sessionStore'),
      schedulingStore: getStore(schedulingStoreApi, 'schedulingStore'),
      notificationStore: getStore(notificationStoreApi, 'notificationStore'),
    });
  } catch (error) {
    // a failed write comes back as a result, not a rejection, so the screen can say it didn't land
    return { ok: false, reason: 'write-failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

/** re-exported because app/ never imports services. null when the picker is cancelled */
export { pickBackupText };
