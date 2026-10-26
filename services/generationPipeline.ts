// build the prompt, run the model, validate, repair once, fall back to a template. the runtime comes in
// as a Runner so all of this runs in node. every export resolves, except on cancellation
import { allSafe, isInputBlocked, isSafe, sanitizeForPrompt } from '@/services/contentFilter';
import { lastDueOf, reconcileDueDates } from '@/services/dueDates';
import {
  buildBreakdownPrompt,
  buildExtractionPrompt,
  buildRepairPrompt,
  buildSimplifyPrompt,
  chunkForExtraction,
  weekdayOf,
  type Prompt,
} from '@/services/prompt';
import { forTask } from '@/services/templates';
import { tidyBreakdown } from '@/services/tidyBreakdown';
import {
  stripToJson,
  validateBreakdown,
  validateExtraction,
  validateSimplification,
} from '@/services/validation';
import {
  EXTRACTION_LIMITS,
  type Breakdown,
  type BreakdownInput,
  type BreakdownResult,
  type Extraction,
  type ExtractionResult,
  type ExtractedTask,
  type GenerationTier,
  type Simplification,
  type SimplifyInput,
  type SimplifyResult,
  type ValidationResult,
} from '@/types';

// raw model text for a prompt. a rejection (load failure, oom, timeout) becomes a template
export type Runner = (prompt: Prompt, signal?: AbortSignal) => Promise<string>;

// the one thing the pipeline re-throws: a template for abandoned work would show an answer nobody asked for
export class GenerationCancelled extends Error {
  constructor() {
    super('generation cancelled');
    this.name = 'GenerationCancelled';
  }
}

export function isCancellation(error: unknown): boolean {
  return (
    error instanceof GenerationCancelled ||
    (typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError')
  );
}

export interface PipelineDeps {
  run: Runner;
  now?: () => number;
  signal?: AbortSignal;
}

// estimated-token budget for notes. max_new_tokens 320 of max_seq_len 1024 leaves 704 for the prompt and
// the fixed part measures up to 100. train/test_prompt_budget.py reads this and NOTES_WEIGHTS by regex and
// checks them against the real tokenizer
export const NOTES_TOKEN_BUDGET = 550;

// upper bound on real tokens per code point, over-estimating on purpose. digits and otherBmp were raised
// to cover dense alphanumeric text and cjk prose
export const NOTES_WEIGHTS = {
  whitespace: 0,
  asciiLetter: 0.5,
  asciiDigit: 2.0,
  asciiPunct: 1.0,
  // per astral code point, not per code unit
  astral: 4.0,
  // accented latin, cjk, cyrillic, and so on
  otherBmp: 1.8,
} as const;

type NotesWeightClass = keyof typeof NOTES_WEIGHTS;

function classifyCodePoint(ch: string): NotesWeightClass {
  if (/\s/u.test(ch)) return 'whitespace';
  const codePoint = ch.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) {
    if ((codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a)) {
      return 'asciiLetter';
    }
    if (codePoint >= 0x30 && codePoint <= 0x39) return 'asciiDigit';
    return 'asciiPunct'; // punctuation, symbols, control
  }
  if (codePoint > 0xffff) return 'astral';
  return 'otherBmp';
}

// iterates by code point, so an emoji's surrogate pair is weighed once
export function estimateTokensUpperBound(text: string): number {
  let total = 0;
  for (const ch of text) total += NOTES_WEIGHTS[classifyCodePoint(ch)];
  return total;
}

// cuts at the last whitespace before the budget, never mid-word. walking by code point keeps even the
// hard cut surrogate-safe
export function clampNotes(text: string | null): string | null {
  if (text === null || estimateTokensUpperBound(text) <= NOTES_TOKEN_BUDGET) return text;

  let total = 0;
  let offset = 0; // utf-16 code units, what slice needs
  let lastWordBreak = -1; // offset just before the whitespace run that starts there
  let inWhitespaceRun = false;

  for (const ch of text) {
    const weight = NOTES_WEIGHTS[classifyCodePoint(ch)];
    if (total + weight > NOTES_TOKEN_BUDGET) {
      const cut = lastWordBreak > 0 ? lastWordBreak : offset;
      return text.slice(0, cut);
    }
    if (weight === 0) {
      if (!inWhitespaceRun) {
        lastWordBreak = offset;
        inWhitespaceRun = true;
      }
    } else {
      inWhitespaceRun = false;
    }
    total += weight;
    offset += ch.length; // 1 for BMP, 2 for an astral surrogate pair
  }
  return text;
}

// counted in code points so an astral character is never cut in half
export const INPUT_CAPS = { title: 120, subject: 40 } as const;

function capChars(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

// done here, not in prompt.ts, which has to stay byte-identical with train/
function prepareField(text: string, max: number): string {
  return capChars(sanitizeForPrompt(text), max);
}

// the user's own words, which license contextual and medical words in the answer
function inputContext(fields: readonly (string | null)[]): string {
  return fields.filter((f): f is string => f !== null).join('\n');
}

function elapsed(deps: PipelineDeps, startedAt: number): number {
  const now = deps.now ?? Date.now;
  return Math.max(0, Math.round(now() - startedAt));
}

function startClock(deps: PipelineDeps): number {
  const now = deps.now ?? Date.now;
  return now();
}

// exactly one repair. a runner rejection returns null without spending it, asking again won't help
async function attemptWithOneRepair<T>(
  deps: PipelineDeps,
  prompt: Prompt,
  validate: (raw: string) => { ok: true; value: T } | { ok: false; rejection: { reason: string } },
): Promise<T | null> {
  let raw: string;
  try {
    raw = await deps.run(prompt, deps.signal);
  } catch (error) {
    if (isCancellation(error)) throw error;
    return null;
  }

  const first = validate(raw);
  if (first.ok) return first.value;

  let repaired: string;
  try {
    repaired = await deps.run(buildRepairPrompt(prompt, first.rejection.reason), deps.signal);
  } catch (error) {
    if (isCancellation(error)) throw error;
    return null;
  }

  const second = validate(repaired);
  return second.ok ? second.value : null;
}

// tidies the first attempt and the repair alike. unparseable text is left for validateBreakdown to report
function tidyRawBreakdown(raw: string): string {
  const sliced = stripToJson(raw);
  if (sliced === null) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch {
    return raw;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw;

  const root = parsed as Record<string, unknown>;
  if (!Array.isArray(root.steps)) return raw;

  const { steps } = tidyBreakdown(root.steps);
  return JSON.stringify({ ...root, steps });
}

// falls back to validating the raw text, so a repair prompt names a mistake the model actually made.
// three duplicates tidied to two steps would otherwise come back as too_few_steps
function validateTidiedBreakdown(
  raw: string,
  input: BreakdownInput,
): ValidationResult<Breakdown> {
  const tidied = validateBreakdown(tidyRawBreakdown(raw), input);
  return tidied.ok ? tidied : validateBreakdown(raw, input);
}

export async function runBreakdown(
  deps: PipelineDeps,
  input: BreakdownInput,
): Promise<BreakdownResult> {
  const startedAt = startClock(deps);
  // capped here, not in prompt.ts: a length cap is generation policy, not part of the model's format
  const clamped: BreakdownInput = {
    ...input,
    title: prepareField(input.title, INPUT_CAPS.title),
    subject: input.subject === null ? null : prepareField(input.subject, INPUT_CAPS.subject),
    description: clampNotes(input.description === null ? null : sanitizeForPrompt(input.description)),
  };
  const context = inputContext([clamped.title, clamped.subject, clamped.description]);

  // input with an always/harm hit skips the model, it would likely echo it back
  const accepted = isInputBlocked(context)
    ? null
    : await attemptWithOneRepair<Breakdown>(
        deps,
        buildBreakdownPrompt(clamped),
        (raw) => validateTidiedBreakdown(raw, clamped),
      );

  // filtered outside the repair loop, so a filtered answer is never quoted back to the model
  const value =
    accepted !== null &&
    allSafe([...accepted.steps.map((s) => s.title), accepted.starterAction], context)
      ? accepted
      : null;

  const tier: GenerationTier = value === null ? 'template' : 'model';
  return {
    breakdown: value ?? forTask(clamped),
    tier,
    latencyMs: elapsed(deps, startedAt),
  };
}

export async function runSimplification(
  deps: PipelineDeps,
  input: SimplifyInput,
): Promise<SimplifyResult> {
  const startedAt = startClock(deps);
  const clamped: SimplifyInput = {
    ...input,
    title: prepareField(input.title, INPUT_CAPS.title),
    description: clampNotes(input.description === null ? null : sanitizeForPrompt(input.description)),
  };
  const context = inputContext([clamped.title, clamped.description]);

  const accepted = isInputBlocked(context)
    ? null
    : await attemptWithOneRepair<Simplification>(
        deps,
        buildSimplifyPrompt(clamped),
        (raw) => validateSimplification(raw, clamped),
      );
  const value =
    accepted !== null && allSafe([accepted.title, accepted.explanation], context) ? accepted : null;

  return {
    simplification: value ?? templateSimplification(clamped, context),
    tier: value === null ? 'template' : 'model',
    latencyMs: elapsed(deps, startedAt),
  };
}

// keeps the original title verbatim, a plainer one is the model's job. cut at a word boundary since
// SIMPLIFY_LIMITS.maxTitleLength (80) is shorter than a task title can be
export function templateSimplification(input: SimplifyInput, context: string): Simplification {
  const trimmed = input.title.trim();
  const title = trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 77).trimEnd()}...`;
  return {
    // echoes the user's title, so it gets the same filter as model output
    title: title.length >= 3 && isSafe(title, context) ? title : 'This task',
    explanation:
      'These are the same words as the original. Open the assignment and read the first line out loud to get started.',
  };
}

// each chunk is a model run plus a possible repair, so a whole pasted syllabus would hold the model for minutes
export const MAX_EXTRACTION_CHUNKS = 10;

// chunks run in order, there's one model. no template tier: guessing would invent assignments, so nothing
// found is reported as nothing found. due dates are reconciled in typescript, the model miscounts weekdays
export async function runExtraction(
  deps: PipelineDeps,
  text: string,
): Promise<ExtractionResult> {
  const startedAt = startClock(deps);
  // text past the cap isn't read, the paste box is limited in the ui too
  const chunks = chunkForExtraction(text, EXTRACTION_LIMITS.maxChunkChars).slice(0, MAX_EXTRACTION_CHUNKS);

  // one weekday for the whole paste. reuses the latency clock reading so a fake clock sees no extra tick
  const today = weekdayOf(new Date(startedAt));

  const tasks: ExtractedTask[] = [];
  const seen = new Set<string>();
  let anyChunkSucceeded = false;
  // carried across chunks, so "the following monday" in chunk two counts from chunk one's last due date
  let lastDue: number | null = null;

  for (const rawChunk of chunks) {
    const chunk = sanitizeForPrompt(rawChunk);
    // skipped without running the model, like a chunk it couldn't answer
    if (isInputBlocked(chunk)) continue;
    const value = await attemptWithOneRepair<Extraction>(
      deps,
      buildExtractionPrompt(chunk, today),
      validateExtraction,
    );
    if (value === null) continue;

    // filtered per task, so one bad title drops that task, not the chunk
    const safeTasks = value.tasks.filter((t) =>
      allSafe(t.subject === undefined ? [t.title] : [t.title, t.subject], chunk),
    );
    if (value.tasks.length > 0 && safeTasks.length === 0) continue;
    anyChunkSucceeded = true;

    const reconciled = reconcileDueDates(safeTasks, chunk, today, new Date(startedAt), lastDue);
    lastDue = lastDueOf(reconciled) ?? lastDue;

    for (const task of reconciled) {
      // chunking is an implementation detail, the same assignment in two chunks is one task
      const key = `${task.title.trim().toLowerCase()}|${task.dueInDays}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push(task);
      if (tasks.length >= EXTRACTION_LIMITS.maxTasks) break;
    }
    if (tasks.length >= EXTRACTION_LIMITS.maxTasks) break;
  }

  return {
    extraction: { tasks },
    tier: anyChunkSucceeded ? 'model' : 'template',
    latencyMs: elapsed(deps, startedAt),
  };
}

// gives up after timeoutMs, and the pipeline turns that into a template
export function withTimeout(run: Runner, timeoutMs: number): Runner {
  return (prompt, signal) =>
    new Promise<string>((resolve, reject) => {
      let settled = false;
      // forwarded through our own controller so a timeout also aborts the native call. otherwise it kept
      // running and the repair or the next request found the module busy
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener('abort', forwardAbort);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', forwardAbort);
        controller.abort();
        reject(new Error(`generation exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      run(prompt, controller.signal).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', forwardAbort);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', forwardAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
}

// generous on purpose: a slow tailored breakdown beats a template, and the first call also pays for the
// model load (2.9 s load plus 1.45 s generation on the simulator, older phones are slower)
export const TIMEOUT_MS = {
  breakdown: 40_000,
  extraction: 30_000,
  simplification: 30_000,
} as const;
