import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryRepository } from '@/data/memoryRepository';
import { DEFAULT_SETTINGS } from '@/data/migrations';
import { WriteQueue } from '@/data/writeQueue';
import {
  generateBreakdown,
  getModelStatus,
  installModelRuntime,
  isGenerationEnabled,
  setGenerationEnabled,
  type ModelRuntime,
} from '@/services/generation';
import { forTask } from '@/services/templates';
import { createSettingsStore } from '@/store/settingsStore';
import type { BreakdownInput, ModelStatus } from '@/types';

// store/runtime.ts cannot load in Node, so its opt-out subscription is mirrored below

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

function runtime(overrides: Partial<ModelRuntime> = {}): ModelRuntime {
  return {
    load: vi.fn<ModelRuntime['load']>().mockResolvedValue(undefined),
    generate: vi.fn<ModelRuntime['generate']>().mockResolvedValue(VALID),
    status: (): ModelStatus => ({ state: 'ready' }),
    ...overrides,
  };
}

function buildSettingsStore(initialOptOut: boolean) {
  const repository = new MemoryRepository();
  const queue = new WriteQueue(repository, { debounceMs: 0 });
  return createSettingsStore(
    { queue, now: () => new Date().toISOString(), newId: () => 'id-0' },
    { ...DEFAULT_SETTINGS, generationOptOut: initialOptOut },
  );
}

// same wiring as initializeStores() in store/runtime.ts
function wireGenerationEnabled(settings: ReturnType<typeof buildSettingsStore>): () => void {
  setGenerationEnabled(!settings.getState().generationOptOut);
  return settings.subscribe((state, prevState) => {
    if (state.generationOptOut !== prevState.generationOptOut) {
      setGenerationEnabled(!state.generationOptOut);
    }
  });
}

afterEach(() => {
  installModelRuntime(null);
  setGenerationEnabled(true);
});

describe('setGenerationEnabled(false)', () => {
  it('returns the template without loading or calling the runtime', async () => {
    const model = runtime();
    installModelRuntime(model);
    setGenerationEnabled(false);

    const result = await generateBreakdown(TASK);

    expect(result.tier).toBe('template');
    expect(result.breakdown).toEqual(forTask(TASK));
    expect(model.load).not.toHaveBeenCalled();
    expect(model.generate).not.toHaveBeenCalled();
  });

  it('does not touch a runtime that never loaded, even across repeated requests', async () => {
    const model = runtime();
    installModelRuntime(model);
    setGenerationEnabled(false);

    await generateBreakdown(TASK);
    await generateBreakdown(TASK);

    expect(model.load).not.toHaveBeenCalled();
  });
});

describe('setGenerationEnabled(true) after being off', () => {
  it('uses the runtime again on the next request', async () => {
    const model = runtime();
    installModelRuntime(model);
    setGenerationEnabled(false);

    const disabled = await generateBreakdown(TASK);
    expect(disabled.tier).toBe('template');

    setGenerationEnabled(true);

    const enabled = await generateBreakdown(TASK);
    expect(enabled.tier).toBe('model');
    expect(model.load).toHaveBeenCalledTimes(1);
  });
});

describe('getModelStatus / isGenerationEnabled', () => {
  it('reports disabled regardless of the underlying runtime state', () => {
    installModelRuntime(runtime());
    expect(isGenerationEnabled()).toBe(true);
    expect(getModelStatus()).toEqual({ state: 'ready' });

    setGenerationEnabled(false);

    expect(isGenerationEnabled()).toBe(false);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'disabled' });
  });

  it('reports disabled even with no runtime installed at all', () => {
    installModelRuntime(null);
    setGenerationEnabled(false);

    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'disabled' });
  });

  it('reveals whatever status was underneath once re-enabled', async () => {
    const load = vi.fn<ModelRuntime['load']>().mockRejectedValue(new Error('could not open model'));
    installModelRuntime(runtime({ load }));

    await generateBreakdown(TASK);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'load_error' });

    setGenerationEnabled(false);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'disabled' });

    setGenerationEnabled(true);
    // re-enabling does not retry a load that already failed
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'load_error' });
  });

  it('is a no-op, including no redundant status notification, when set to its current value', () => {
    installModelRuntime(runtime());
    setGenerationEnabled(true); // already true
    expect(getModelStatus()).toEqual({ state: 'ready' });
  });
});

describe('wired to store/settingsStore.ts, the way store/runtime.ts wires it', () => {
  it('takes effect immediately from the hydrated value, before any change event', async () => {
    const settings = buildSettingsStore(true);
    const unsubscribe = wireGenerationEnabled(settings);

    installModelRuntime(runtime());
    const result = await generateBreakdown(TASK);

    expect(result.tier).toBe('template');
    unsubscribe();
  });

  it('flips generation off the moment updateSetting flips generationOptOut on', async () => {
    const settings = buildSettingsStore(false);
    const unsubscribe = wireGenerationEnabled(settings);
    const model = runtime();
    installModelRuntime(model);

    expect((await generateBreakdown(TASK)).tier).toBe('model');

    settings.getState().updateSetting('generationOptOut', true);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'disabled' });

    const afterOptOut = await generateBreakdown(TASK);
    expect(afterOptOut.tier).toBe('template');
    expect(model.load).toHaveBeenCalledTimes(1); // only the earlier, enabled call

    unsubscribe();
  });

  it('flips generation back on the moment updateSetting flips generationOptOut off', async () => {
    const settings = buildSettingsStore(true);
    const unsubscribe = wireGenerationEnabled(settings);
    installModelRuntime(runtime());

    expect((await generateBreakdown(TASK)).tier).toBe('template');

    settings.getState().updateSetting('generationOptOut', false);
    const result = await generateBreakdown(TASK);

    expect(result.tier).toBe('model');
    unsubscribe();
  });

  it('does not re-notify on an unrelated setting change', async () => {
    const settings = buildSettingsStore(false);
    const unsubscribe = wireGenerationEnabled(settings);
    installModelRuntime(runtime());

    settings.getState().updateSetting('displayName', 'Sam');

    expect(isGenerationEnabled()).toBe(true);
    unsubscribe();
  });
});
