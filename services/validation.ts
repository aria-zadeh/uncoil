// model output validation: strip, parse, schema, then semantic checks. train/validate.py is a port and the
// gate checks both give identical verdicts, so the app and the eval agree on what "valid" means.
// the semantic checks are the point: a schema happily passes "Plan your essay"
import {
  COMMON_CAPITALIZED,
  IMPERATIVE_VERBS,
  STOPWORDS,
  VAGUE_PHRASES,
} from '@/services/lexicon.generated';
import {
  BREAKDOWN_LIMITS,
  EXTRACTION_LIMITS,
  SIMPLIFY_LIMITS,
  type Breakdown,
  type BreakdownInput,
  type Extraction,
  type Rejection,
  type RejectionCode,
  type SimplifyInput,
  type Simplification,
  type ValidationResult,
} from '@/types';

const IMPERATIVE_SET = new Set(IMPERATIVE_VERBS);
const COMMON_CAPITALIZED_SET = new Set(COMMON_CAPITALIZED.map((w) => w.toLowerCase()));
const STOPWORD_SET = new Set(STOPWORDS);

function reject(code: RejectionCode, reason: string): { ok: false; rejection: Rejection } {
  return { ok: false, rejection: { code, reason } };
}

function accept<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

// small models add fences and preamble despite being told not to, so strip rather than reject.
// the closing brace is found by depth, skipping strings, so trailing prose with a } isn't swallowed
export function stripToJson(raw: string): string | null {
  const text = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseRoot(raw: string): ValidationResult<Record<string, unknown>> {
  if (raw.trim() === '') return reject('empty_output', 'the response was empty');
  const sliced = stripToJson(raw);
  if (sliced === null) {
    return reject('no_json_object', 'the response contained no JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch {
    return reject('parse_error', 'the response was not valid JSON');
  }
  if (!isRecord(parsed)) {
    return reject('not_an_object', 'the response was not a JSON object');
  }
  return accept(parsed);
}

function checkKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): Rejection | null {
  for (const key of required) {
    if (!(key in obj)) return { code: 'missing_field', reason: `the field "${key}" was missing` };
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return { code: 'unexpected_field', reason: `the field "${key}" is not part of the format` };
    }
  }
  return null;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
}

function contentWords(text: string): Set<string> {
  return new Set(words(text).filter((w) => !STOPWORD_SET.has(w)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function startsWithImperative(title: string): boolean {
  const first = words(title)[0];
  return first !== undefined && IMPERATIVE_SET.has(first);
}

// multi-word phrases match anywhere, single words only as the first word, so "describe the process of"
// and "copy the words you need to learn" pass. matched on word boundaries, "planetary" isn't "plan"
function matchesVaguePhrase(title: string): string | null {
  const tokens = words(title);
  const normalized = tokens.join(' ');
  for (const phrase of VAGUE_PHRASES) {
    if (!phrase.includes(' ')) {
      if (tokens[0] === phrase) return phrase;
      continue;
    }
    if (normalized === phrase) return phrase;
    if (normalized.startsWith(`${phrase} `)) return phrase;
    if (normalized.includes(` ${phrase} `)) return phrase;
    if (normalized.endsWith(` ${phrase}`)) return phrase;
  }
  return null;
}

// a capitalised word that isn't in the assignment is probably invented. the first word is skipped, it's
// sentence-initial and already limited to the verb list. a possessive like "Ohm's" is sourced by its stem
function hallucinatedProperNoun(title: string, inputTokens: Set<string>): string | null {
  const tokens = title.split(/\s+/).filter((t) => t !== '');
  for (let i = 1; i < tokens.length; i += 1) {
    const bare = tokens[i].replace(/[^\p{L}\p{N}'’-]/gu, '');
    if (bare.length < 2) continue;
    const first = bare[0];
    if (first !== first.toUpperCase() || first === first.toLowerCase()) continue; // not capitalized
    const lower = bare.toLowerCase();
    if (COMMON_CAPITALIZED_SET.has(lower)) continue;
    if (inputTokens.has(lower)) continue;
    const possessiveMatch = lower.match(/^(.+)['’]s?$/);
    if (possessiveMatch && inputTokens.has(possessiveMatch[1])) continue;
    return bare;
  }
  return null;
}

function inputTokenSet(input: BreakdownInput): Set<string> {
  const blob = [input.title, input.subject ?? '', input.description ?? ''].join(' ');
  return new Set(words(blob));
}

export function validateBreakdown(
  raw: string,
  input: BreakdownInput,
): ValidationResult<Breakdown> {
  const parsed = parseRoot(raw);
  if (!parsed.ok) return parsed;
  const root = parsed.value;

  const keyProblem = checkKeys(root, ['steps', 'starterAction']);
  if (keyProblem) return { ok: false, rejection: keyProblem };

  const { steps, starterAction } = root;

  if (!Array.isArray(steps)) {
    return reject('wrong_type', 'the field "steps" was not a list');
  }
  if (steps.length < BREAKDOWN_LIMITS.minSteps) {
    return reject(
      'too_few_steps',
      `there were ${steps.length} steps, the minimum is ${BREAKDOWN_LIMITS.minSteps}`,
    );
  }
  if (steps.length > BREAKDOWN_LIMITS.maxSteps) {
    return reject(
      'too_many_steps',
      `there were ${steps.length} steps, the maximum is ${BREAKDOWN_LIMITS.maxSteps}`,
    );
  }
  if (typeof starterAction !== 'string') {
    return reject('wrong_type', 'the field "starterAction" was not a string');
  }

  const cleanSteps: { title: string; minutes: number }[] = [];

  for (let i = 0; i < steps.length; i += 1) {
    const ordinal = i + 1;
    const step: unknown = steps[i];
    if (!isRecord(step)) {
      return reject('wrong_type', `step ${ordinal} was not an object`);
    }
    const stepKeyProblem = checkKeys(step, ['title', 'minutes']);
    if (stepKeyProblem) {
      return {
        ok: false,
        rejection: { ...stepKeyProblem, reason: `in step ${ordinal}, ${stepKeyProblem.reason}` },
      };
    }
    const { title, minutes } = step;
    if (typeof title !== 'string') {
      return reject('wrong_type', `the title of step ${ordinal} was not a string`);
    }
    if (title.trim().length < BREAKDOWN_LIMITS.minTitleLength) {
      return reject('title_too_short', `the title of step ${ordinal} was too short`);
    }
    if (title.length > BREAKDOWN_LIMITS.maxTitleLength) {
      return reject(
        'title_too_long',
        `the title of step ${ordinal} was ${title.length} characters, the maximum is ${BREAKDOWN_LIMITS.maxTitleLength}`,
      );
    }
    if (typeof minutes !== 'number' || !Number.isInteger(minutes)) {
      return reject('minutes_not_integer', `the minutes of step ${ordinal} was not a whole number`);
    }
    if (minutes < BREAKDOWN_LIMITS.minMinutes || minutes > BREAKDOWN_LIMITS.maxMinutes) {
      return reject(
        'minutes_out_of_range',
        `step ${ordinal} was ${minutes} minutes, which is outside ${BREAKDOWN_LIMITS.minMinutes} to ${BREAKDOWN_LIMITS.maxMinutes}`,
      );
    }
    cleanSteps.push({ title, minutes });
  }

  if (
    starterAction.trim().length < BREAKDOWN_LIMITS.minStarterActionLength ||
    starterAction.length > BREAKDOWN_LIMITS.maxStarterActionLength
  ) {
    return reject(
      'starter_action_length',
      `the starter action must be between ${BREAKDOWN_LIMITS.minStarterActionLength} and ${BREAKDOWN_LIMITS.maxStarterActionLength} characters`,
    );
  }

  // semantic checks, only once the schema holds

  for (let i = 0; i < cleanSteps.length; i += 1) {
    const ordinal = i + 1;
    const { title } = cleanSteps[i];

    const vague = matchesVaguePhrase(title);
    if (vague !== null) {
      return reject('vague_verb', `step ${ordinal} says "${vague}", which is not something to do`);
    }
    if (!startsWithImperative(title)) {
      return reject('not_a_physical_action', `step ${ordinal} is not a physical action`);
    }
  }

  const seen = new Set<string>();
  for (let i = 0; i < cleanSteps.length; i += 1) {
    const key = words(cleanSteps[i].title).join(' ');
    if (seen.has(key)) {
      return reject('duplicate_step', `step ${i + 1} repeats an earlier step`);
    }
    seen.add(key);
  }

  const total = cleanSteps.reduce((sum, s) => sum + s.minutes, 0);
  if (total < BREAKDOWN_LIMITS.minTotalMinutes || total > BREAKDOWN_LIMITS.maxTotalMinutes) {
    return reject(
      'total_minutes_out_of_range',
      `the steps add up to ${total} minutes, which is outside ${BREAKDOWN_LIMITS.minTotalMinutes} to ${BREAKDOWN_LIMITS.maxTotalMinutes}`,
    );
  }

  const similarity = jaccard(contentWords(starterAction), contentWords(cleanSteps[0].title));
  if (similarity < BREAKDOWN_LIMITS.minStarterSimilarity) {
    return reject(
      'starter_action_mismatch',
      'the starter action does not restate the first step',
    );
  }

  const inputTokens = inputTokenSet(input);
  for (let i = 0; i < cleanSteps.length; i += 1) {
    const invented = hallucinatedProperNoun(cleanSteps[i].title, inputTokens);
    if (invented !== null) {
      return reject(
        'hallucinated_proper_noun',
        `step ${i + 1} mentions "${invented}", which is not in the assignment`,
      );
    }
  }

  return accept({ steps: cleanSteps, starterAction });
}

export function validateExtraction(raw: string): ValidationResult<Extraction> {
  const parsed = parseRoot(raw);
  if (!parsed.ok) return parsed;
  const root = parsed.value;

  const keyProblem = checkKeys(root, ['tasks']);
  if (keyProblem) return { ok: false, rejection: keyProblem };

  const { tasks } = root;
  if (!Array.isArray(tasks)) {
    return reject('wrong_type', 'the field "tasks" was not a list');
  }
  if (tasks.length > EXTRACTION_LIMITS.maxTasks) {
    return reject(
      'too_many_tasks',
      `there were ${tasks.length} tasks, the maximum is ${EXTRACTION_LIMITS.maxTasks}`,
    );
  }

  const clean: Extraction['tasks'] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const ordinal = i + 1;
    const item: unknown = tasks[i];
    if (!isRecord(item)) return reject('wrong_type', `task ${ordinal} was not an object`);

    const itemKeyProblem = checkKeys(item, ['title', 'dueInDays'], ['subject']);
    if (itemKeyProblem) {
      return {
        ok: false,
        rejection: { ...itemKeyProblem, reason: `in task ${ordinal}, ${itemKeyProblem.reason}` },
      };
    }

    const { title, dueInDays, subject } = item;
    if (typeof title !== 'string') {
      return reject('wrong_type', `the title of task ${ordinal} was not a string`);
    }
    if (title.trim().length < EXTRACTION_LIMITS.minTitleLength) {
      return reject('title_too_short', `the title of task ${ordinal} was too short`);
    }
    if (title.length > EXTRACTION_LIMITS.maxTitleLength) {
      return reject('title_too_long', `the title of task ${ordinal} was too long`);
    }
    if (typeof dueInDays !== 'number' || !Number.isInteger(dueInDays)) {
      return reject('wrong_type', `dueInDays of task ${ordinal} was not a whole number`);
    }
    if (dueInDays < EXTRACTION_LIMITS.minDueInDays || dueInDays > EXTRACTION_LIMITS.maxDueInDays) {
      return reject(
        'due_in_days_out_of_range',
        `task ${ordinal} is due in ${dueInDays} days, which is outside ${EXTRACTION_LIMITS.minDueInDays} to ${EXTRACTION_LIMITS.maxDueInDays}`,
      );
    }
    if (subject !== undefined) {
      if (typeof subject !== 'string') {
        return reject('wrong_type', `the subject of task ${ordinal} was not a string`);
      }
      if (subject.length > EXTRACTION_LIMITS.maxSubjectLength) {
        return reject('subject_too_long', `the subject of task ${ordinal} was too long`);
      }
    }

    clean.push(subject === undefined ? { title, dueInDays } : { title, dueInDays, subject });
  }

  return accept({ tasks: clean });
}

export function validateSimplification(
  raw: string,
  input: SimplifyInput,
): ValidationResult<Simplification> {
  const parsed = parseRoot(raw);
  if (!parsed.ok) return parsed;
  const root = parsed.value;

  const keyProblem = checkKeys(root, ['title', 'explanation']);
  if (keyProblem) return { ok: false, rejection: keyProblem };

  const { title, explanation } = root;
  if (typeof title !== 'string') return reject('wrong_type', 'the field "title" was not a string');
  if (typeof explanation !== 'string') {
    return reject('wrong_type', 'the field "explanation" was not a string');
  }
  if (
    title.trim().length < SIMPLIFY_LIMITS.minTitleLength ||
    title.length > SIMPLIFY_LIMITS.maxTitleLength
  ) {
    return reject(
      'title_too_long',
      `the title must be between ${SIMPLIFY_LIMITS.minTitleLength} and ${SIMPLIFY_LIMITS.maxTitleLength} characters`,
    );
  }
  if (
    explanation.trim().length < SIMPLIFY_LIMITS.minExplanationLength ||
    explanation.length > SIMPLIFY_LIMITS.maxExplanationLength
  ) {
    return reject(
      'explanation_length',
      `the explanation must be between ${SIMPLIFY_LIMITS.minExplanationLength} and ${SIMPLIFY_LIMITS.maxExplanationLength} characters`,
    );
  }

  const inputTokens = new Set(words([input.title, input.description ?? ''].join(' ')));
  const invented = hallucinatedProperNoun(title, inputTokens);
  if (invented !== null) {
    return reject(
      'hallucinated_proper_noun',
      `the title mentions "${invented}", which is not in the assignment`,
    );
  }

  return accept({ title, explanation });
}

// not model output, so this has its own result type and stays out of the eval's rejection counts
export type TaskFieldRejectionCode = 'start_time_after_due_date';

export interface TaskFieldRejection {
  code: TaskFieldRejectionCode;
  reason: string;
}

export type TaskFieldValidationResult = { ok: true } | { ok: false; rejection: TaskFieldRejection };

// a start time may never fall after its own due date. malformed dates pass, so they don't masquerade
// as this rejection
export function validateTaskTiming(fields: {
  dueDate: string;
  startTime: string | null;
}): TaskFieldValidationResult {
  if (fields.startTime === null) return { ok: true };
  const due = new Date(fields.dueDate).getTime();
  const start = new Date(fields.startTime).getTime();
  if (Number.isNaN(due) || Number.isNaN(start)) return { ok: true };
  if (start > due) {
    return {
      ok: false,
      rejection: {
        code: 'start_time_after_due_date',
        reason: 'the start time falls after the due date',
      },
    };
  }
  return { ok: true };
}
