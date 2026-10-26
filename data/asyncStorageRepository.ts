// the only module in the app that imports AsyncStorage
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { StorageKey } from '@/data/keys';
import type { Repository } from '@/data/repository';

export class AsyncStorageRepository implements Repository {
  async load<T>(key: StorageKey): Promise<T | null> {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // corrupt value reads as absent so the app still starts. the pre-migration
      // backup is what protects real data
      return null;
    }
  }

  async save<T>(key: StorageKey, value: T): Promise<void> {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  }

  async remove(key: StorageKey): Promise<void> {
    await AsyncStorage.removeItem(key);
  }

  async keys(): Promise<StorageKey[]> {
    const all = await AsyncStorage.getAllKeys();
    return all.filter((k) => k.startsWith('tether') || k.startsWith('dandelion')) as StorageKey[];
  }
}
