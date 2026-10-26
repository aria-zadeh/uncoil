// order matters: back up the current state as a normal backup file, flush the queue so no
// stale write lands after the import, write directly, then replace (never merge) the stores
import { STORAGE_KEYS } from '@/data/keys';
import type { Repository } from '@/data/repository';
import { buildBackup, parseBackup } from '@/services/backup';
import type { BackupParseFailureReason } from '@/types';
import type { SchedulingState } from '@/store/schedulingStore';
import type { SessionState } from '@/store/sessionStore';
import { toUserSettings, type SettingsState } from '@/store/settingsStore';
import type { TaskState } from '@/store/taskStore';

interface MinimalStoreApi<T> {
  getState: () => T;
  setState: (partial: Partial<T>) => void;
}

export interface ImportDataDeps {
  repository: Repository;
  flushWrites: () => Promise<void>;
  currentSchemaVersion: number;
  currentFormatVersion: number;
  now: () => Date;
  taskStore: MinimalStoreApi<TaskState>;
  settingsStore: MinimalStoreApi<SettingsState>;
  sessionStore: MinimalStoreApi<SessionState>;
  schedulingStore: MinimalStoreApi<SchedulingState>;
  notificationStore: {
    getState: () => {
      syncNotifications: () => void;
      flushNotifications: () => Promise<void>;
    };
  };
}

export type ImportResult =
  | { ok: true; counts: { tasks: number; sessions: number } }
  | { ok: false; reason: BackupParseFailureReason; detail?: string };

export async function importAllData(text: string, deps: ImportDataDeps): Promise<ImportResult> {
  const parsed = parseBackup(text, deps.currentSchemaVersion, deps.currentFormatVersion);
  if (!parsed.ok) {
    return parsed.detail === undefined
      ? { ok: false, reason: parsed.reason }
      : { ok: false, reason: parsed.reason, detail: parsed.detail };
  }

  const preImport = buildBackup({
    tasks: deps.taskStore.getState().tasks,
    sessions: deps.sessionStore.getState().sessions,
    signals: deps.schedulingStore.getState().signals,
    settings: toUserSettings(deps.settingsStore.getState()),
    schemaVersion: deps.currentSchemaVersion,
    now: deps.now(),
  });
  await deps.repository.save(STORAGE_KEYS.backupPreImport, preImport);

  await deps.flushWrites();

  // no multi-key transaction, so the backup doubles as the crash marker hydrate restores.
  // on failure roll back, and drop the marker only if the rollback landed
  const { file } = parsed;
  try {
    await deps.repository.save(STORAGE_KEYS.tasks, file.tasks);
    await deps.repository.save(STORAGE_KEYS.sessions, file.sessions);
    await deps.repository.save(STORAGE_KEYS.signals, file.signals);
    await deps.repository.save(STORAGE_KEYS.settings, file.settings);
    await deps.repository.remove(STORAGE_KEYS.backupPreImport); // last, deliberately
  } catch (writeError) {
    try {
      await deps.repository.save(STORAGE_KEYS.tasks, preImport.tasks);
      await deps.repository.save(STORAGE_KEYS.sessions, preImport.sessions);
      await deps.repository.save(STORAGE_KEYS.signals, preImport.signals);
      await deps.repository.save(STORAGE_KEYS.settings, preImport.settings);
      await deps.repository.remove(STORAGE_KEYS.backupPreImport);
    } catch {
      // the marker stays and hydrate restores from it next launch
    }
    await resyncNotifications(deps);
    throw writeError;
  }

  deps.taskStore.setState({ tasks: file.tasks });
  deps.sessionStore.setState({ sessions: file.sessions, activeSession: null });
  deps.schedulingStore.setState({ signals: file.signals });
  deps.settingsStore.setState({ ...file.settings });

  await resyncNotifications(deps);

  return { ok: true, counts: { tasks: file.tasks.length, sessions: file.sessions.length } };
}

async function resyncNotifications(deps: ImportDataDeps): Promise<void> {
  try {
    deps.notificationStore.getState().syncNotifications();
    await deps.notificationStore.getState().flushNotifications();
  } catch {
    // a notification failure must not change the import's outcome
  }
}
