import { describe, expect, it, vi } from 'vitest';

import { MemoryRepository } from '@/data/memoryRepository';
import { DEFAULT_SETTINGS } from '@/data/migrations';
import { WriteQueue } from '@/data/writeQueue';
import { GenerationCancelled, isCancellation } from '@/services/generationPipeline';
import { createGenerationStore } from '@/store/generationStore';
import { createSchedulingStore } from '@/store/schedulingStore';
import { createSettingsStore } from '@/store/settingsStore';
import { createTaskStore, type StoreDeps } from '@/store/taskStore';
import type { BreakdownResult, ExtractionResult, SimplifyResult } from '@/types';

const NOW = new Date(2026, 8, 7, 9, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const STEPS = [
  { title: 'Open the reading and go through it once', minutes: 10 },
  { title: 'Write down the three points to make', minutes: 10 },
  { title: 'Write the essay in one sitting', minutes: 30 },
];

const RESULT: BreakdownResult = {
  breakdown: { steps: STEPS, starterAction: STEPS[0].title },
  tier: 'model',
  latencyMs: 10,
};

// each call stays pending until the test settles it
function deferredGenerate() {
  const pending: { resolve: (r: BreakdownResult) => void; reject: (e: unknown) => void }[] = [];
  const generate = vi.fn<NonNullable<StoreDeps['generate']>>(
    () => new Promise<BreakdownResult>((resolve, reject) => pending.push({ resolve, reject })),
  );
  return { generate, pending };
}

function harness(extra: Partial<StoreDeps> = {}) {
  const repository = new MemoryRepository();
  const queue = new WriteQueue(repository, { debounceMs: 0 });
  let clock = NOW.getTime();
  let counter = 0;
  const base = {
    queue,
    now: () => {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    newId: () => `id-${String(counter++).padStart(4, '0')}`,
  };
  const settings = createSettingsStore(base, { ...DEFAULT_SETTINGS, typicalSessionMinutes: 30 });
  const scheduling = createSchedulingStore(base, []);
  const generation = createGenerationStore();
  const cancelGeneration = vi.fn<NonNullable<StoreDeps['cancelGeneration']>>();
  const tasks = createTaskStore(
    {
      ...base,
      settingsStore: { getState: settings.getState },
      schedulingStore: { getState: scheduling.getState },
      sessionStore: { getState: () => ({ sessions: [] }) },
      generationStore: { getState: () => generation.getState() },
      generate: () => Promise.resolve(RESULT),
      cancelGeneration,
      isCancellation,
      duePhraseFor: () => 'in 3 days',
      ...extra,
    },
    [],
  );
  const addTask = (title = 'Write a 5-paragraph essay on the reading'): string =>
    tasks.getState().addTask({
      title,
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
      durationMinutes: 30,
    });
  const task = (id: string) => tasks.getState().tasks.find((t) => t.id === id)!;
  return { tasks, generation, cancelGeneration, addTask, task };
}

describe('breakdown resolves whether it applied', () => {
  it('resolves true when steps were written', async () => {
    const h = harness();
    const id = h.addTask();
    await expect(h.tasks.getState().breakdown(id)).resolves.toBe(true);
  });

  it('resolves false for the duplicate request while one is in flight', async () => {
    const { generate, pending } = deferredGenerate();
    const h = harness({ generate });
    const id = h.addTask();

    const first = h.tasks.getState().breakdown(id);
    await expect(h.tasks.getState().breakdown(id)).resolves.toBe(false);
    pending[0].resolve(RESULT);
    await expect(first).resolves.toBe(true);
  });

  it('resolves false when cancelled', async () => {
    const { generate, pending } = deferredGenerate();
    const h = harness({ generate });
    const id = h.addTask();

    const run = h.tasks.getState().breakdown(id);
    h.tasks.getState().cancelBreakdown(id);
    pending[0].resolve(RESULT);
    await expect(run).resolves.toBe(false);
  });
});

describe('undoBreakdown is scoped to one task', () => {
  it('does not revert task A when called from task B', async () => {
    const h = harness();
    const a = h.addTask('Task A');
    const b = h.addTask('Task B');
    await h.tasks.getState().breakdown(a);
    await h.tasks.getState().breakdown(a); // re-breakdown, so lastBreakdown belongs to A
    const aSteps = h.task(a).subtasks;
    expect(h.tasks.getState().lastBreakdown?.taskId).toBe(a);

    h.tasks.getState().undoBreakdown(b);

    expect(h.task(a).subtasks).toBe(aSteps);
    expect(h.tasks.getState().lastBreakdown?.taskId).toBe(a);
  });

  it('restores the task it belongs to', async () => {
    const h = harness();
    const a = h.addTask();
    await h.tasks.getState().breakdown(a);
    const firstSteps = h.task(a).subtasks;
    await h.tasks.getState().breakdown(a);

    h.tasks.getState().undoBreakdown(a);

    expect(h.task(a).subtasks).toEqual(firstSteps);
    expect(h.tasks.getState().lastBreakdown).toBeNull();
  });
});

describe('cancel actions for screens that unmount', () => {
  it('cancelPreview aborts the breakdown kind only while a preview runs', async () => {
    const { generate, pending } = deferredGenerate();
    const h = harness({ generate });

    h.tasks.getState().cancelPreview();
    expect(h.cancelGeneration).not.toHaveBeenCalled();

    const preview = h.tasks.getState().previewBreakdown({
      title: 'Essay',
      subject: null,
      description: null,
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
      sessionMinutes: 30,
    });
    h.tasks.getState().cancelPreview();
    expect(h.cancelGeneration).toHaveBeenCalledWith('breakdown');

    pending[0].reject(new GenerationCancelled());
    await expect(preview).resolves.toBeNull();

    h.cancelGeneration.mockClear();
    h.tasks.getState().cancelPreview();
    expect(h.cancelGeneration).not.toHaveBeenCalled();
  });

  it('cancelExtraction aborts the extraction kind only while one runs', async () => {
    let reject: (e: unknown) => void = () => {};
    const h = harness({
      generateExtraction: () => new Promise<ExtractionResult>((_, r) => { reject = r; }),
    });

    h.tasks.getState().cancelExtraction();
    expect(h.cancelGeneration).not.toHaveBeenCalled();

    const run = h.tasks.getState().extractTasks('Essay due Friday.');
    h.tasks.getState().cancelExtraction();
    expect(h.cancelGeneration).toHaveBeenCalledWith('extraction');
    reject(new GenerationCancelled());
    await expect(run).resolves.toBeNull();
  });

  it('cancelSimplification aborts the simplification kind only while one runs', async () => {
    let reject: (e: unknown) => void = () => {};
    const h = harness({
      generateSimplification: () => new Promise<SimplifyResult>((_, r) => { reject = r; }),
    });
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);

    h.tasks.getState().cancelSimplification();
    expect(h.cancelGeneration).not.toHaveBeenCalled();

    const run = h.tasks.getState().simplifySubtask(id, h.task(id).subtasks[0].id);
    h.tasks.getState().cancelSimplification();
    expect(h.cancelGeneration).toHaveBeenCalledWith('simplification');
    reject(new GenerationCancelled());
    await expect(run).resolves.toBeNull();
  });

  it('cancelAllGeneration aborts every kind and clears the breakdown bookkeeping', async () => {
    const { generate, pending } = deferredGenerate();
    const h = harness({ generate });
    const id = h.addTask();
    const run = h.tasks.getState().breakdown(id);
    expect(h.tasks.getState().breakdownInFlight).toEqual([id]);

    h.tasks.getState().cancelAllGeneration();

    expect(h.cancelGeneration).toHaveBeenCalledWith();
    expect(h.tasks.getState().breakdownInFlight).toEqual([]);
    expect(h.tasks.getState().lastBreakdown).toBeNull();
    pending[0].resolve(RESULT);
    await expect(run).resolves.toBe(false);
    expect(h.task(id).subtasks).toEqual([]);
  });
});

describe('applyBreakdownPreview', () => {
  it('saves the steps with their starter action and source', () => {
    const h = harness();
    const id = h.addTask();

    h.tasks.getState().applyBreakdownPreview(id, {
      starterAction: 'Open the reading',
      steps: [
        { title: 'Open the reading', estimatedMinutes: 5 },
        { title: 'Write the first paragraph', estimatedMinutes: 15 },
      ],
      source: 'template',
    });

    const task = h.task(id);
    expect(task.subtasks.map((s) => [s.title, s.order, s.isComplete])).toEqual([
      ['Open the reading', 0, false],
      ['Write the first paragraph', 1, false],
    ]);
    expect(task.starterAction).toBe('Open the reading');
    // the task screen's template note keys off this
    expect(task.breakdownSource).toBe('template');
    expect(task.durationMinutes).toBe(30);
  });

  it('is a no-op for a task that does not exist', () => {
    const h = harness();
    const before = h.tasks.getState().tasks;
    h.tasks.getState().applyBreakdownPreview('missing', { starterAction: 'x', steps: [], source: 'model' });
    expect(h.tasks.getState().tasks).toBe(before);
  });
});

describe('a template simplification that changes nothing', () => {
  it('does not write a title or an originalTitle', async () => {
    const h = harness({
      generateSimplification: (input) =>
        Promise.resolve({
          simplification: { title: input.title, explanation: 'These are the same words as the original.' },
          tier: 'template',
          latencyMs: 1,
        }),
    });
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);
    const subtask = h.task(id).subtasks[0];

    const result = await h.tasks.getState().simplifySubtask(id, subtask.id);

    expect(result?.tier).toBe('template');
    const after = h.task(id).subtasks[0];
    expect(after.title).toBe(subtask.title);
    // so no Restore is offered for a title that never changed
    expect(after.originalTitle).toBeUndefined();
  });
});
