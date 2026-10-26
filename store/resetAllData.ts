// everything platform-bound is injected, so the whole wipe runs in node tests
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS } from '@/data/migrations';
import { clearAllData } from '@/data/clearAll';
import { STORAGE_KEYS, type StorageMeta } from '@/data/keys';
import type { Repository } from '@/data/repository';
import type { SchedulingState } from '@/store/schedulingStore';
import type { SessionState } from '@/store/sessionStore';
import type { SettingsState } from '@/store/settingsStore';
import type { TaskState } from '@/store/taskStore';

interface MinimalStoreApi<T> {
  getState: () => T;
  setState: (partial: Partial<T>) => void;
}

export interface ResetAllDataDeps {
  repository: Repository;
  // otherwise a write queued just before the wipe could land after it and recreate its key
  flushWrites: () => Promise<void>;
  now: () => Date;
  taskStore: MinimalStoreApi<TaskState>;
  settingsStore: MinimalStoreApi<SettingsState>;
  sessionStore: MinimalStoreApi<SessionState>;
  schedulingStore: MinimalStoreApi<SchedulingState>;
  notificationStore: {
    getState: () => {
      // sync schedules the recompute and flush runs it now. flush alone is a no-op with nothing pending
      syncNotifications: () => void;
      flushNotifications: () => Promise<void>;
      // backstop that doesn't trust the diff, so no OS notification survives a wipe
      cancelAllScheduled: () => Promise<void>;
    };
  };
}

export async function resetAllData(deps: ResetAllDataDeps): Promise<void> {
  // empty tasks first so the next sync plans nothing and the diff cancels every scheduled
  // notification. generation is cancelled so no in-flight breakdown lands on the empty store
  deps.taskStore.getState().cancelAllGeneration();
  deps.taskStore.setState({ tasks: [], breakdownInFlight: [], lastBreakdown: null });
  deps.notificationStore.getState().syncNotifications();
  await deps.notificationStore.getState().flushNotifications();

  // privacy wins: a failed notification cancel must never stop the data wipe below
  let notificationError: unknown = null;
  try {
    await deps.notificationStore.getState().cancelAllScheduled();
  } catch (error) {
    notificationError = error;
  }

  await deps.flushWrites();

  // stores reset in finally even when the clear partly fails, or a later persist could
  // resurrect a removed key with stale data. the error is rethrown after
  let clearError: unknown = null;
  try {
    await clearAllData(deps.repository);
    // without a current meta the next launch reads version 0 and migrates over whatever the
    // student adds next. a failed meta write counts as a failed wipe
    const meta: StorageMeta = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      lastRescheduleAt: null,
      installedAt: deps.now().toISOString(),
    };
    await deps.repository.save(STORAGE_KEYS.meta, meta);
  } catch (error) {
    clearError = error;
  } finally {
    // the state hydrate gives a new install, without calling hydrate, which would write keys back
    deps.sessionStore.setState({ activeSession: null, sessions: [] });
    deps.schedulingStore.setState({ signals: [] });
    deps.settingsStore.setState({ ...DEFAULT_SETTINGS });
  }

  if (clearError !== null) {
    // the wipe error is what's thrown. a notification error rides along, never masks it
    if (notificationError !== null && clearError instanceof Error) {
      Object.assign(clearError, { notificationError });
    }
    throw clearError;
  }
  // the wipe landed, so a notification-only failure leaves nothing for the caller to retry
}
