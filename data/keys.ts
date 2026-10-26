// versioned so a future v2 can be written beside v1 and migrated without a partial overwrite
export const STORAGE_KEYS = {
  tasks: 'tether:v1:tasks',
  sessions: 'tether:v1:sessions',
  signals: 'tether:v1:signals',
  settings: 'tether:v1:settings',
  meta: 'tether:v1:meta',
  backupPreMigration: 'tether:v1:backup-preMigration',
  backupPreImport: 'tether:v1:backup-preImport',
} as const;

export type CurrentStorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/** collections read at launch */
export const COLLECTION_KEYS = [
  STORAGE_KEYS.tasks,
  STORAGE_KEYS.sessions,
  STORAGE_KEYS.signals,
  STORAGE_KEYS.settings,
  STORAGE_KEYS.meta,
] as const;

// written by older installs through zustand persist. migration 1 reads them, never writes them
export const LEGACY_KEYS = {
  tasks: 'dandelion-tasks',
  settings: 'dandelion-settings',
  sessions: 'dandelion-sessions',
  scheduling: 'dandelion-scheduling',
  insights: 'dandelion-insights',
  lastReschedule: 'tether-last-reschedule',
} as const;

export type LegacyStorageKey = (typeof LEGACY_KEYS)[keyof typeof LEGACY_KEYS];

export const ALL_LEGACY_KEYS: LegacyStorageKey[] = Object.values(LEGACY_KEYS);

// legacy keys belong in the union because they really are in the store until migration 1 removes them
export type StorageKey = CurrentStorageKey | LegacyStorageKey;

export interface StorageMeta {
  schemaVersion: number;
  lastRescheduleAt: string | null;
  installedAt: string;
}
