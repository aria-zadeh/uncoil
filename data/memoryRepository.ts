// stores JSON strings like AsyncStorage does, so a value that can't round-trip
// fails in tests instead of on device
import type { StorageKey } from '@/data/keys';
import type { Repository } from '@/data/repository';

export interface MemoryRepositoryOptions {
  // already-serialized JSON strings
  initial?: Record<string, string>;
  failWrites?: boolean;
}

export class MemoryRepository implements Repository {
  private store = new Map<string, string>();

  // every saved key in order, so tests can check writes were coalesced
  readonly writeLog: StorageKey[] = [];

  failWrites: boolean;

  constructor(options: MemoryRepositoryOptions = {}) {
    for (const [k, v] of Object.entries(options.initial ?? {})) this.store.set(k, v);
    this.failWrites = options.failWrites ?? false;
  }

  async load<T>(key: StorageKey): Promise<T | null> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return JSON.parse(raw) as T;
  }

  async save<T>(key: StorageKey, value: T): Promise<void> {
    if (this.failWrites) throw new Error(`MemoryRepository: write to ${key} rejected`);
    this.writeLog.push(key);
    this.store.set(key, JSON.stringify(value));
  }

  async remove(key: StorageKey): Promise<void> {
    this.store.set(key, '');
    this.store.delete(key);
  }

  async keys(): Promise<StorageKey[]> {
    return [...this.store.keys()] as StorageKey[];
  }

  raw(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}
