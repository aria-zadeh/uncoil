// writes that ran out of retries land here so a screen can offer a retry. no UI reads it yet
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { StorageKey } from '@/data/keys';
import type { WriteFailure } from '@/data/writeQueue';

export interface WriteStatusState {
  // latest unrecovered failure per key, oldest first
  failures: readonly WriteFailure[];

  // replaces any earlier failure for the same key
  recordFailure: (failure: WriteFailure) => void;
  // clears each write that lands. never rejects
  retryAll: () => Promise<void>;
}

export function createWriteStatusStore(): StoreApi<WriteStatusState> {
  return createStore<WriteStatusState>()((set, get) => ({
    failures: [],

    recordFailure: (failure) => {
      set((state) => ({
        failures: [...state.failures.filter((f) => f.key !== failure.key), failure],
      }));
    },

    retryAll: async () => {
      const attempts = get().failures;
      const results = await Promise.allSettled(attempts.map((f) => f.retry()));
      const landed = new Set<StorageKey>();
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') landed.add(attempts[i].key);
      });
      // a newer failure for the same key, recorded mid-retry, stays
      set((state) => ({
        failures: state.failures.filter((f) => !(landed.has(f.key) && attempts.includes(f))),
      }));
    },
  }));
}
