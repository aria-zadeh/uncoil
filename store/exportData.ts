// writeAndShare is injected because the real one needs expo modules that are stubbed in node tests
import { buildBackup, serializeBackup } from '@/services/backup';
import type { SchedulingState } from '@/store/schedulingStore';
import type { SessionState } from '@/store/sessionStore';
import { toUserSettings, type SettingsState } from '@/store/settingsStore';
import type { TaskState } from '@/store/taskStore';

interface MinimalStoreApi<T> {
  getState: () => T;
}

export interface ExportDataDeps {
  taskStore: MinimalStoreApi<TaskState>;
  settingsStore: MinimalStoreApi<SettingsState>;
  sessionStore: MinimalStoreApi<SessionState>;
  schedulingStore: MinimalStoreApi<SchedulingState>;
  currentSchemaVersion: number;
  now: () => Date;
  writeAndShare: (text: string, fileName: string) => Promise<void>;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function backupFileName(now: Date): string {
  return `uncoil-backup-${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.json`;
}

export async function exportAllData(deps: ExportDataDeps): Promise<void> {
  const now = deps.now();
  const file = buildBackup({
    tasks: deps.taskStore.getState().tasks,
    sessions: deps.sessionStore.getState().sessions,
    signals: deps.schedulingStore.getState().signals,
    settings: toUserSettings(deps.settingsStore.getState()),
    schemaVersion: deps.currentSchemaVersion,
    now,
  });
  await deps.writeAndShare(serializeBackup(file), backupFileName(now));
}
