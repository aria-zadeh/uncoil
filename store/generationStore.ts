// not persisted, the model loads again every launch anyway. services/generation.ts drives
// this store, so it never imports that service or the model runtime
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { GenerationTier, ModelStatus } from '@/types';

export interface GenerationState {
  status: ModelStatus;
  tier: GenerationTier;
  // kept apart from status so it can still be shown after a later success
  lastFailureReason: string | null;

  setStatus: (status: ModelStatus) => void;
  setTier: (tier: GenerationTier) => void;
  recordFailure: (reason: string) => void;
  clearFailure: () => void;
}

export function createGenerationStore(): StoreApi<GenerationState> {
  return createStore<GenerationState>()((set) => ({
    status: { state: 'loading' },
    tier: 'model',
    lastFailureReason: null,

    setStatus: (status) => set({ status }),
    setTier: (tier) => set({ tier }),
    recordFailure: (reason) => set({ lastFailureReason: reason }),
    clearFailure: () => set({ lastFailureReason: null }),
  }));
}
