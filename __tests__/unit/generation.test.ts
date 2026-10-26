import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cancel,
  generateBreakdown,
  generateExtraction,
  generateSimplification,
  getModelStatus,
  installModelRuntime,
  isCancellation,
  onStatusChange,
  type ModelRuntime,
} from '@/services/generation';
import { GenerationCancelled } from '@/services/generationPipeline';
import { SYSTEM_BREAKDOWN } from '@/services/prompt';
import { forTask } from '@/services/templates';
import { createGenerationStore } from '@/store/generationStore';
import type { BreakdownInput, ModelStatus } from '@/types';

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

afterEach(() => {
  installModelRuntime(null);
});

describe('with no runtime installed', () => {
  it('reports unsupported rather than pretending to be loading', () => {
    installModelRuntime(null);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'unsupported' });
  });

  it('still answers every request, using templates', async () => {
    installModelRuntime(null);

    const breakdown = await generateBreakdown(TASK);
    expect(breakdown.tier).toBe('template');
    expect(breakdown.breakdown).toEqual(forTask(TASK));

    const simplify = await generateSimplification({ title: TASK.title, description: null });
    expect(simplify.tier).toBe('template');

    const extraction = await generateExtraction('Essay due Friday.');
    expect(extraction.tier).toBe('template');
    expect(extraction.extraction.tasks).toEqual([]);
  });
});

describe('with a working runtime', () => {
  it('loads lazily on the first request, not at install', async () => {
    const model = runtime();
    installModelRuntime(model);

    // lazy so cold start stays inside its budget
    expect(model.load).not.toHaveBeenCalled();

    await generateBreakdown(TASK);
    expect(model.load).toHaveBeenCalledTimes(1);
  });

  it('loads once across many requests', async () => {
    const model = runtime();
    installModelRuntime(model);

    await generateBreakdown(TASK);
    await generateBreakdown(TASK);
    await generateSimplification({ title: 'Anything', description: null });

    expect(model.load).toHaveBeenCalledTimes(1);
  });

  it('returns model output as the model tier', async () => {
    installModelRuntime(runtime());
    const result = await generateBreakdown(TASK);

    expect(result.tier).toBe('model');
    expect(result.breakdown.steps).toHaveLength(3);
  });
});

describe('permanent failure', () => {
  it('does not retry loading for the rest of the session', async () => {
    const load = vi.fn<ModelRuntime['load']>().mockRejectedValue(new Error('could not open model'));
    const model = runtime({ load });
    installModelRuntime(model);

    const first = await generateBreakdown(TASK);
    const second = await generateBreakdown(TASK);
    const third = await generateSimplification({ title: 'Anything', description: null });

    expect(first.tier).toBe('template');
    expect(second.tier).toBe('template');
    expect(third.tier).toBe('template');
    // retrying every request would spend battery rediscovering the same answer
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reports load_error and never calls generate', async () => {
    const model = runtime({
      load: vi.fn<ModelRuntime['load']>().mockRejectedValue(new Error('could not open model')),
    });
    installModelRuntime(model);

    await generateBreakdown(TASK);

    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'load_error' });
    expect(model.generate).not.toHaveBeenCalled();
  });

  it('distinguishes out of memory, which section 7 handles differently', async () => {
    installModelRuntime(
      runtime({
        load: vi.fn<ModelRuntime['load']>().mockRejectedValue(new Error('Metal out of memory')),
      }),
    );

    await generateBreakdown(TASK);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'out_of_memory' });
  });

  it('is cleared by installing a runtime again', async () => {
    installModelRuntime(
      runtime({ load: vi.fn<ModelRuntime['load']>().mockRejectedValue(new Error('nope')) }),
    );
    await generateBreakdown(TASK);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'load_error' });

    installModelRuntime(runtime());
    expect(getModelStatus()).toEqual({ state: 'ready' });
    await expect(generateBreakdown(TASK)).resolves.toMatchObject({ tier: 'model' });
  });
});

describe('onStatusChange', () => {
  it('lets a subscribed store learn about a load failure that happens after init, not just at install', async () => {
    // regression: a load failure found after init never reached the store, so
    // /settings/model stayed on "loading" forever
    const store = createGenerationStore();
    store.getState().setStatus(getModelStatus());
    const unsubscribe = onStatusChange((status) => store.getState().setStatus(status));

    expect(store.getState().status).toEqual({ state: 'failed', reason: 'unsupported' });

    const load = vi.fn<ModelRuntime['load']>().mockRejectedValue(new Error('could not open model'));
    installModelRuntime(runtime({ load }));

    await generateBreakdown(TASK);

    expect(store.getState().status).toEqual({ state: 'failed', reason: 'load_error' });

    unsubscribe();
  });
});

describe('a generation that fails after loading', () => {
  it('falls back to a template but leaves the model usable', async () => {
    const generate = vi
      .fn<ModelRuntime['generate']>()
      .mockRejectedValueOnce(new Error('decode failed'))
      .mockResolvedValue(VALID);
    installModelRuntime(runtime({ generate }));

    const first = await generateBreakdown(TASK);
    expect(first.tier).toBe('template');

    const second = await generateBreakdown(TASK);
    expect(second.tier).toBe('model');
    expect(getModelStatus()).toEqual({ state: 'ready' });
  });
});

describe('cancel', () => {
  it('rejects the in-flight request as a cancellation, not a template', async () => {
    const generate = vi
      .fn<ModelRuntime['generate']>()
      .mockImplementation((_prompt, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new GenerationCancelled()));
        }),
      );
    installModelRuntime(runtime({ generate }));

    const pending = generateBreakdown(TASK);
    cancel();

    await expect(pending).rejects.toSatisfy(isCancellation);
  });

  it('never asks the model for work cancelled while it was still loading', async () => {
    const model = runtime();
    installModelRuntime(model);

    const pending = generateBreakdown(TASK);
    cancel();
    await expect(pending).rejects.toSatisfy(isCancellation);

    // the load is where a user gives up, so cancelling there must not go on to generate
    expect(model.load).toHaveBeenCalledTimes(1);
    expect(model.generate).not.toHaveBeenCalled();
  });

  it('leaves the module usable for the next request', async () => {
    installModelRuntime(runtime());
    cancel();
    await expect(generateBreakdown(TASK)).resolves.toMatchObject({ tier: 'model' });
  });
});

describe('cancel is scoped to one kind', () => {
  it('cancelling a breakdown does not abort an unrelated in-flight extraction', async () => {
    let releaseExtraction: (value: string) => void = () => {};
    const generate = vi.fn<ModelRuntime['generate']>().mockImplementation((prompt, signal) => {
      if (prompt.system === SYSTEM_BREAKDOWN) {
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new GenerationCancelled()));
        });
      }
      // held until the test releases it, so it is still in flight when the breakdown is cancelled
      return new Promise<string>((resolve) => {
        releaseExtraction = resolve;
      });
    });
    installModelRuntime(runtime({ generate }));

    const breakdownPending = generateBreakdown(TASK);
    const extractionPending = generateExtraction('Essay due Friday. Problem set Monday.');

    cancel('breakdown');

    await expect(breakdownPending).rejects.toSatisfy(isCancellation);

    // regression: the old shared controller aborted this one too
    releaseExtraction(JSON.stringify({ tasks: [] }));
    await expect(extractionPending).resolves.toMatchObject({ tier: 'model' });
  });
});

describe('a late result after cancellation', () => {
  it('is treated as a cancellation, not an answer, when the runtime ignores the signal', async () => {
    let resolveGenerate: (value: string) => void = () => {};
    const generate = vi
      .fn<ModelRuntime['generate']>()
      // ignores the abort on purpose, like a runtime that resolves late anyway
      .mockImplementation(() => new Promise<string>((resolve) => { resolveGenerate = resolve; }));
    installModelRuntime(runtime({ generate }));

    const pending = generateBreakdown(TASK);
    await vi.waitFor(() => expect(generate).toHaveBeenCalled());

    cancel();
    resolveGenerate(VALID);

    await expect(pending).rejects.toSatisfy(isCancellation);
  });
});

describe('out of memory raised during generate, not load', () => {
  it('unloads, classifies the failure, and stops calling the runtime for the rest of the session', async () => {
    const unload = vi.fn<() => void>();
    const generate = vi.fn<ModelRuntime['generate']>().mockRejectedValue(new Error('CUDA out of memory'));
    installModelRuntime(runtime({ generate, unload }));

    const first = await generateBreakdown(TASK);
    expect(first.tier).toBe('template');
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'out_of_memory' });
    expect(unload).toHaveBeenCalledTimes(1);

    const callsAfterFirst = generate.mock.calls.length;
    const second = await generateBreakdown(TASK);

    expect(second.tier).toBe('template');
    expect(generate.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does not unload or set a permanent failure for an ordinary generation error', async () => {
    const unload = vi.fn<() => void>();
    const generate = vi
      .fn<ModelRuntime['generate']>()
      .mockRejectedValueOnce(new Error('decode failed'))
      .mockResolvedValue(VALID);
    installModelRuntime(runtime({ generate, unload }));

    const first = await generateBreakdown(TASK);
    expect(first.tier).toBe('template');
    expect(unload).not.toHaveBeenCalled();
    expect(getModelStatus()).toEqual({ state: 'ready' });

    const second = await generateBreakdown(TASK);
    expect(second.tier).toBe('model');
  });

  it('tolerates a runtime with no unload method', async () => {
    const generate = vi.fn<ModelRuntime['generate']>().mockRejectedValue(new Error('out of memory'));
    installModelRuntime(runtime({ generate, unload: undefined }));

    const result = await generateBreakdown(TASK);
    expect(result.tier).toBe('template');
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'out_of_memory' });
  });
});

describe('out of memory raised during load', () => {
  it('unloads, classifies the failure, and stops calling the runtime for the rest of the session', async () => {
    const unload = vi.fn<() => void>();
    const load = vi.fn<ModelRuntime['load']>().mockRejectedValue(new Error('Metal out of memory'));
    const generate = vi.fn<ModelRuntime['generate']>();
    installModelRuntime(runtime({ load, generate, unload }));

    const first = await generateBreakdown(TASK);
    expect(first.tier).toBe('template');
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'out_of_memory' });
    // the model never answered a prompt but still needs releasing
    expect(unload).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();

    const callsAfterFirst = { load: load.mock.calls.length, generate: generate.mock.calls.length };
    const second = await generateBreakdown(TASK);

    expect(second.tier).toBe('template');
    expect(load.mock.calls.length).toBe(callsAfterFirst.load);
    expect(generate.mock.calls.length).toBe(callsAfterFirst.generate);
  });

  it('tolerates a runtime with no unload method', async () => {
    const load = vi.fn<ModelRuntime['load']>().mockRejectedValue(new Error('out of memory'));
    installModelRuntime(runtime({ load, unload: undefined }));

    const result = await generateBreakdown(TASK);
    expect(result.tier).toBe('template');
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'out_of_memory' });
  });
});

describe('RnExecutorchError.code classification', () => {
  // declared locally: generation.ts must classify runtime errors without importing the library
  class FakeRnExecutorchError extends Error {
    code: number;
    constructor(code: number, message = 'RnExecutorchError') {
      super(message);
      this.name = 'RnExecutorchError';
      this.code = code;
    }
  }

  it('classifies MemoryAllocationFailed (33) as out_of_memory from a message with no OOM wording', async () => {
    const load = vi.fn<ModelRuntime['load']>().mockRejectedValue(new FakeRnExecutorchError(33, 'native allocation failed'));
    installModelRuntime(runtime({ load }));

    await generateBreakdown(TASK);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'out_of_memory' });
  });

  it('classifies DelegateMemoryAllocationFailed (49) as out_of_memory', async () => {
    const load = vi.fn<ModelRuntime['load']>().mockRejectedValue(new FakeRnExecutorchError(49, 'backend init failed'));
    installModelRuntime(runtime({ load }));

    await generateBreakdown(TASK);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'out_of_memory' });
  });

  it('classifies an unrelated code, such as TokenizerError (122), as load_error', async () => {
    const load = vi.fn<ModelRuntime['load']>().mockRejectedValue(new FakeRnExecutorchError(122, 'tokenizer failed'));
    installModelRuntime(runtime({ load }));

    await generateBreakdown(TASK);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'load_error' });
  });

  it('classifies InvalidModelSource (120) as load_error', async () => {
    const load = vi.fn<ModelRuntime['load']>().mockRejectedValue(new FakeRnExecutorchError(120, 'invalid model source'));
    installModelRuntime(runtime({ load }));

    await generateBreakdown(TASK);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'load_error' });
  });

  it('still honours the string-message fallback for a coded error with OOM wording but an unrecognised code', async () => {
    const load = vi
      .fn<ModelRuntime['load']>()
      .mockRejectedValue(new FakeRnExecutorchError(101, 'ran out of memory'));
    installModelRuntime(runtime({ load }));

    await generateBreakdown(TASK);
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'out_of_memory' });
  });
});

describe('out-of-memory wording is matched on word boundaries', () => {
  it.each(['No room left in the context window', 'zoom level unsupported', 'bloom filter failed'])(
    'does not treat "%s" as out of memory',
    async (message) => {
      const unload = vi.fn<() => void>();
      const generate = vi.fn<ModelRuntime['generate']>().mockRejectedValue(new Error(message));
      installModelRuntime(runtime({ generate, unload }));

      await generateBreakdown(TASK);

      expect(unload).not.toHaveBeenCalled();
      expect(getModelStatus()).toEqual({ state: 'ready' });
    },
  );

  it.each(['OOM while allocating', 'oom', 'Out Of Memory'])('still treats "%s" as out of memory', async (message) => {
    const generate = vi.fn<ModelRuntime['generate']>().mockRejectedValue(new Error(message));
    installModelRuntime(runtime({ generate }));

    await generateBreakdown(TASK);

    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'out_of_memory' });
  });
});

describe('a request that arrives while the model is still loading', () => {
  it('waits for the load and gets the model, not a template', async () => {
    let finishLoad: () => void = () => {};
    let loaded = false;
    const load = vi.fn<ModelRuntime['load']>(
      () => new Promise<void>((resolve) => { finishLoad = () => { loaded = true; resolve(); }; }),
    );
    // like the real runtime, generating before the load resolves throws
    const generate = vi.fn<ModelRuntime['generate']>(async () => {
      if (!loaded) throw new Error('generate() called before load() resolved');
      return VALID;
    });
    const model = runtime({ load, generate });
    installModelRuntime(model);

    const first = generateBreakdown(TASK);
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    const second = generateBreakdown(TASK);
    finishLoad();

    expect((await first).tier).toBe('model');
    expect((await second).tier).toBe('model');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shares a failed load: both requests get templates and the failure is permanent', async () => {
    let failLoad: (error: Error) => void = () => {};
    const load = vi.fn<ModelRuntime['load']>(() => new Promise<void>((_, reject) => { failLoad = reject; }));
    const model = runtime({ load });
    installModelRuntime(model);

    const first = generateBreakdown(TASK);
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    const second = generateBreakdown(TASK);
    failLoad(new Error('could not open model'));

    expect((await first).tier).toBe('template');
    expect((await second).tier).toBe('template');
    expect(model.generate).not.toHaveBeenCalled();
    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'load_error' });
  });
});

describe('a runtime that reports a fatal failure after the fact', () => {
  it('becomes the permanent failure, notifies listeners, and stops further calls', async () => {
    let fatal: ((failure: { state: 'failed'; reason: 'load_error' }) => void) | null = null;
    const model = runtime({
      onFatal: (listener) => {
        fatal = listener;
      },
    });
    installModelRuntime(model);
    await generateBreakdown(TASK);
    const listener = vi.fn();
    const unsubscribe = onStatusChange(listener);

    fatal!({ state: 'failed', reason: 'load_error' });

    expect(getModelStatus()).toEqual({ state: 'failed', reason: 'load_error' });
    expect(listener).toHaveBeenCalledWith({ state: 'failed', reason: 'load_error' });
    const callsBefore = vi.mocked(model.generate).mock.calls.length;
    expect((await generateBreakdown(TASK)).tier).toBe('template');
    expect(vi.mocked(model.generate).mock.calls.length).toBe(callsBefore);
    unsubscribe();
  });

  it('is ignored once a different runtime is installed', () => {
    let fatal: ((failure: { state: 'failed'; reason: 'load_error' }) => void) | null = null;
    installModelRuntime(runtime({ onFatal: (listener) => { fatal = listener; } }));
    installModelRuntime(runtime());

    fatal!({ state: 'failed', reason: 'load_error' });

    expect(getModelStatus()).toEqual({ state: 'ready' });
  });
});
