// the only module that imports react-native-executorch. thin on purpose: the pipeline lives in
// generationPipeline.ts and the testable native-call logic in executorchAdapter.ts.
// LLMConfig has no max-new-tokens field (0.9.3), so boundedGenerate caps output by counting and interrupting
import { File, Paths } from 'expo-file-system';
import { LLMModule, TokenizerModule, initExecutorch } from 'react-native-executorch';
import { ExpoResourceFetcher } from 'react-native-executorch-expo-resource-fetcher';

import { enforceDeviceTokenBudget, MAX_NEW_TOKENS, type TokenCounter } from '@/services/deviceTokenBudget';
import {
  assertBundledSource,
  boundedGenerate,
  createGenerationLock,
  unloadModel,
} from '@/services/executorchAdapter';
import type { ModelFailure, ModelRuntime } from '@/services/generation';
import { GenerationCancelled } from '@/services/generationPipeline';
import type { ModelStatus } from '@/types';

// tokenizer files from the fine-tune output, with two changes that are easy to undo on a re-copy.
// named .rnejson, not .json, so metro (see metro.config.js) bundles them as assets instead of parsing 3.5 MB
// into the js bundle, where the library would also stringify and hash it on every launch. and the
// chat_template.jinja bytes are merged in under a chat_template key, without which every generation
// throws TokenizerError
/* eslint-disable @typescript-eslint/no-require-imports -- Metro's asset
   registry needs a literal require() call, statically analyzable at bundle
   time, to resolve a bundled file as an asset. See the comment above. */
const TOKENIZER_SOURCE = require('../assets/model/tokenizer.rnejson');
const TOKENIZER_CONFIG_SOURCE = require('../assets/model/tokenizer_config.rnejson');
/* eslint-enable @typescript-eslint/no-require-imports */

// not a metro asset: metro reads an asset into one js string, capped near 512 MB, and the shipped 8da8w export is 553 MB (bf16 was 818).
// plugins/withModelResources.js copies it into the app bundle instead, and app.json has to name the same
// file. the library memory-maps a file:// path in place, but treats any other string as remote, which is
// why bundledModelUri asserts the prefix
const MODEL_FILE_NAME = 'tether-360m-v12-8da8w.pte';

// copy bundle resources flattens to the bundle root, so the file name is the whole path inside it.
// called from doLoad, not at module scope, so importing this module touches no native constant
function bundledModelUri(fileName: string): string {
  const uri = new File(Paths.bundle, fileName).uri;
  if (!uri.startsWith('file://')) {
    throw new Error(
      `executorchRuntime: expected a file:// path inside the app bundle for ${fileName}, got "${uri}". Hard rule 1: nothing is fetched at runtime.`,
    );
  }
  return uri;
}

const TEMPERATURE = 0.3;
const TOP_P = 0.9;

// an interrupt during prefill is only seen once prefill ends, which can take seconds on old phones.
// 30 s leaves a wide margin without stranding a student behind a model that never answers
const STUCK_AFTER_INTERRUPT_MS = 30_000;

// grep-able timing lines for device runs. durations and token counts only, never prompt text
function diag(message: string): void {
  console.log(`[tether-diag] ${message}`);
}

let executorchInitialized = false;

// registers the expo resource fetcher. idempotent, called once from store/runtime.ts since app/ can't
// import services/
export function initExecutorchRuntime(): void {
  if (executorchInitialized) return;
  initExecutorch({ resourceFetcher: ExpoResourceFetcher });
  executorchInitialized = true;
}

/** builds a real ModelRuntime. state lives per call, store/runtime.ts makes exactly one */
export function createExecutorchRuntime(): ModelRuntime {
  let llm: LLMModule | null = null;
  let tokenizer: TokenizerModule | null = null;
  let loadPromise: Promise<void> | null = null;
  // load is lazy, so "not asked yet" and "loading" both report loading. either way it can't answer yet
  let status: ModelStatus = { state: 'loading' };
  const lock = createGenerationLock();
  let fatalListener: ((failure: ModelFailure) => void) | null = null;

  const onStuck = (): void => {
    diag(`generate still running ${STUCK_AFTER_INTERRUPT_MS} ms after interrupt; marking the model failed`);
    const failure: ModelFailure = { state: 'failed', reason: 'load_error' };
    status = failure;
    lock.poison(new Error('executorchRuntime: the model stopped responding after an interrupt'));
    fatalListener?.(failure);
  };

  const countTokens: TokenCounter = async (text) => {
    if (!tokenizer) throw new Error('executorchRuntime: countTokens called before load() resolved');
    const ids = await tokenizer.encode(text);
    return ids.length;
  };

  async function doLoad(): Promise<void> {
    const tokenizerSource = assertBundledSource(TOKENIZER_SOURCE, 'TOKENIZER_SOURCE');
    const modelSource = bundledModelUri(MODEL_FILE_NAME);
    const tokenizerConfigSource = assertBundledSource(TOKENIZER_CONFIG_SOURCE, 'TOKENIZER_CONFIG_SOURCE');

    const loadStarted = Date.now();
    diag(`load start ${MODEL_FILE_NAME}`);
    const nextTokenizer = new TokenizerModule();
    await nextTokenizer.load({ tokenizerSource });
    diag(`tokenizer loaded ${Date.now() - loadStarted} ms`);

    const nextLlm = await LLMModule.fromCustomModel(modelSource, tokenizerSource, tokenizerConfigSource);
    diag(`llm loaded ${Date.now() - loadStarted} ms`);
    nextLlm.configure({
      generationConfig: {
        temperature: TEMPERATURE,
        topP: TOP_P,
        // per-token callbacks so boundedGenerate's count is exact
        outputTokenBatchSize: 1,
      },
    });

    tokenizer = nextTokenizer;
    llm = nextLlm;
    status = { state: 'ready' };
  }

  return {
    load: () => {
      if (!loadPromise) {
        loadPromise = doLoad().catch((error: unknown) => {
          // cleared so a caller that retries gets a fresh attempt, not a cached rejection
          loadPromise = null;
          throw error;
        });
      }
      return loadPromise;
    },
    status: () => status,
    generate: (prompt, signal) =>
      lock.run(async () => {
        if (!llm) {
          throw new Error('executorchRuntime: generate() called before load() resolved');
        }
        const model = llm;
        const bounded = await enforceDeviceTokenBudget(prompt, countTokens);
        // counting tokens is native round trips, so a cancel that landed meanwhile is honoured here
        if (signal?.aborted) throw new GenerationCancelled();
        const started = Date.now();
        let firstTokenAt: number | null = null;
        let tokens = 0;
        diag('generate start');
        try {
          return await boundedGenerate(
            model,
            bounded,
            MAX_NEW_TOKENS,
            signal,
            (count) => {
              tokens = count;
              if (firstTokenAt === null) {
                firstTokenAt = Date.now();
                diag(`first token ${firstTokenAt - started} ms`);
              }
            },
            { afterMs: STUCK_AFTER_INTERRUPT_MS, onStuck },
          );
        } finally {
          diag(`generate done ${Date.now() - started} ms, ${tokens} tokens`);
        }
      }, signal),
    onFatal: (listener) => {
      fatalListener = listener;
    },
    // unloadModel resets this state even if delete() throws
    unload: () => {
      unloadModel(llm, () => {
        llm = null;
        tokenizer = null;
        loadPromise = null;
      });
    },
  };
}
