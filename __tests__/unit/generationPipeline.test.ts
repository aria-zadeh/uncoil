import { describe, expect, it, vi } from 'vitest';

import { createMockRunner } from '@/services/generation.mock';
import {
  clampNotes,
  estimateTokensUpperBound,
  GenerationCancelled,
  INPUT_CAPS,
  isCancellation,
  NOTES_TOKEN_BUDGET,
  runBreakdown,
  runExtraction,
  runSimplification,
  withTimeout,
  type PipelineDeps,
  type Runner,
} from '@/services/generationPipeline';
import {
  buildBreakdownPrompt,
  buildSimplifyPrompt,
  SYSTEM_BREAKDOWN,
  SYSTEM_EXTRACTION,
  type Prompt,
} from '@/services/prompt';
import { forTask } from '@/services/templates';
import type { BreakdownInput, SimplifyInput } from '@/types';

function input(overrides: Partial<BreakdownInput> = {}): BreakdownInput {
  return {
    title: 'Write a 5-paragraph essay on the reading',
    subject: 'English',
    description: null,
    duePhrase: 'in 3 days',
    sessionMinutes: 30,
    ...overrides,
  };
}

// advances a fixed step per reading so latencyMs is an exact number
function fakeClock(stepMs = 100): () => number {
  let t = 0;
  return () => {
    const current = t;
    t += stepMs;
    return current;
  };
}

function deps(run: Runner, extra: Partial<PipelineDeps> = {}): PipelineDeps {
  return { run, now: fakeClock(), ...extra };
}

const VALID_BREAKDOWN = JSON.stringify({
  steps: [
    { title: 'Open the reading and go through it once', minutes: 10 },
    { title: 'Write down the three points to make', minutes: 10 },
    { title: 'Write the essay in one sitting', minutes: 30 },
  ],
  starterAction: 'Open the reading and go through it once',
});

// parses but fails the semantic checks ("plan" is on the vague list), the case repair exists for
const SEMANTICALLY_INVALID = JSON.stringify({
  steps: [
    { title: 'Plan the essay carefully', minutes: 10 },
    { title: 'Think about the argument', minutes: 10 },
    { title: 'Write the essay in one sitting', minutes: 30 },
  ],
  starterAction: 'Plan the essay carefully',
});

describe('runBreakdown', () => {
  it('uses valid model output and reports the model tier', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(VALID_BREAKDOWN);
    const result = await runBreakdown(deps(run), input());

    expect(result.tier).toBe('model');
    expect(result.breakdown.steps).toHaveLength(3);
    expect(result.breakdown.starterAction).toBe('Open the reading and go through it once');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('repairs once and still reports the model tier', async () => {
    const run = vi
      .fn<Runner>()
      .mockResolvedValueOnce(SEMANTICALLY_INVALID)
      .mockResolvedValueOnce(VALID_BREAKDOWN);

    const result = await runBreakdown(deps(run), input());

    expect(result.tier).toBe('model');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('sends the concrete rejection reason on the repair attempt', async () => {
    const prompts: Prompt[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (prompt: Prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? SEMANTICALLY_INVALID : VALID_BREAKDOWN;
    });

    await runBreakdown(deps(run), input());

    expect(prompts[1].user).toContain('Rejected:');
    expect(prompts[1].user).toContain('Respond again with JSON only.');
    expect(prompts[1].user).toMatch(/step \d/);
    expect(prompts[1].system).toBe(prompts[0].system);
  });

  it('falls back to a template after two invalid attempts and stops there', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(SEMANTICALLY_INVALID);
    const task = input();
    const result = await runBreakdown(deps(run), task);

    expect(result.tier).toBe('template');
    expect(result.breakdown).toEqual(forTask(task));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('falls back to a template on a runner failure without spending the repair', async () => {
    const run = vi.fn<Runner>().mockRejectedValue(new Error('model failed to load'));
    const result = await runBreakdown(deps(run), input());

    expect(result.tier).toBe('template');
    // a model that could not answer at all will not do better with a reason appended
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rethrows cancellation instead of substituting a template', async () => {
    const run = vi.fn<Runner>().mockRejectedValue(new GenerationCancelled());

    // a template here would put an answer on screen the user abandoned
    await expect(runBreakdown(deps(run), input())).rejects.toBeInstanceOf(GenerationCancelled);
  });

  it('treats a DOM-style AbortError as cancellation', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const run = vi.fn<Runner>().mockRejectedValue(abort);

    await expect(runBreakdown(deps(run), input())).rejects.toBe(abort);
    expect(isCancellation(abort)).toBe(true);
    expect(isCancellation(new Error('something else'))).toBe(false);
  });

  it('reports latency from the injected clock', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(VALID_BREAKDOWN);
    const result = await runBreakdown(deps(run, { now: fakeClock(250) }), input());

    expect(result.latencyMs).toBe(250);
  });

  it('produces a validator-clean breakdown on every path', async () => {
    const task = input();
    for (const behavior of ['valid', 'repair', 'invalid', 'error'] as const) {
      const result = await runBreakdown(deps(createMockRunner({ behavior })), task);
      const total = result.breakdown.steps.reduce((sum, step) => sum + step.minutes, 0);

      expect(result.breakdown.steps.length).toBeGreaterThanOrEqual(3);
      expect(result.breakdown.steps.length).toBeLessThanOrEqual(7);
      expect(total).toBeGreaterThanOrEqual(15);
      expect(total).toBeLessThanOrEqual(300);
      expect(result.breakdown.starterAction.length).toBeGreaterThanOrEqual(8);
    }
  });
});

// step 1 repeated as step 2. tidying leaves exactly VALID_BREAKDOWN
const DUPLICATE_STEP_BREAKDOWN = JSON.stringify({
  steps: [
    { title: 'Open the reading and go through it once', minutes: 10 },
    { title: 'Open the reading and go through it once', minutes: 10 },
    { title: 'Write down the three points to make', minutes: 10 },
    { title: 'Write the essay in one sitting', minutes: 30 },
  ],
  starterAction: 'Open the reading and go through it once',
});

// eight valid steps. tidying keeps the first six plus the last
const EIGHT_STEP_BREAKDOWN = JSON.stringify({
  steps: [
    { title: 'Open the reading and go through it once', minutes: 10 },
    { title: 'Read the first paragraph twice', minutes: 10 },
    { title: 'List the three main points', minutes: 10 },
    { title: 'Write down a topic sentence', minutes: 10 },
    { title: 'Highlight the key quotes', minutes: 10 },
    { title: 'Draft the body paragraphs', minutes: 10 },
    { title: 'Underline the transitions used', minutes: 10 },
    { title: 'Check the essay reads well', minutes: 10 },
  ],
  starterAction: 'Open the reading and go through it once',
});

// tidying leaves two unique steps, still under the minimum, so repair and template still run
const STILL_TOO_FEW_AFTER_TIDY = JSON.stringify({
  steps: [
    { title: 'Open the reading and go through it once', minutes: 10 },
    { title: 'Open the reading and go through it once', minutes: 10 },
    { title: 'Open the reading and go through it once', minutes: 10 },
    { title: 'Write the essay in one sitting', minutes: 30 },
  ],
  starterAction: 'Open the reading and go through it once',
});

// two duplicate pairs. the repair reason should name the repeat the model wrote,
// not the "2 steps" count tidying produced
const FOUR_STEPS_TWO_DUPLICATE_PAIRS = JSON.stringify({
  steps: [
    { title: 'Open the reading and go through it once', minutes: 10 },
    { title: 'Open the reading and go through it once', minutes: 10 },
    { title: 'Write down the three points to make', minutes: 10 },
    { title: 'Write down the three points to make', minutes: 10 },
  ],
  starterAction: 'Open the reading and go through it once',
});

describe('tidying model output before validation', () => {
  it('builds the repair prompt from the untidied rejection, not a count tidy produced', async () => {
    const prompts: Prompt[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (prompt: Prompt) => {
      prompts.push(prompt);
      return FOUR_STEPS_TWO_DUPLICATE_PAIRS;
    });

    await runBreakdown(deps(run), input());

    expect(prompts[1].user).toContain('repeats an earlier step');
    expect(prompts[1].user).not.toContain('2 steps');
  });


  it('drops a duplicate step and returns tier "model" with it removed', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(DUPLICATE_STEP_BREAKDOWN);
    const result = await runBreakdown(deps(run), input());

    expect(result.tier).toBe('model');
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.breakdown.steps.map((s) => s.title)).toEqual([
      'Open the reading and go through it once',
      'Write down the three points to make',
      'Write the essay in one sitting',
    ]);
  });

  it('trims an eight-step output to seven steps and still reports tier "model"', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(EIGHT_STEP_BREAKDOWN);
    const result = await runBreakdown(deps(run), input());

    expect(result.tier).toBe('model');
    expect(result.breakdown.steps).toHaveLength(7);
    expect(result.breakdown.steps.map((s) => s.title)).not.toContain(
      'Underline the transitions used',
    );
    expect(result.breakdown.steps[6].title).toBe('Check the essay reads well');
  });

  it('still repairs then falls back to a template when tidying is not enough', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(STILL_TOO_FEW_AFTER_TIDY);
    const task = input();
    const result = await runBreakdown(deps(run), task);

    expect(result.tier).toBe('template');
    expect(result.breakdown).toEqual(forTask(task));
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('estimateTokensUpperBound', () => {
  it('weighs whitespace at zero and mixes classes by their own weight', () => {
    // letter, whitespace, digit, other BMP, astral pair
    const text = 'a 1é\u{1F600}';
    expect(estimateTokensUpperBound(text)).toBeCloseTo(
      1 * 0.5 + 0 + 1 * 2.0 + 1 * 1.8 + 1 * 4.0,
    );
  });

  it('counts an astral character once, not once per UTF-16 code unit', () => {
    const oneEmoji = '\u{1F600}';
    expect(oneEmoji.length).toBe(2); // a surrogate pair, two code units
    expect(estimateTokensUpperBound(oneEmoji)).toBe(4.0);
  });

  it('is zero for an empty string', () => {
    expect(estimateTokensUpperBound('')).toBe(0);
  });
});

describe('the prompt token budget clamp', () => {
  it('clamps a very long, whitespace-free description to the token budget', async () => {
    const longDescription = 'a'.repeat(8_000);
    let seenPrompt: Prompt | null = null;
    const run = vi.fn<Runner>().mockImplementation(async (prompt: Prompt) => {
      seenPrompt = prompt;
      return VALID_BREAKDOWN;
    });

    await runBreakdown(deps(run), input({ description: longDescription }));

    expect(seenPrompt).not.toBeNull();
    const clamped = clampNotes(longDescription)!;
    expect(seenPrompt!.user).toBe(buildBreakdownPrompt(input({ description: clamped })).user);
    expect(clamped.length).toBeLessThan(longDescription.length);
    expect(estimateTokensUpperBound(clamped)).toBeLessThanOrEqual(NOTES_TOKEN_BUDGET);
    expect(estimateTokensUpperBound(longDescription.slice(0, clamped.length + 1))).toBeGreaterThan(
      NOTES_TOKEN_BUDGET,
    );
  });

  it('cuts at the last whitespace before the budget, not mid-word', async () => {
    // a hard cut with no whitespace awareness would land inside the "b" run
    const description = `${'a'.repeat(400)} ${'b'.repeat(1_000)}`;
    let seenPrompt: Prompt | null = null;
    const run = vi.fn<Runner>().mockImplementation(async (prompt: Prompt) => {
      seenPrompt = prompt;
      return VALID_BREAKDOWN;
    });

    await runBreakdown(deps(run), input({ description }));

    expect(seenPrompt).not.toBeNull();
    // "Subject: English" has a "b" too, so only look after "Details:"
    expect(seenPrompt!.user).not.toMatch(/Details:.*b/s);
    expect(seenPrompt!.user).toBe(
      buildBreakdownPrompt(input({ description: 'a'.repeat(400) })).user,
    );
  });

  it('leaves a description under the budget completely unchanged', async () => {
    const description = 'a short note about the reading'.repeat(5);
    expect(estimateTokensUpperBound(description)).toBeLessThan(NOTES_TOKEN_BUDGET);

    let seenPrompt: Prompt | null = null;
    const run = vi.fn<Runner>().mockImplementation(async (prompt: Prompt) => {
      seenPrompt = prompt;
      return VALID_BREAKDOWN;
    });

    await runBreakdown(deps(run), input({ description }));

    expect(seenPrompt!.user).toBe(buildBreakdownPrompt(input({ description })).user);
    // same reference: prompt parity depends on the clamp being a true no-op under budget
    expect(clampNotes(description)).toBe(description);
  });

  it('applies the same clamp to the simplification prompt', async () => {
    const longDescription = 'a'.repeat(8_000);
    let seenPrompt: Prompt | null = null;
    const run = vi.fn<Runner>().mockImplementation(async (prompt: Prompt) => {
      seenPrompt = prompt;
      return JSON.stringify({
        title: 'Explain how the writer makes their point',
        explanation:
          'You are being asked to describe the techniques the writer uses and why they work, in your own words.',
      });
    });

    await runSimplification(deps(run), { title: 'Anything', description: longDescription });

    expect(seenPrompt).not.toBeNull();
    const clamped = clampNotes(longDescription)!;
    expect(seenPrompt!.user).toBe(
      buildSimplifyPrompt({ title: 'Anything', description: clamped }).user,
    );
  });

  it('does not cut a surrogate pair in half at the hard-truncation boundary', () => {
    // each emoji weighs 4.0, so the cut lands deep inside the run
    const text = `x${'\u{1F600}'.repeat(400)}`;
    expect(estimateTokensUpperBound(text)).toBeGreaterThan(NOTES_TOKEN_BUDGET);

    const result = clampNotes(text)!;

    expect(result).not.toBeNull();
    expect(result.length).toBeLessThan(text.length);
    expect(/[\uD800-\uDBFF]$/.test(result)).toBe(false);
    // a split pair decodes to the replacement character
    expect(Array.from(result)).not.toContain('\uFFFD');
    expect(result).toMatch(/^x(?:\u{1F600})*$/u);
  });

  it('does not touch a boundary that already falls between whole characters', () => {
    const text = 'x'.repeat(2_000);
    const result = clampNotes(text)!;
    expect(result).toBe('x'.repeat(result.length));
    expect(text.startsWith(result)).toBe(true);
  });
});

describe('runSimplification', () => {
  const task: SimplifyInput = {
    title: 'Compose a rhetorical analysis of the assigned passage',
    description: null,
  };

  it('uses valid model output', async () => {
    const valid = JSON.stringify({
      title: 'Explain how the writer makes their point',
      explanation:
        'You are being asked to describe the techniques the writer uses and why they work, in your own words.',
    });
    const result = await runSimplification(deps(vi.fn<Runner>().mockResolvedValue(valid)), task);

    expect(result.tier).toBe('model');
    expect(result.simplification.title).toBe('Explain how the writer makes their point');
  });

  it('keeps the original wording when the model cannot simplify it', async () => {
    const run = vi.fn<Runner>().mockRejectedValue(new Error('nope'));
    const result = await runSimplification(deps(run), task);

    expect(result.tier).toBe('template');
    // a plainer title would mean rewording the very text the model failed to reword
    expect(result.simplification.title).toBe(task.title);
    expect(result.simplification.explanation.length).toBeGreaterThanOrEqual(20);
  });

  it('truncates an over-long title at a word boundary', async () => {
    const long = { title: `${'Analyse the passage and '.repeat(8)}finish`, description: null };
    const run = vi.fn<Runner>().mockRejectedValue(new Error('nope'));
    const result = await runSimplification(deps(run), long);

    expect(result.simplification.title.length).toBeLessThanOrEqual(80);
    expect(result.simplification.title.endsWith('...')).toBe(true);
    expect(result.simplification.title).not.toMatch(/\s\.\.\.$/);
  });
});

describe('runExtraction', () => {
  const twoTasks = JSON.stringify({
    tasks: [
      { title: 'Reading response', dueInDays: 2, subject: 'English' },
      { title: 'Problem set', dueInDays: 5 },
    ],
  });

  it('returns the tasks the model found', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(twoTasks);
    const result = await runExtraction(deps(run), 'Reading response Friday. Problem set Monday.');

    expect(result.tier).toBe('model');
    expect(result.extraction.tasks).toHaveLength(2);
  });

  it('deduplicates a task named in two chunks', async () => {
    const text = `${'a'.repeat(700)}\n\n${'b'.repeat(700)}`;
    const run = vi.fn<Runner>().mockResolvedValue(twoTasks);
    const result = await runExtraction(deps(run), text);

    expect(run.mock.calls.length).toBeGreaterThan(1);
    expect(result.extraction.tasks).toHaveLength(2);
  });

  it('never returns more than the maximum, across chunks', async () => {
    const eight = JSON.stringify({
      tasks: Array.from({ length: 8 }, (_, i) => ({ title: `Task number ${i}`, dueInDays: i })),
    });
    const text = Array.from({ length: 4 }, (_, i) => `${String(i).repeat(700)}`).join('\n\n');
    let call = 0;
    const run = vi.fn<Runner>().mockImplementation(async () => {
      call += 1;
      return call === 1
        ? eight
        : JSON.stringify({ tasks: [{ title: 'A different task', dueInDays: 1 }] });
    });

    const result = await runExtraction(deps(run), text);
    expect(result.extraction.tasks).toHaveLength(8);
  });

  it('reports the model tier when only some chunks succeed', async () => {
    const text = `${'a'.repeat(700)}\n\n${'b'.repeat(700)}`;
    let call = 0;
    const run = vi.fn<Runner>().mockImplementation(async () => {
      call += 1;
      // a runner rejection does not spend the repair, so chunk two is the next call
      if (call === 1) throw new Error('first chunk failed');
      return twoTasks;
    });

    const result = await runExtraction(deps(run), text);

    // labelling a partial success a template would show the fallback notice over real findings
    expect(result.tier).toBe('model');
    expect(result.extraction.tasks).toHaveLength(2);
  });

  it('reports nothing found rather than inventing tasks', async () => {
    const run = vi.fn<Runner>().mockRejectedValue(new Error('nope'));
    const result = await runExtraction(deps(run), 'Some text with no assignments in it.');

    expect(result.tier).toBe('template');
    expect(result.extraction.tasks).toEqual([]);
  });

  it('accepts a genuinely empty task list as a model answer', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(JSON.stringify({ tasks: [] }));
    const result = await runExtraction(deps(run), 'See you all on Monday.');

    expect(result.tier).toBe('model');
    expect(result.extraction.tasks).toEqual([]);
  });

  it('sends the runner a prompt carrying the reference weekday from the pinned clock', async () => {
    // 2026-09-09 12:00 local is a wednesday
    const wednesday = new Date(2026, 8, 9, 12, 0).getTime();
    const run = vi.fn<Runner>().mockResolvedValue(twoTasks);

    await runExtraction(deps(run, { now: () => wednesday }), 'Reading response Friday.');

    expect(run.mock.calls[0][0].user).toBe('Today: Wednesday\nText: Reading response Friday.');
  });

  it('gives every chunk of the same paste the same reference weekday', async () => {
    const friday = new Date(2026, 8, 11, 12, 0).getTime();
    const text = `${'a'.repeat(700)}\n\n${'b'.repeat(700)}`;
    const run = vi.fn<Runner>().mockResolvedValue(twoTasks);

    await runExtraction(deps(run, { now: () => friday }), text);

    expect(run.mock.calls.length).toBeGreaterThan(1);
    for (const call of run.mock.calls) {
      expect(call[0].user.startsWith('Today: Friday\n')).toBe(true);
    }
  });

  it('reconciles dueInDays and tags dueSource against the chunk text before dedupe', async () => {
    // the model's date-exact accuracy is 0.442, so both counts here are wrong on purpose
    const wednesday = new Date(2026, 8, 9, 12, 0).getTime();
    const run = vi.fn<Runner>().mockResolvedValue(
      JSON.stringify({
        tasks: [
          { title: 'Reading response', dueInDays: 2, subject: 'English' },
          { title: 'Problem set', dueInDays: 5 },
        ],
      }),
    );

    const result = await runExtraction(
      deps(run, { now: () => wednesday }),
      'Reading response is due next Tuesday. Problem set is due Friday.',
    );

    expect(result.extraction.tasks).toEqual([
      { title: 'Reading response', dueInDays: 6, subject: 'English', dueSource: 'text' },
      { title: 'Problem set', dueInDays: 2, dueSource: 'text' },
    ]);
  });
});

describe('withTimeout', () => {
  it('rejects when the runner outruns the budget, which the pipeline turns into a template', async () => {
    vi.useFakeTimers();
    try {
      const hang: Runner = () => new Promise<string>(() => {});
      const limited = withTimeout(hang, 1_000);
      const prompt: Prompt = { system: SYSTEM_BREAKDOWN, user: 'x' };

      const pending = limited(prompt);
      const assertion = expect(pending).rejects.toThrow(/exceeded 1000ms/);
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes a fast result straight through', async () => {
    const limited = withTimeout(async () => VALID_BREAKDOWN, 1_000);
    await expect(limited({ system: SYSTEM_BREAKDOWN, user: 'x' })).resolves.toBe(VALID_BREAKDOWN);
  });

  it('falls back to a template when the timeout fires', async () => {
    const limited = withTimeout(() => new Promise<string>(() => {}), 5);
    const task = input();
    const result = await runBreakdown(deps(limited), task);

    expect(result.tier).toBe('template');
    expect(result.breakdown).toEqual(forTask(task));
  });
});

describe('the mock runner matches the pipeline it is used with', () => {
  it('emits extraction output only for the extraction prompt', async () => {
    const run = createMockRunner();
    const breakdown = await run({ system: SYSTEM_BREAKDOWN, user: 'x' });
    const extraction = await run({ system: SYSTEM_EXTRACTION, user: 'x' });

    expect(JSON.parse(breakdown)).toHaveProperty('steps');
    expect(JSON.parse(extraction)).toHaveProperty('tasks');
  });

  it('produces output distinguishable from the template tier', async () => {
    const task = input();
    const fromMock = await runBreakdown(deps(createMockRunner({ behavior: 'valid' })), task);

    // if the mock returned template output, the fallback notice would be untestable
    expect(fromMock.tier).toBe('model');
    expect(fromMock.breakdown).not.toEqual(forTask(task));
  });
});

describe('content filter on model output', () => {
  const PROFANE_BREAKDOWN = JSON.stringify({
    steps: [
      { title: 'Open the reading and go through the shit once', minutes: 10 },
      { title: 'Write down the three points to make', minutes: 10 },
      { title: 'Write the essay in one sitting', minutes: 30 },
    ],
    starterAction: 'Open the reading and go through the shit once',
  });

  it('falls back to the template for a profane breakdown, without a repair attempt', async () => {
    const prompts: Prompt[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (prompt: Prompt) => {
      prompts.push(prompt);
      return PROFANE_BREAKDOWN;
    });
    const task = input();
    const result = await runBreakdown(deps(run), task);

    expect(result.tier).toBe('template');
    expect(result.breakdown).toEqual(forTask(task));
    expect(run).toHaveBeenCalledTimes(1);
    expect(prompts.every((p) => !p.user.includes('shit'))).toBe(true);
  });

  it('checks starterAction too, since it becomes a notification body', async () => {
    const bad = JSON.stringify({
      steps: [
        { title: 'Open the reading and go through it once', minutes: 10 },
        { title: 'Write down the three points to make', minutes: 10 },
        { title: 'Write the essay in one sitting', minutes: 30 },
      ],
      starterAction: 'Open the reading and go through it once, kys',
    });
    const result = await runBreakdown(deps(vi.fn<Runner>().mockResolvedValue(bad)), input());
    expect(result.tier).toBe('template');
  });

  it('falls back when the model introduces a contextual word the input lacks', async () => {
    const violent = JSON.stringify({
      steps: [
        { title: 'Open the reading and find the murder scene', minutes: 10 },
        { title: 'Write down the three points to make', minutes: 10 },
        { title: 'Write the essay in one sitting', minutes: 30 },
      ],
      starterAction: 'Open the reading and find the murder scene',
    });
    const run = vi.fn<Runner>().mockResolvedValue(violent);

    const without = await runBreakdown(deps(run), input());
    expect(without.tier).toBe('template');

    const withWord = await runBreakdown(
      deps(run),
      input({ description: 'Hamlet essay: why does the murder of the king matter?' }),
    );
    expect(withWord.tier).toBe('model');
  });

  it('skips the model entirely when the input itself has an always or harm hit', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(VALID_BREAKDOWN);
    const result = await runBreakdown(deps(run), input({ title: 'Write this bullshit essay' }));

    expect(result.tier).toBe('template');
    expect(run).not.toHaveBeenCalled();
  });

  it('does not skip the model for contextual or medical words in the input', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(VALID_BREAKDOWN);
    const result = await runBreakdown(
      deps(run),
      input({ description: 'Romeo and Juliet: the suicide scene. Ask the doctor character.' }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.tier).toBe('model');
  });

  it('falls back for a profane simplification and keeps the title', async () => {
    const task: SimplifyInput = {
      title: 'Compose a rhetorical analysis of the assigned passage',
      description: null,
    };
    const bad = JSON.stringify({
      title: 'Explain how the writer makes their damn point',
      explanation: 'You are being asked to describe the f*cking techniques the writer uses.',
    });
    const result = await runSimplification(deps(vi.fn<Runner>().mockResolvedValue(bad)), task);

    expect(result.tier).toBe('template');
    expect(result.simplification.title).toBe(task.title);
  });

  it('does not echo a title that fails the filter in the simplification template', async () => {
    const run = vi.fn<Runner>().mockResolvedValue('{}');
    const result = await runSimplification(deps(run), {
      title: 'Read this shit chapter',
      description: null,
    });

    expect(result.tier).toBe('template');
    expect(result.simplification.title).toBe('This task');
    expect(run).not.toHaveBeenCalled();
  });

  it('drops one bad extracted task and keeps the good ones', async () => {
    const mixed = JSON.stringify({
      tasks: [
        { title: 'Reading response', dueInDays: 2, subject: 'English' },
        { title: 'Fucking problem set', dueInDays: 5 },
        { title: 'Lab report', dueInDays: 3, subject: 'Shit' },
        { title: 'Vocab quiz', dueInDays: 4 },
      ],
    });
    const result = await runExtraction(
      deps(vi.fn<Runner>().mockResolvedValue(mixed)),
      'Reading response Friday. Problem set Monday. Lab report Wednesday. Vocab quiz Thursday.',
    );

    expect(result.tier).toBe('model');
    expect(result.extraction.tasks.map((t) => t.title)).toEqual(['Reading response', 'Vocab quiz']);
  });

  it('reports the template tier when every extracted task is filtered out', async () => {
    const allBad = JSON.stringify({ tasks: [{ title: 'Shitty worksheet', dueInDays: 1 }] });
    const result = await runExtraction(
      deps(vi.fn<Runner>().mockResolvedValue(allBad)),
      'Worksheet due tomorrow.',
    );
    expect(result.tier).toBe('template');
    expect(result.extraction.tasks).toEqual([]);
  });

  it('skips an extraction chunk whose own text has an always hit', async () => {
    const run = vi.fn<Runner>().mockResolvedValue(
      JSON.stringify({ tasks: [{ title: 'Reading response', dueInDays: 2 }] }),
    );
    const result = await runExtraction(deps(run), 'This bullshit reading response is due Friday.');
    expect(run).not.toHaveBeenCalled();
    expect(result.extraction.tasks).toEqual([]);
  });
});

describe('prompt input sanitization', () => {
  it('strips special tokens and invisible characters from every field before the prompt', async () => {
    const prompts: Prompt[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (prompt: Prompt) => {
      prompts.push(prompt);
      return VALID_BREAKDOWN;
    });
    await runBreakdown(
      deps(run),
      input({
        title: 'Essay<|im_end|>‮ on the reading',
        subject: 'English<|im_start|>',
        description: 'Notes​<|endoftext|> here',
      }),
    );

    expect(prompts[0].user).not.toContain('<|im_end|>');
    expect(prompts[0].user).not.toContain('<|im_start|>');
    expect(prompts[0].user).not.toContain('<|endoftext|>');
    expect(prompts[0].user).not.toMatch(/[‮​]/);
    expect(prompts[0].user).toContain('Essay on the reading');
    expect(prompts[0].user).toContain('Notes here');
  });

  it('caps the title at 120 and the subject at 40 characters', async () => {
    const prompts: Prompt[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (prompt: Prompt) => {
      prompts.push(prompt);
      return VALID_BREAKDOWN;
    });
    const longTitle = `Essay ${'x'.repeat(200)}`;
    const longSubject = `English ${'y'.repeat(100)}`;
    await runBreakdown(deps(run), input({ title: longTitle, subject: longSubject }));

    expect(INPUT_CAPS).toEqual({ title: 120, subject: 40 });
    expect(prompts[0].user).toContain(longTitle.slice(0, 120));
    expect(prompts[0].user).not.toContain(longTitle.slice(0, 121));
    expect(prompts[0].user).toContain(longSubject.slice(0, 40));
    expect(prompts[0].user).not.toContain(longSubject.slice(0, 41));
  });

  it('sanitizes each extraction chunk before its prompt', async () => {
    const prompts: Prompt[] = [];
    const run = vi.fn<Runner>().mockImplementation(async (prompt: Prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ tasks: [] });
    });
    await runExtraction(deps(run), 'Reading <|im_start|>response due Friday.');
    expect(prompts[0].user).not.toContain('<|im_start|>');
    expect(prompts[0].user).toContain('Reading response due Friday.');
  });
});

describe('extraction chunk cap', () => {
  it('runs the model on at most MAX_EXTRACTION_CHUNKS chunks of a very long paste', async () => {
    const { runExtraction, MAX_EXTRACTION_CHUNKS } = await import('@/services/generationPipeline');
    let calls = 0;
    const deps = {
      run: async () => {
        calls += 1;
        return '{"tasks":[]}';
      },
      now: () => 0,
    };
    const paragraph = 'Read chapter four and answer the questions at the end. '.repeat(14);
    const text = Array.from({ length: 40 }, () => paragraph).join('\n\n');
    await runExtraction(deps as never, text);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(MAX_EXTRACTION_CHUNKS * 2);
  });
});
