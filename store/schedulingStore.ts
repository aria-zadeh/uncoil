// whether tasks got done at their scheduled times. feeds slot scoring. nothing derived from
// signals is stored, insights compute it on read
import { createStore, type StoreApi } from 'zustand/vanilla';

import { STORAGE_KEYS } from '@/data/keys';
import type { WriteQueue } from '@/data/writeQueue';
import type { SchedulingSignal } from '@/types';

export interface StoreDeps {
  queue: WriteQueue;
  // ISO 8601
  now: () => string;
  // UUID v4
  newId: () => string;
}

export type NewSignalInput = Omit<SchedulingSignal, 'id' | 'recordedAt'>;

export interface SchedulingState {
  signals: SchedulingSignal[];

  addSignal: (input: NewSignalInput) => void;
  // called when a task is deleted. the signal is history, so only its task link is cleared
  orphanSignalsForTask: (taskId: string) => void;
}

export function createSchedulingStore(
  deps: StoreDeps,
  initial: SchedulingSignal[],
): StoreApi<SchedulingState> {
  return createStore<SchedulingState>()((set, get) => {
    const persist = (): void => deps.queue.queue(STORAGE_KEYS.signals, get().signals);

    return {
      signals: initial,

      addSignal: (input) => {
        // review-yesterday and a focus session ending can both record the same slot. a signal
        // only has day and hour, so a second one for the same task and slot would double-count
        if (
          input.taskId !== null &&
          get().signals.some(
            (s) =>
              s.taskId === input.taskId &&
              s.dayOfWeek === input.dayOfWeek &&
              s.hourOfDay === input.hourOfDay,
          )
        ) {
          return;
        }
        const signal: SchedulingSignal = { ...input, id: deps.newId(), recordedAt: deps.now() };
        set((state) => ({ signals: [...state.signals, signal] }));
        persist();
      },

      orphanSignalsForTask: (taskId) => {
        set((state) => ({
          signals: state.signals.map((s) => (s.taskId === taskId ? { ...s, taskId: null } : s)),
        }));
        persist();
      },
    };
  });
}
