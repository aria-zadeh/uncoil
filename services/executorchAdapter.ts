// the testable half of executorchRuntime.ts. node tests alias react-native-executorch to a module that
// throws on import, so this only knows the shape of an LLMModule (LLMHandle) and tests pass a fake
import { GenerationCancelled } from '@/services/generationPipeline';
import type { Prompt } from '@/services/prompt';

// only the methods we call, so a test fake implements exactly this
export interface LLMHandle {
  setTokenCallback(args: { tokenCallback: (token: string) => void }): void;
  getGeneratedTokenCount(): number;
  interrupt(): void;
  generate(messages: { role: 'system' | 'user' | 'assistant'; content: string }[]): Promise<string>;
  delete(): void;
}

// interrupt() throws ModuleNotLoaded when nothing is running. every caller just means "stop if you can"
export function safeInterrupt(model: LLMHandle): void {
  try {
    model.interrupt();
  } catch {
    // nothing to stop
  }
}

export interface InterruptWatchdog {
  // how long a call may stay unsettled after interrupt() before it counts as stuck
  afterMs: number;
  // at most once per generation
  onStuck: () => void;
}

// interrupt() can let one more token through, so the cap lands at or just past maxNewTokens.
// doesn't throw on cancel itself: makeRunner re-checks signal.aborted after every call
export async function boundedGenerate(
  model: LLMHandle,
  prompt: Prompt,
  maxNewTokens: number,
  signal?: AbortSignal,
  onToken?: (count: number) => void,
  watchdog?: InterruptWatchdog,
): Promise<string> {
  // a call that never settles after an interrupt would hold the model and its lock while status says
  // ready. the watchdog arms on the first interrupt only, never after settling: a late token must not flag a
  // finished call as stuck
  let settled = false;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const interrupt = (): void => {
    safeInterrupt(model);
    if (watchdog && !settled && watchdogTimer === null) {
      watchdogTimer = setTimeout(watchdog.onStuck, watchdog.afterMs);
    }
  };

  // getGeneratedTokenCount() reads 0 while streaming (react-native-executorch 0.9.3 only writes it when
  // generation ends), so count token callbacks for the live figure and keep the runner's count as a floor
  let emitted = 0;
  model.setTokenCallback({
    tokenCallback: () => {
      emitted += 1;
      const count = Math.max(emitted, model.getGeneratedTokenCount());
      onToken?.(count);
      if (count >= maxNewTokens) interrupt();
    },
  });

  const onAbort = (): void => interrupt();
  signal?.addEventListener('abort', onAbort);
  try {
    return await model.generate([
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ]);
  } finally {
    settled = true;
    if (watchdogTimer !== null) clearTimeout(watchdogTimer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// one generation at a time. a second generate() rejects with ModelGenerating and replaces the first
// call's token callback, losing its cap. an aborted waiter leaves the queue at once, and poison fails
// everyone queued behind a model that stopped responding
export interface GenerationLock {
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  poison(error: Error): void;
}

interface Waiter {
  start: () => void;
  fail: (error: Error) => void;
}

export function createGenerationLock(): GenerationLock {
  let held = false;
  let poisoned: Error | null = null;
  const waiters: Waiter[] = [];

  const release = (): void => {
    const next = waiters.shift();
    if (next) next.start();
    else held = false;
  };

  return {
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (poisoned) {
          reject(poisoned);
          return;
        }
        if (signal?.aborted) {
          reject(new GenerationCancelled());
          return;
        }

        const execute = (): void => {
          let pending: Promise<T>;
          try {
            pending = task();
          } catch (error) {
            pending = Promise.reject(error);
          }
          pending.then(resolve, reject).finally(release);
        };

        if (!held) {
          held = true;
          execute();
          return;
        }

        function onAbort(): void {
          const index = waiters.indexOf(waiter);
          if (index === -1) return;
          waiters.splice(index, 1);
          reject(new GenerationCancelled());
        }
        const waiter: Waiter = {
          start: () => {
            signal?.removeEventListener('abort', onAbort);
            execute();
          },
          fail: (error) => {
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        };
        waiters.push(waiter);
        signal?.addEventListener('abort', onAbort);
      });
    },
    poison(error: Error): void {
      poisoned = error;
      for (const waiter of waiters.splice(0)) waiter.fail(error);
    },
  };
}

// cleanup runs even if delete() throws (ModelGenerating mid-generation). the error still propagates,
// generation.ts decides whether a failed unload matters
export function unloadModel(model: LLMHandle | null, cleanup: () => void): void {
  try {
    model?.delete();
  } finally {
    cleanup();
  }
}

// the model is bundled, never fetched. tokenizer sources must be require()s, which metro resolves to
// numbers, but the library type also takes a url string, so a typo could silently start a download.
// checked at every use, not once
export function assertBundledSource(value: unknown, name: string): number {
  if (typeof value !== 'number') {
    throw new Error(
      `executorchRuntime: ${name} must be a bundled require() (resolves to a number), got ${typeof value}. Hard rule 1: nothing is fetched at runtime.`,
    );
  }
  return value;
}
