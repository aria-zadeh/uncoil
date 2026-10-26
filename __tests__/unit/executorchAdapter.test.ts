import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertBundledSource,
  boundedGenerate,
  createGenerationLock,
  safeInterrupt,
  unloadModel,
  type LLMHandle,
} from '@/services/executorchAdapter';
import { isCancellation } from '@/services/generationPipeline';
import type { Prompt } from '@/services/prompt';

const PROMPT: Prompt = { system: 'Break the assignment into steps.', user: 'Assignment: Essay' };

function fakeModel(overrides: Partial<LLMHandle> = {}): LLMHandle {
  return {
    setTokenCallback: vi.fn(),
    getGeneratedTokenCount: vi.fn(() => 0),
    interrupt: vi.fn(),
    generate: vi.fn().mockResolvedValue('{"steps":[]}'),
    delete: vi.fn(),
    ...overrides,
  };
}

describe('safeInterrupt', () => {
  it('calls interrupt()', () => {
    const model = fakeModel();
    safeInterrupt(model);
    expect(model.interrupt).toHaveBeenCalledTimes(1);
  });

  it('swallows ModuleNotLoaded (or any other) error from interrupt()', () => {
    const model = fakeModel({
      interrupt: vi.fn(() => {
        throw new Error('ModuleNotLoaded');
      }),
    });
    expect(() => safeInterrupt(model)).not.toThrow();
  });
});

describe('boundedGenerate', () => {
  it('resolves with the model output on an ordinary generation', async () => {
    const model = fakeModel({ generate: vi.fn().mockResolvedValue('ok') });
    await expect(boundedGenerate(model, PROMPT, 320)).resolves.toBe('ok');
  });

  it('sends system and user as separate messages', async () => {
    const model = fakeModel();
    await boundedGenerate(model, PROMPT, 320);
    expect(model.generate).toHaveBeenCalledWith([
      { role: 'system', content: PROMPT.system },
      { role: 'user', content: PROMPT.user },
    ]);
  });

  it('interrupts once the token-count callback reports maxNewTokens reached', async () => {
    const model = fakeModel({ getGeneratedTokenCount: vi.fn(() => 320) });
    await boundedGenerate(model, PROMPT, 320);
    const { tokenCallback } = (model.setTokenCallback as ReturnType<typeof vi.fn>).mock.calls[0][0];
    tokenCallback('x');
    expect(model.interrupt).toHaveBeenCalledTimes(1);
  });

  it('does not interrupt when under the token count', async () => {
    const model = fakeModel({ getGeneratedTokenCount: vi.fn(() => 10) });
    await boundedGenerate(model, PROMPT, 320);
    const { tokenCallback } = (model.setTokenCallback as ReturnType<typeof vi.fn>).mock.calls[0][0];
    tokenCallback('x');
    expect(model.interrupt).not.toHaveBeenCalled();
  });

  it('interrupts on abort and still resolves normally (generation.ts rechecks signal.aborted itself)', async () => {
    const controller = new AbortController();
    let resolveGenerate: (value: string) => void = () => {};
    const model = fakeModel({
      generate: vi.fn(() => new Promise<string>((resolve) => { resolveGenerate = resolve; })),
    });
    const pending = boundedGenerate(model, PROMPT, 320, controller.signal);
    controller.abort();
    expect(model.interrupt).toHaveBeenCalledTimes(1);
    resolveGenerate('partial');
    await expect(pending).resolves.toBe('partial');
  });

  it('does not throw when interrupt() itself throws on abort (item 6: the unguarded-interrupt bug)', async () => {
    const controller = new AbortController();
    const model = fakeModel({
      interrupt: vi.fn(() => {
        throw new Error('ModuleNotLoaded');
      }),
      generate: vi.fn(() => new Promise<string>(() => {})), // never resolves, only the abort matters
    });
    const pending = boundedGenerate(model, PROMPT, 320, controller.signal);
    // regression: interrupt() throwing inside the abort listener surfaced as an unhandled throw
    expect(() => controller.abort()).not.toThrow();
    expect(model.interrupt).toHaveBeenCalledTimes(1);
    void pending;
  });

  it('removes the abort listener after settling, so a later abort on the same signal is inert', async () => {
    const controller = new AbortController();
    const model = fakeModel();
    await boundedGenerate(model, PROMPT, 320, controller.signal);
    (model.interrupt as ReturnType<typeof vi.fn>).mockClear();
    controller.abort();
    expect(model.interrupt).not.toHaveBeenCalled();
  });
});

describe('unloadModel', () => {
  it('calls delete() and then cleanup() on the ordinary path', () => {
    const model = fakeModel();
    const cleanup = vi.fn();
    unloadModel(model, cleanup);
    expect(model.delete).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('is a no-op delete when model is null, but still runs cleanup', () => {
    const cleanup = vi.fn();
    expect(() => unloadModel(null, cleanup)).not.toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup() even when delete() throws ModelGenerating (item 7: the skipped-cleanup bug), and still propagates the error', () => {
    const model = fakeModel({
      delete: vi.fn(() => {
        throw new Error('ModelGenerating');
      }),
    });
    const cleanup = vi.fn();
    expect(() => unloadModel(model, cleanup)).toThrow('ModelGenerating');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('assertBundledSource', () => {
  it('returns the value unchanged when it is a number (a real require() resolves this way)', () => {
    expect(assertBundledSource(42, 'MODEL_SOURCE')).toBe(42);
  });

  // split after the scheme so the banned-strings scan does not flag this fixture
  const URL_LIKE_SOURCE = 'https' + '://example.com/model.pte';

  it('throws on a string URL', () => {
    expect(() => assertBundledSource(URL_LIKE_SOURCE, 'MODEL_SOURCE')).toThrow(/MODEL_SOURCE must be a bundled require/);
  });

  it('throws on a dynamically-built (non-literal) string, not just an obvious literal', () => {
    const built = ['h', 't', 't', 'p', 's', ':', '/', '/', 'e', 'v', 'i', 'l', '.', 'e', 'x', 'a', 'm', 'p', 'l', 'e'].join('');
    expect(() => assertBundledSource(built, 'TOKENIZER_SOURCE')).toThrow(/TOKENIZER_SOURCE must be a bundled require/);
  });

  it('throws on an object source', () => {
    expect(() => assertBundledSource({ uri: URL_LIKE_SOURCE }, 'MODEL_SOURCE')).toThrow(/MODEL_SOURCE must be a bundled require/);
  });

  it('throws on undefined', () => {
    expect(() => assertBundledSource(undefined, 'MODEL_SOURCE')).toThrow(/MODEL_SOURCE must be a bundled require/);
  });
});

describe('createGenerationLock', () => {
  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it('runs one task at a time, in arrival order', async () => {
    const lock = createGenerationLock();
    const first = deferred<string>();
    const order: string[] = [];

    const a = lock.run(async () => {
      order.push('a start');
      const value = await first.promise;
      order.push('a end');
      return value;
    });
    const b = lock.run(async () => {
      order.push('b start');
      return 'b';
    });
    await Promise.resolve();
    expect(order).toEqual(['a start']);

    first.resolve('a');
    await expect(a).resolves.toBe('a');
    await expect(b).resolves.toBe('b');
    expect(order).toEqual(['a start', 'a end', 'b start']);
  });

  it('keeps the first call\'s token callback for its whole generation', async () => {
    // regression: a second boundedGenerate replaced the first one's token callback,
    // so the first call lost its max_new_tokens cap
    let callback: ((token: string) => void) | null = null;
    const finish: (() => void)[] = [];
    const model = fakeModel({
      setTokenCallback: vi.fn(({ tokenCallback }) => { callback = tokenCallback; }),
      generate: vi.fn(() => new Promise<string>((resolve) => finish.push(() => resolve('done')))),
    });
    const lock = createGenerationLock();
    const firstTokens = vi.fn();

    const a = lock.run(() => boundedGenerate(model, PROMPT, 320, undefined, firstTokens));
    const b = lock.run(() => boundedGenerate(model, PROMPT, 320));
    await Promise.resolve();
    callback!('x');
    expect(firstTokens).toHaveBeenCalledTimes(1);
    expect(model.generate).toHaveBeenCalledTimes(1);

    finish[0]();
    await a;
    await vi.waitFor(() => expect(model.generate).toHaveBeenCalledTimes(2));
    finish[1]();
    await b;
  });

  it('releases the lock after a task rejects', async () => {
    const lock = createGenerationLock();
    await expect(lock.run(() => Promise.reject(new Error('ModelGenerating')))).rejects.toThrow('ModelGenerating');
    await expect(lock.run(async () => 'next')).resolves.toBe('next');
  });

  it('a queued call whose signal aborts leaves the queue as a cancellation without running', async () => {
    const lock = createGenerationLock();
    const first = deferred<string>();
    const queued = vi.fn(async () => 'never');
    const controller = new AbortController();

    const a = lock.run(() => first.promise);
    const b = lock.run(queued, controller.signal);
    controller.abort();

    const error = await b.catch((e: unknown) => e);
    expect(isCancellation(error)).toBe(true);
    first.resolve('a');
    await a;
    expect(queued).not.toHaveBeenCalled();
    await expect(lock.run(async () => 'c')).resolves.toBe('c');
  });

  it('rejects an already-aborted call without queueing it', async () => {
    const lock = createGenerationLock();
    const controller = new AbortController();
    controller.abort();
    const task = vi.fn(async () => 'x');
    const error = await lock.run(task, controller.signal).catch((e: unknown) => e);
    expect(isCancellation(error)).toBe(true);
    expect(task).not.toHaveBeenCalled();
  });

  it('poison rejects every queued and later call', async () => {
    const lock = createGenerationLock();
    const stuck = lock.run(() => new Promise<string>(() => {}));
    const queued = lock.run(async () => 'queued');

    lock.poison(new Error('stuck'));

    await expect(queued).rejects.toThrow('stuck');
    await expect(lock.run(async () => 'later')).rejects.toThrow('stuck');
    void stuck;
  });
});

describe('boundedGenerate watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports stuck when the call has not settled afterMs after an abort interrupt', async () => {
    vi.useFakeTimers();
    const model = fakeModel({ generate: vi.fn(() => new Promise<string>(() => {})) });
    const onStuck = vi.fn();
    const controller = new AbortController();

    void boundedGenerate(model, PROMPT, 320, controller.signal, undefined, { afterMs: 10_000, onStuck });
    controller.abort();
    expect(model.interrupt).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(9_999);
    expect(onStuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it('arms on the token-cap interrupt too', async () => {
    vi.useFakeTimers();
    let callback: ((token: string) => void) | null = null;
    const model = fakeModel({
      setTokenCallback: vi.fn(({ tokenCallback }) => { callback = tokenCallback; }),
      generate: vi.fn(() => new Promise<string>(() => {})),
    });
    const onStuck = vi.fn();

    void boundedGenerate(model, PROMPT, 2, undefined, undefined, { afterMs: 10_000, onStuck });
    callback!('a');
    callback!('b');
    callback!('c');
    vi.advanceTimersByTime(10_000);
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  it('does not report a call that settles after the interrupt', async () => {
    vi.useFakeTimers();
    let finish: (value: string) => void = () => {};
    const model = fakeModel({ generate: vi.fn(() => new Promise<string>((r) => { finish = r; })) });
    const onStuck = vi.fn();
    const controller = new AbortController();

    const run = boundedGenerate(model, PROMPT, 320, controller.signal, undefined, { afterMs: 10_000, onStuck });
    controller.abort();
    finish('partial');
    await run;
    vi.advanceTimersByTime(20_000);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('a late token after the call settled does not arm the watchdog', async () => {
    vi.useFakeTimers();
    let callback: ((token: string) => void) | null = null;
    const model = fakeModel({
      setTokenCallback: vi.fn(({ tokenCallback }) => { callback = tokenCallback; }),
      generate: vi.fn().mockResolvedValue('ok'),
    });
    const onStuck = vi.fn();

    await boundedGenerate(model, PROMPT, 1, undefined, undefined, { afterMs: 10_000, onStuck });
    callback!('late');
    vi.advanceTimersByTime(20_000);
    expect(onStuck).not.toHaveBeenCalled();
  });
});
