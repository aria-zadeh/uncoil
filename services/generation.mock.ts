// scripted stand-in for the on-device model, for ui work and tests. drives the real pipeline with only
// the Runner swapped. imports nothing from react-native-executorch, so it's safe in node
import {
  GenerationCancelled,
  runBreakdown,
  runExtraction,
  runSimplification,
  type PipelineDeps,
  type Runner,
} from '@/services/generationPipeline';
import { SYSTEM_BREAKDOWN, SYSTEM_EXTRACTION, type Prompt } from '@/services/prompt';
import type {
  BreakdownInput,
  BreakdownResult,
  ExtractionResult,
  ModelStatus,
  SimplifyInput,
  SimplifyResult,
} from '@/types';

// one per branch of the failure ladder, so every state gets a screen built against it
export type MockBehavior =
  | 'valid'
  // invalid, then valid on repair. the user must never see any sign of the repair
  | 'repair'
  // invalid twice, falls back to a template and shows the notice
  | 'invalid'
  // falls back to a template without spending the repair
  | 'error'
  // only useful wrapped in withTimeout
  | 'hang'
  // the pipeline re-throws it
  | 'cancelled';

export interface MockOptions {
  behavior?: MockBehavior;
  // per model call, to make loading states visible. the repair path makes two calls
  delayMs?: number;
  status?: ModelStatus;
  // injected so tests need no real clock or waiting
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

// deliberately not the template output, so a screen can tell the two tiers apart.
// still passes the real validator, for the same reasons model output has to
function scriptedValid(prompt: Prompt): string {
  if (prompt.system === SYSTEM_BREAKDOWN) {
    return JSON.stringify({
      steps: [
        { title: 'Open the assignment and read it through once', minutes: 5 },
        { title: 'Write down the first thing it asks for', minutes: 10 },
        { title: 'Answer that first part without stopping', minutes: 20 },
        { title: 'Finish the parts that are left', minutes: 25 },
        { title: 'Read it back and fix what looks wrong', minutes: 10 },
      ],
      starterAction: 'Open the assignment and read it through once',
    });
  }

  if (prompt.system === SYSTEM_EXTRACTION) {
    // always two tasks, or the empty state would be the only one anyone saw
    return JSON.stringify({
      tasks: [
        { title: 'Reading response', dueInDays: 2, subject: 'English' },
        { title: 'Problem set', dueInDays: 5 },
      ],
    });
  }

  return JSON.stringify({
    title: 'Write about the reading in your own words',
    explanation:
      'The assignment wants you to say what the reading meant to you, using plain words rather than the ones in the prompt.',
  });
}

// valid json that fails the vague-verb check rather than parsing, the case repair exists for
const SCRIPTED_INVALID = JSON.stringify({
  steps: [
    { title: 'Plan the whole thing out first', minutes: 10 },
    { title: 'Think about what it needs', minutes: 10 },
    { title: 'Work on it until it is done', minutes: 30 },
  ],
  starterAction: 'Plan the whole thing out first',
});

export function createMockRunner(options: MockOptions = {}): Runner {
  const behavior = options.behavior ?? 'valid';
  const delayMs = options.delayMs ?? 0;
  const sleep = options.sleep ?? realSleep;
  let call = 0;

  return async (prompt: Prompt, signal?: AbortSignal): Promise<string> => {
    call += 1;
    await sleep(delayMs);

    if (signal?.aborted) throw new GenerationCancelled();

    switch (behavior) {
      case 'valid':
        return scriptedValid(prompt);
      case 'repair':
        return call === 1 ? SCRIPTED_INVALID : scriptedValid(prompt);
      case 'invalid':
        return SCRIPTED_INVALID;
      case 'error':
        throw new Error('mock runtime failure');
      case 'hang':
        return new Promise<string>(() => {});
      case 'cancelled':
        throw new GenerationCancelled();
    }
  };
}

export interface MockGeneration {
  getModelStatus: () => ModelStatus;
  generateBreakdown: (input: BreakdownInput) => Promise<BreakdownResult>;
  generateExtraction: (text: string) => Promise<ExtractionResult>;
  generateSimplification: (input: SimplifyInput) => Promise<SimplifyResult>;
  cancel: () => void;
  // a repair shows up as a second call
  callCount: () => number;
}

export function createMockGeneration(options: MockOptions = {}): MockGeneration {
  let calls = 0;
  const inner = createMockRunner(options);
  const run: Runner = (prompt, signal) => {
    calls += 1;
    return inner(prompt, signal);
  };

  let controller = new AbortController();
  const deps = (): PipelineDeps => ({ run, now: options.now, signal: controller.signal });

  return {
    getModelStatus: () => options.status ?? { state: 'ready' },
    generateBreakdown: (input) => runBreakdown(deps(), input),
    generateExtraction: (text) => runExtraction(deps(), text),
    generateSimplification: (input) => runSimplification(deps(), input),
    cancel: () => {
      controller.abort();
      controller = new AbortController();
    },
    callCount: () => calls,
  };
}

export const mockGeneration = createMockGeneration();
