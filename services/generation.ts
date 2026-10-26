// the generation boundary screens and stores call. every generate* resolves: a failure here falls back to
// a template, it isn't an error. the runtime is injected (installModelRuntime) so executorchRuntime.ts
// stays the only importer of the library, and with none installed every call gets a template
import {
  GenerationCancelled,
  runBreakdown,
  runExtraction,
  runSimplification,
  withTimeout,
  isCancellation,
  TIMEOUT_MS,
  type PipelineDeps,
  type Runner,
} from '@/services/generationPipeline';
import type {
  BreakdownInput,
  BreakdownResult,
  ExtractionResult,
  ModelStatus,
  SimplifyInput,
  SimplifyResult,
} from '@/types';

// the one seam between this module and react-native-executorch
export interface ModelRuntime {
  // idempotent, held for the process lifetime once it resolves
  load: () => Promise<void>;
  generate: Runner;
  status: () => ModelStatus;
  // called on out of memory so the runtime can free what it can before templates take over
  unload?: () => void | Promise<void>;
  // the runtime reports a model that can no longer be used, e.g. a native call that never settled after
  // an interrupt. it becomes the session's permanent failure, like a failed load
  onFatal?: (listener: (failure: ModelFailure) => void) => void;
}

export type GenerationKind = 'breakdown' | 'extraction' | 'simplification';

let runtime: ModelRuntime | null = null;
// one load shared by every request, so a request arriving mid-load waits instead of getting a template
let loadPromise: Promise<void> | null = null;

// mirrors the generationOptOut setting. services can't import stores, so store/runtime.ts keeps it in sync
let generationEnabled = true;

// when disabled every request falls straight to its template without touching the runtime
export function setGenerationEnabled(enabled: boolean): void {
  if (generationEnabled === enabled) return;
  generationEnabled = enabled;
  notifyStatusChange();
}

export function isGenerationEnabled(): boolean {
  return generationEnabled;
}

export type ModelFailure = Extract<ModelStatus, { state: 'failed' }>;

// a failed load isn't retried this session, retrying on every keystroke burns battery for the same answer
let permanentFailure: ModelFailure | null = null;

export function installModelRuntime(next: ModelRuntime | null): void {
  runtime = next;
  loadPromise = null;
  permanentFailure = null;
  next?.onFatal?.((failure) => {
    // a runtime replaced since registering has no say over the current one
    if (runtime !== next) return;
    permanentFailure = failure;
    notifyStatusChange();
  });
}

export function getModelStatus(): ModelStatus {
  // disabled is a user choice and overrides everything. re-enabling reveals whatever was underneath,
  // past failures included
  if (!generationEnabled) return { state: 'failed', reason: 'disabled' };
  if (permanentFailure) return permanentFailure;
  if (!runtime) return { state: 'failed', reason: 'unsupported' };
  return runtime.status();
}

// a load can fail long after the store's first status read, so the store subscribes here instead of polling
type StatusListener = (status: ModelStatus) => void;
const statusListeners = new Set<StatusListener>();

export function onStatusChange(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function notifyStatusChange(): void {
  const status = getModelStatus();
  for (const listener of statusListeners) listener(status);
}

// the part of RnExecutorchError we need, without importing the library here
interface ErrorWithCode {
  code: number;
}

function hasErrorCode(error: unknown): error is ErrorWithCode {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'number'
  );
}

// out-of-memory RnExecutorchErrorCode values: MemoryAllocationFailed (33), DelegateMemoryAllocationFailed (49).
// executorchErrorCodes.test.ts checks them against the installed library's ErrorCodes.d.ts, read as text
export const OOM_ERROR_CODES: ReadonlySet<number> = new Set([33, 49]);

// oom gets its own handling (unload, then templates). the message check is for runtimes that aren't
// RnExecutorchError, like the mock
function isOutOfMemory(error: unknown): boolean {
  if (hasErrorCode(error) && OOM_ERROR_CODES.has(error.code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  // word-bounded, a bare substring matched "room" and "zoom"
  return /\bout of memory\b|\boom\b/i.test(message);
}

function classifyLoadFailure(error: unknown): ModelFailure {
  return isOutOfMemory(error)
    ? { state: 'failed', reason: 'out_of_memory' }
    : { state: 'failed', reason: 'load_error' };
}

// best effort: a failed unload must not block the permanent-failure classification that follows it
async function unloadIfOutOfMemory(error: unknown): Promise<void> {
  if (!isOutOfMemory(error)) return;
  try {
    await runtime?.unload?.();
  } catch {
    // best effort
  }
}

// loads on first use, not at launch, to keep cold start fast. every failure is a rejection, and the
// pipeline turns a rejection into a template
function makeRunner(timeoutMs: number): Runner {
  const call: Runner = async (prompt, signal) => {
    // checked again after the load, the longest await and exactly where people give up and cancel
    if (signal?.aborted) throw new GenerationCancelled();
    // disabled means no load and no generate
    if (!generationEnabled) throw new Error('model unavailable: disabled');
    if (permanentFailure) throw new Error(`model unavailable: ${permanentFailure.reason}`);
    if (!runtime) throw new Error('model unavailable: unsupported');

    if (!loadPromise) {
      const loading = runtime;
      loadPromise = loading.load().then(
        () => {
          // success changes the status too (loading to ready). without this, settings would read
          // "Getting ready" for the rest of the session
          notifyStatusChange();
        },
        async (error: unknown) => {
          await unloadIfOutOfMemory(error);
          if (runtime === loading) {
            permanentFailure = classifyLoadFailure(error);
            notifyStatusChange();
          }
          throw error;
        },
      );
    }
    await loadPromise;

    if (signal?.aborted) throw new GenerationCancelled();

    let raw: string;
    try {
      raw = await runtime.generate(prompt, signal);
    } catch (error) {
      if (isOutOfMemory(error)) {
        // unlike an ordinary failure, oom means the model isn't safe to call again this session
        await unloadIfOutOfMemory(error);
        permanentFailure = { state: 'failed', reason: 'out_of_memory' };
        notifyStatusChange();
      }
      throw error;
    }

    // the runtime may resolve despite the abort. a cancelled request gets no result, not a late one
    if (signal?.aborted) throw new GenerationCancelled();
    return raw;
  };

  return withTimeout(call, timeoutMs);
}

// one controller per kind, so cancelling a breakdown never aborts an unrelated extraction
const controllers = new Map<GenerationKind, AbortController>([
  ['breakdown', new AbortController()],
  ['extraction', new AbortController()],
  ['simplification', new AbortController()],
]);

function controllerFor(kind: GenerationKind): AbortController {
  const existing = controllers.get(kind);
  if (existing) return existing;
  const created = new AbortController();
  controllers.set(kind, created);
  return created;
}

function deps(kind: GenerationKind, timeoutMs: number): PipelineDeps {
  return { run: makeRunner(timeoutMs), signal: controllerFor(kind).signal };
}

export function generateBreakdown(input: BreakdownInput): Promise<BreakdownResult> {
  return runBreakdown(deps('breakdown', TIMEOUT_MS.breakdown), input);
}

export function generateExtraction(text: string): Promise<ExtractionResult> {
  return runExtraction(deps('extraction', TIMEOUT_MS.extraction), text);
}

export function generateSimplification(input: SimplifyInput): Promise<SimplifyResult> {
  return runSimplification(deps('simplification', TIMEOUT_MS.simplification), input);
}

// the in-flight promise rejects with a cancellation the caller swallows via isCancellation.
// no kind cancels everything
export function cancel(kind?: GenerationKind): void {
  if (kind) {
    controllers.get(kind)?.abort();
    controllers.set(kind, new AbortController());
    return;
  }
  for (const [k, c] of controllers) {
    c.abort();
    controllers.set(k, new AbortController());
  }
}

export { isCancellation };
