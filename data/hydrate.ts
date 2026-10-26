// AsyncStorage has no transactions, so a backup key still present at launch is the
// crash signal. restore from it, then delete it last so a crash mid-restore can retry
import {
  ALL_LEGACY_KEYS,
  COLLECTION_KEYS,
  STORAGE_KEYS,
  type StorageMeta,
} from '@/data/keys';
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS, readSchemaVersion, runMigrations } from '@/data/migrations';
import type { Repository, StorageSnapshot } from '@/data/repository';
import type { FocusSession, SchedulingSignal, Task, UserSettings } from '@/types';

export interface HydratedState {
  tasks: Task[];
  sessions: FocusSession[];
  signals: SchedulingSignal[];
  settings: UserSettings;
  meta: StorageMeta;
  // a previous launch died mid-migration or mid-import and was restored
  recoveredFromBackup: boolean;
  migrated: boolean;
}

function asArrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function readSnapshot(repository: Repository): Promise<Record<string, unknown>> {
  const keys = [...COLLECTION_KEYS, ...ALL_LEGACY_KEYS];
  const values = await Promise.all(keys.map((k) => repository.load<unknown>(k)));
  const snapshot: Record<string, unknown> = {};
  keys.forEach((k, i) => {
    if (values[i] !== null) snapshot[k] = values[i];
  });
  return snapshot;
}

async function writeCollections(repository: Repository, snapshot: StorageSnapshot): Promise<void> {
  await Promise.all(
    COLLECTION_KEYS.map((key) =>
      snapshot[key] === undefined ? Promise.resolve() : repository.save(key, snapshot[key]),
    ),
  );
}

// repeatDays was added without a schema bump, and the top-level defaults spread can't
// reach inside the stored events array. without this the first scheduler sweep throws
function normalizeSettings(settings: UserSettings): UserSettings {
  // runs before any screen exists, so a throw here would strand the app on the splash screen
  const events: unknown[] = Array.isArray(settings.calendarEvents) ? settings.calendarEvents : [];
  return {
    ...settings,
    calendarEvents: events
      .filter((event): event is UserSettings['calendarEvents'][number] => typeof event === 'object' && event !== null)
      .map((event) => (Array.isArray(event.repeatDays) ? event : { ...event, repeatDays: [] })),
  };
}

// import removes this backup only after every write lands, so finding it means an import
// died part-way. a marker too damaged to restore is dropped so it isn't rechecked every launch
async function restorePreImport(repository: Repository, marker: unknown): Promise<StorageSnapshot | null> {
  if (marker === null) return null;
  const m = marker as Record<string, unknown>;
  const restorable =
    typeof marker === 'object' &&
    !Array.isArray(marker) &&
    Array.isArray(m.tasks) &&
    Array.isArray(m.sessions) &&
    Array.isArray(m.signals) &&
    typeof m.settings === 'object' &&
    m.settings !== null &&
    !Array.isArray(m.settings);
  if (!restorable) {
    await repository.remove(STORAGE_KEYS.backupPreImport);
    return null;
  }
  const restored: StorageSnapshot = {
    [STORAGE_KEYS.tasks]: m.tasks,
    [STORAGE_KEYS.sessions]: m.sessions,
    [STORAGE_KEYS.signals]: m.signals,
    [STORAGE_KEYS.settings]: m.settings,
  };
  await writeCollections(repository, restored);
  await repository.remove(STORAGE_KEYS.backupPreImport); // last, deliberately
  return restored;
}

export async function hydrate(repository: Repository): Promise<HydratedState> {
  const [snapshot, backup, preImport] = await Promise.all([
    readSnapshot(repository),
    repository.load<StorageSnapshot>(STORAGE_KEYS.backupPreMigration),
    repository.load<unknown>(STORAGE_KEYS.backupPreImport),
  ]);

  // undo an interrupted import first so everything below sees the pre-import state
  const restoredFromImport = await restorePreImport(repository, preImport);
  let working: StorageSnapshot =
    restoredFromImport === null ? snapshot : { ...snapshot, ...restoredFromImport };
  let recoveredFromBackup = restoredFromImport !== null;

  if (backup !== null) {
    // a previous launch died mid-migration
    await writeCollections(repository, backup);
    await repository.remove(STORAGE_KEYS.backupPreMigration); // last, deliberately
    working = backup;
    recoveredFromBackup = true;
  }

  const version = readSchemaVersion(working);
  let migrated = false;

  // version 0 with current keys but no legacy ones is a wipe followed by new data whose
  // meta write never landed. migration 1 would read the missing legacy keys as empty and
  // overwrite the real collections, so only stamp meta
  const hasLegacyKeys = ALL_LEGACY_KEYS.some((k) => working[k] !== undefined);
  const hasCurrentCollectionKeys = COLLECTION_KEYS.some(
    (k) => k !== STORAGE_KEYS.meta && working[k] !== undefined,
  );

  if (version === 0 && !hasLegacyKeys && hasCurrentCollectionKeys) {
    const meta: StorageMeta = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      lastRescheduleAt: null,
      installedAt: new Date().toISOString(),
    };
    await repository.save(STORAGE_KEYS.meta, meta);
    working = { ...working, [STORAGE_KEYS.meta]: meta };
  } else if (version < CURRENT_SCHEMA_VERSION) {
    await repository.save(STORAGE_KEYS.backupPreMigration, working);
    const next = runMigrations(working, version);
    await writeCollections(repository, next);
    await Promise.all(ALL_LEGACY_KEYS.map((k) => repository.remove(k)));
    await repository.remove(STORAGE_KEYS.backupPreMigration); // last, deliberately
    working = next;
    migrated = true;
  }

  const storedSettings = working[STORAGE_KEYS.settings];
  const settings: UserSettings =
    storedSettings && typeof storedSettings === 'object'
      ? normalizeSettings({ ...DEFAULT_SETTINGS, ...(storedSettings as UserSettings) })
      : { ...DEFAULT_SETTINGS };

  const storedMeta = working[STORAGE_KEYS.meta];
  const meta: StorageMeta =
    storedMeta && typeof storedMeta === 'object'
      ? (storedMeta as StorageMeta)
      : { schemaVersion: CURRENT_SCHEMA_VERSION, lastRescheduleAt: null, installedAt: new Date(0).toISOString() };

  return {
    tasks: asArrayOf<Task>(working[STORAGE_KEYS.tasks]),
    sessions: asArrayOf<FocusSession>(working[STORAGE_KEYS.sessions]),
    signals: asArrayOf<SchedulingSignal>(working[STORAGE_KEYS.signals]),
    settings,
    meta,
    recoveredFromBackup,
    migrated,
  };
}
