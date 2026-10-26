// debounce and retry live in writeQueue.ts, so the in-memory repo the tests use
// goes through the same write path as the app
import type { StorageKey } from '@/data/keys';

export interface Repository {
  load<T>(key: StorageKey): Promise<T | null>;
  save<T>(key: StorageKey, value: T): Promise<void>;
  remove(key: StorageKey): Promise<void>;
  keys(): Promise<StorageKey[]>;
}

/** raw storage contents by key, legacy keys included */
export type StorageSnapshot = Readonly<Record<string, unknown>>;
