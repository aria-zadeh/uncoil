import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  generateBreakdown,
  getModelStatus,
  installModelRuntime,
  onStatusChange,
  setGenerationEnabled,
  type ModelRuntime,
} from '@/services/generation';
import type { BreakdownInput, ModelStatus } from '@/types';

// regression: only a failed load notified, so Settings > Model stayed on "Getting ready"
// after a successful one even though getModelStatus() was already correct

const TASK: BreakdownInput = {
  title: 'Write a 5-paragraph essay on the reading',
  subject: 'English',
  description: null,
  duePhrase: 'in 3 days',
  sessionMinutes: 30,
};

const VALID = JSON.stringify({
  steps: [
    { title: 'Open the reading and go through it once', minutes: 10 },
    { title: 'Write down the three points to make', minutes: 10 },
    { title: 'Write the essay in one sitting', minutes: 30 },
  ],
  starterAction: 'Open the reading and go through it once',
});

afterEach(() => {
  installModelRuntime(null);
  setGenerationEnabled(true);
});

describe('makeRunner notifies onStatusChange after a successful load', () => {
  it('notifies listeners with the post-load ready status, and getModelStatus agrees', async () => {
    let loaded = false;
    const model: ModelRuntime = {
      load: vi.fn<ModelRuntime['load']>().mockImplementation(async () => {
        loaded = true;
      }),
      generate: vi.fn<ModelRuntime['generate']>().mockResolvedValue(VALID),
      status: (): ModelStatus => (loaded ? { state: 'ready' } : { state: 'loading' }),
    };
    installModelRuntime(model);

    const listener = vi.fn<(status: ModelStatus) => void>();
    const unsubscribe = onStatusChange(listener);

    const result = await generateBreakdown(TASK);

    expect(result.tier).toBe('model');
    expect(listener).toHaveBeenCalledWith({ state: 'ready' });
    expect(getModelStatus()).toEqual({ state: 'ready' });

    unsubscribe();
  });
});

describe('makeRunner still notifies onStatusChange after a failed load', () => {
  it('notifies listeners with the failed status (existing behavior, guarding the ordering)', async () => {
    const model: ModelRuntime = {
      load: vi.fn<ModelRuntime['load']>().mockRejectedValue(new Error('could not open model')),
      generate: vi.fn<ModelRuntime['generate']>().mockResolvedValue(VALID),
      status: (): ModelStatus => ({ state: 'loading' }),
    };
    installModelRuntime(model);

    const listener = vi.fn<(status: ModelStatus) => void>();
    const unsubscribe = onStatusChange(listener);

    const result = await generateBreakdown(TASK);

    expect(result.tier).toBe('template');
    expect(listener).toHaveBeenCalledWith({ state: 'failed', reason: 'load_error' });
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'load_error' });

    unsubscribe();
  });
});
