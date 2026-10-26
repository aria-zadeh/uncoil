import { describe, expect, it, vi } from 'vitest';

import { MemoryRepository } from '@/data/memoryRepository';
import { DEFAULT_SETTINGS } from '@/data/migrations';
import { WriteQueue } from '@/data/writeQueue';
import { createMockGeneration, type MockBehavior } from '@/services/generation.mock';
import { GenerationCancelled, isCancellation } from '@/services/generationPipeline';
import { forTask } from '@/services/templates';
import { createGenerationStore } from '@/store/generationStore';
import { createSchedulingStore } from '@/store/schedulingStore';
import { createSettingsStore } from '@/store/settingsStore';
import { proposeForTask } from '@/store/schedulerAdapter';
import { createTaskStore, type StoreDeps } from '@/store/taskStore';
import type { BreakdownInput, BreakdownResult, SimplifyResult } from '@/types';
import { sortSubtasksForDisplay } from '@/utils/subtasks';

// the mock drives the real pipeline, so these run the production validate, repair, template sequence

const NOW = new Date(2026, 8, 7, 9, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function harness(
  options: { behavior?: MockBehavior; generate?: StoreDeps['generate'] } = {},
) {
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
  const mock = createMockGeneration({ behavior: options.behavior ?? 'valid' });

  const tasks = createTaskStore(
    {
      ...base,
      settingsStore: { getState: settings.getState },
      schedulingStore: { getState: scheduling.getState },
      sessionStore: { getState: () => ({ sessions: [] }) },
      generationStore: { getState: () => generation.getState() },
      propose: (context) => proposeForTask(context, NOW),
      generate: options.generate ?? ((input: BreakdownInput) => mock.generateBreakdown(input)),
      generateExtraction: (text: string) => mock.generateExtraction(text),
      generateSimplification: (input) => mock.generateSimplification(input),
      cancelGeneration: () => mock.cancel(),
      isCancellation,
      duePhraseFor: () => 'in 3 days',
    },
    [],
  );

  const addTask = (): string =>
    tasks.getState().addTask({
      title: 'Write a 5-paragraph essay on the reading',
      subject: 'English',
      description: null,
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
      startTime: null,
      durationMinutes: 30,
    });

  return { tasks, settings, scheduling, generation, repository, queue, mock, addTask };
}

const taskById = (h: ReturnType<typeof harness>, id: string) =>
  h.tasks.getState().tasks.find((t) => t.id === id)!;

describe('a breakdown the model answers', () => {
  it('replaces subtasks, sets the starter action and records the tier', async () => {
    const h = harness();
    const id = h.addTask();

    await h.tasks.getState().breakdown(id);
    const task = taskById(h, id);

    expect(task.subtasks.length).toBeGreaterThanOrEqual(3);
    expect(task.starterAction).not.toBeNull();
    expect(task.breakdownSource).toBe('model');
    expect(h.generation.getState().tier).toBe('model');
  });

  it('derives the duration from the steps', async () => {
    const h = harness();
    const id = h.addTask();

    await h.tasks.getState().breakdown(id);
    const task = taskById(h, id);

    expect(task.durationMinutes).toBe(
      task.subtasks.reduce((sum, s) => sum + s.estimatedMinutes, 0),
    );
  });

  it('numbers the subtasks densely from zero', async () => {
    const h = harness();
    const id = h.addTask();

    await h.tasks.getState().breakdown(id);
    expect(taskById(h, id).subtasks.map((s) => s.order)).toEqual(
      taskById(h, id).subtasks.map((_, i) => i),
    );
  });

  it('places a time again, because the duration just changed', async () => {
    const h = harness();
    const id = h.addTask();

    await h.tasks.getState().breakdown(id);
    const task = taskById(h, id);

    expect(task.startTime).not.toBeNull();
    expect(task.scheduleStatus).toBe('auto');
  });

  it('persists through the repository', async () => {
    const h = harness();
    const id = h.addTask();

    await h.tasks.getState().breakdown(id);
    await h.queue.flush();

    const stored = await h.repository.load<{ id: string; subtasks: unknown[] }[]>('tether:v1:tasks');
    expect(stored?.find((t) => t.id === id)?.subtasks.length).toBeGreaterThanOrEqual(3);
  });

  it('replaces an earlier breakdown instead of stacking a second one', async () => {
    const h = harness();
    const id = h.addTask();

    await h.tasks.getState().breakdown(id);
    const first = taskById(h, id).subtasks.length;
    await h.tasks.getState().breakdown(id);

    expect(taskById(h, id).subtasks).toHaveLength(first);
  });
});

describe('a breakdown that needs a repair', () => {
  it('still lands as model output, with the user seeing no sign of it', async () => {
    const h = harness({ behavior: 'repair' });
    const id = h.addTask();

    await h.tasks.getState().breakdown(id);
    const task = taskById(h, id);

    expect(task.breakdownSource).toBe('model');
    expect(task.subtasks.length).toBeGreaterThanOrEqual(3);
    expect(h.mock.callCount()).toBe(2);
  });
});

describe('a breakdown the model cannot produce', () => {
  it('falls back to the template tier and is still usable', async () => {
    const h = harness({ behavior: 'invalid' });
    const id = h.addTask();

    await h.tasks.getState().breakdown(id);
    const task = taskById(h, id);

    expect(task.breakdownSource).toBe('template');
    expect(task.subtasks.map((s) => s.title)).toEqual(
      forTask({
        title: task.title,
        subject: task.subject,
        description: task.description,
        duePhrase: 'in 3 days',
        sessionMinutes: 30,
      }).steps.map((s) => s.title),
    );
    expect(h.generation.getState().tier).toBe('template');
  });

  it('does the same when the runtime fails outright', async () => {
    const h = harness({ behavior: 'error' });
    const id = h.addTask();

    await h.tasks.getState().breakdown(id);
    expect(taskById(h, id).breakdownSource).toBe('template');
  });
});

describe('in-flight state', () => {
  it('is set while generating and cleared afterwards', async () => {
    let release: (value: BreakdownResult) => void = () => {};
    const h = harness({
      generate: () => new Promise<BreakdownResult>((resolve) => { release = resolve; }),
    });
    const id = h.addTask();

    const pending = h.tasks.getState().breakdown(id);
    expect(h.tasks.getState().breakdownInFlight).toContain(id);

    release({
      breakdown: {
        steps: [
          { title: 'Open the reading and go through it once', minutes: 10 },
          { title: 'Write down the three points to make', minutes: 10 },
          { title: 'Write the essay in one sitting', minutes: 30 },
        ],
        starterAction: 'Open the reading and go through it once',
      },
      tier: 'model',
      latencyMs: 10,
    });
    await pending;

    expect(h.tasks.getState().breakdownInFlight).not.toContain(id);
  });

  it('ignores a second request for the same task while one is in flight', async () => {
    const generate = vi.fn<NonNullable<StoreDeps['generate']>>(
      () => new Promise<BreakdownResult>(() => {}),
    );
    const h = harness({ generate });
    const id = h.addTask();

    void h.tasks.getState().breakdown(id);
    void h.tasks.getState().breakdown(id);

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('is cleared when a failure is reported, so the spinner cannot stick', async () => {
    const h = harness({ behavior: 'error' });
    const id = h.addTask();

    await h.tasks.getState().breakdown(id);
    expect(h.tasks.getState().breakdownInFlight).toEqual([]);
  });
});

describe('cancellation', () => {
  it('leaves the task exactly as it was', async () => {
    const h = harness({
      generate: () => Promise.reject(new GenerationCancelled()),
    });
    const id = h.addTask();
    const before = taskById(h, id);

    await h.tasks.getState().breakdown(id);
    const after = taskById(h, id);

    expect(after).toEqual(before);
    expect(h.tasks.getState().breakdownInFlight).toEqual([]);
    expect(h.generation.getState().lastFailureReason).toBeNull();
  });

  it('drops a result that arrives after the user cancelled', async () => {
    let release: (value: BreakdownResult) => void = () => {};
    const h = harness({
      generate: () => new Promise<BreakdownResult>((resolve) => { release = resolve; }),
    });
    const id = h.addTask();

    const pending = h.tasks.getState().breakdown(id);
    h.tasks.getState().cancelBreakdown(id);
    release({
      breakdown: {
        steps: [
          { title: 'Open the reading and go through it once', minutes: 10 },
          { title: 'Write down the three points to make', minutes: 10 },
          { title: 'Write the essay in one sitting', minutes: 30 },
        ],
        starterAction: 'Open the reading and go through it once',
      },
      tier: 'model',
      latencyMs: 10,
    });
    await pending;

    expect(taskById(h, id).subtasks).toEqual([]);
    expect(taskById(h, id).breakdownSource).toBeNull();
  });
});

describe('a task deleted mid-generation', () => {
  it('is not resurrected by the result', async () => {
    let release: (value: BreakdownResult) => void = () => {};
    const h = harness({
      generate: () => new Promise<BreakdownResult>((resolve) => { release = resolve; }),
    });
    const id = h.addTask();

    const pending = h.tasks.getState().breakdown(id);
    h.tasks.getState().deleteTask(id);
    release({
      breakdown: {
        steps: [
          { title: 'Open the reading and go through it once', minutes: 10 },
          { title: 'Write down the three points to make', minutes: 10 },
          { title: 'Write the essay in one sitting', minutes: 30 },
        ],
        starterAction: 'Open the reading and go through it once',
      },
      tier: 'model',
      latencyMs: 10,
    });
    await pending;

    expect(h.tasks.getState().tasks.find((t) => t.id === id)).toBeUndefined();
  });
});

describe('with no generation dependency injected', () => {
  it('does nothing rather than throwing', async () => {
    const h = harness({ generate: undefined });
    const id = h.addTask();
    // the harness defaults generate to the mock, so build a store without it
    const bare = createTaskStore(
      {
        queue: h.queue,
        now: () => NOW.toISOString(),
        newId: () => 'x',
        settingsStore: { getState: h.settings.getState },
        schedulingStore: { getState: h.scheduling.getState },
        sessionStore: { getState: () => ({ sessions: [] }) },
      },
      h.tasks.getState().tasks,
    );

    // false means nothing applied, so the screen offers no Undo
    await expect(bare.getState().breakdown(id)).resolves.toBe(false);
    expect(bare.getState().tasks.find((t) => t.id === id)?.subtasks).toEqual([]);
  });
});

describe('previewBreakdown', () => {
  it('returns steps without creating or touching a task', async () => {
    const h = harness();
    const before = h.tasks.getState().tasks.length;

    const result = await h.tasks.getState().previewBreakdown({
      title: 'Write a 5-paragraph essay on the reading',
      subject: 'English',
      description: null,
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
      sessionMinutes: 30,
    });

    expect(result?.breakdown.steps.length).toBeGreaterThanOrEqual(3);
    // /task/new previews steps before the task is saved
    expect(h.tasks.getState().tasks).toHaveLength(before);
  });


  it('converts the due date to a relative phrase, so the screen never has to', async () => {
    // screens may not import services/, so they pass the date and the store converts it.
    // absolute dates never reach the model
    let seen: BreakdownInput | null = null;
    const h = harness({
      generate: async (input) => {
        seen = input;
        return {
          breakdown: {
            steps: [
              { title: 'Open the reading and go through it once', minutes: 10 },
              { title: 'Write down the three points to make', minutes: 10 },
              { title: 'Write the essay in one sitting', minutes: 30 },
            ],
            starterAction: 'Open the reading and go through it once',
          },
          tier: 'model' as const,
          latencyMs: 1,
        };
      },
    });

    await h.tasks.getState().previewBreakdown({
      title: 'Anything',
      subject: null,
      description: null,
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
      sessionMinutes: 30,
    });

    const iso = new Date(NOW.getTime() + 5 * DAY).toISOString();
    expect(seen).not.toBeNull();
    expect(seen!.duePhrase).toBe('in 3 days');
    expect(seen!).not.toHaveProperty('dueDate');
    expect(JSON.stringify(seen)).not.toContain(iso);
    expect(JSON.stringify(seen)).not.toContain(iso.slice(0, 10));
  });

  it('resolves null when cancelled', async () => {
    const h = harness({ generate: () => Promise.reject(new GenerationCancelled()) });
    const result = await h.tasks.getState().previewBreakdown({
      title: 'Anything',
      subject: null,
      description: null,
      dueDate: new Date(NOW.getTime() + 5 * DAY).toISOString(),
      sessionMinutes: 30,
    });
    expect(result).toBeNull();
  });
});

describe('extractTasks', () => {
  it('returns candidates rather than creating tasks', async () => {
    const h = harness();
    const before = h.tasks.getState().tasks.length;

    const result = await h.tasks.getState().extractTasks('Reading response Friday. Problem set Monday.');

    expect(result?.extraction.tasks.length).toBeGreaterThan(0);
    // one paste can yield many tasks, so the modal confirms them before any are created
    expect(h.tasks.getState().tasks).toHaveLength(before);
  });

  it('reports nothing found rather than inventing tasks', async () => {
    const h = harness({ behavior: 'error' });
    const result = await h.tasks.getState().extractTasks('See you all on Monday.');
    expect(result?.extraction.tasks).toEqual([]);
  });

  it('resolves null on cancellation, distinct from a real failure', async () => {
    // a real failure resolves a template result with an empty list, so null only means cancel.
    // app/task/new.tsx relies on that to skip the "couldn't find any tasks" error
    const h = harness();
    const bare = createTaskStore(
      {
        queue: h.queue,
        now: () => NOW.toISOString(),
        newId: () => 'x',
        settingsStore: { getState: h.settings.getState },
        schedulingStore: { getState: h.scheduling.getState },
        sessionStore: { getState: () => ({ sessions: [] }) },
        generateExtraction: () => Promise.reject(new GenerationCancelled()),
        isCancellation,
        generationStore: { getState: () => h.generation.getState() },
      },
      h.tasks.getState().tasks,
    );

    const result = await bare.getState().extractTasks('Reading response Friday.');

    expect(result).toBeNull();
    expect(h.generation.getState().lastFailureReason).toBeNull();
  });
});

describe('sortSubtasksForDisplay against real store data', () => {
  // screens feed task.subtasks straight from the store into this helper, so the store's own
  // array must survive unmutated
  it('leaves the store array and its order untouched after producing a sorted copy', async () => {
    const h = harness();
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);

    const before = taskById(h, id).subtasks;
    const beforeIds = before.map((s) => s.id);
    const expectedAscendingIds = [...before]
      .sort((a, b) => a.order - b.order)
      .map((s) => s.id);

    const sorted = sortSubtasksForDisplay(before);

    expect(sorted.map((s) => s.id)).toEqual(expectedAscendingIds);
    expect(taskById(h, id).subtasks).toBe(before);
    expect(taskById(h, id).subtasks.map((s) => s.id)).toEqual(beforeIds);
  });
});

describe('simplifySubtask', () => {
  it('rewrites the subtask title in place and returns the explanation', async () => {
    const h = harness();
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);

    const subtask = taskById(h, id).subtasks[0];
    const before = subtask.title;
    const result = await h.tasks.getState().simplifySubtask(id, subtask.id);

    expect(result).not.toBeNull();
    expect(result!.simplification.explanation.length).toBeGreaterThanOrEqual(20);
    expect(taskById(h, id).subtasks[0].title).not.toBe(before);
    expect(taskById(h, id).subtasks[0].title).toBe(result!.simplification.title);
  });

  it('leaves the other subtasks alone', async () => {
    const h = harness();
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);

    const others = taskById(h, id).subtasks.slice(1).map((s) => s.title);
    await h.tasks.getState().simplifySubtask(id, taskById(h, id).subtasks[0].id);

    expect(taskById(h, id).subtasks.slice(1).map((s) => s.title)).toEqual(others);
  });

  it('returns null for a subtask that does not exist', async () => {
    const h = harness();
    const id = h.addTask();
    await expect(h.tasks.getState().simplifySubtask(id, 'missing')).resolves.toBeNull();
  });

  it('does not write a title back onto a subtask deleted mid-generation', async () => {
    let release: (value: SimplifyResult) => void = () => {};
    const h = harness();
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);
    const subtaskId = taskById(h, id).subtasks[0].id;

    const bare = createTaskStore(
      {
        queue: h.queue,
        now: () => NOW.toISOString(),
        newId: () => 'x',
        settingsStore: { getState: h.settings.getState },
        schedulingStore: { getState: h.scheduling.getState },
        sessionStore: { getState: () => ({ sessions: [] }) },
        generateSimplification: () => new Promise<SimplifyResult>((resolve) => { release = resolve; }),
      },
      h.tasks.getState().tasks,
    );

    const pending = bare.getState().simplifySubtask(id, subtaskId);
    bare.getState().deleteSubtask(id, subtaskId);
    release({
      simplification: { title: 'A plainer title', explanation: 'This says the same thing in simpler words for you.' },
      tier: 'model',
      latencyMs: 5,
    });
    await pending;

    expect(bare.getState().tasks.find((t) => t.id === id)!.subtasks.some((s) => s.id === subtaskId)).toBe(false);
  });

  it('records the pre-simplification title as originalTitle', async () => {
    const h = harness();
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);

    const subtask = taskById(h, id).subtasks[0];
    const before = subtask.title;
    await h.tasks.getState().simplifySubtask(id, subtask.id);

    expect(taskById(h, id).subtasks[0].originalTitle).toBe(before);
  });

  it('keeps the first originalTitle when simplified a second time', async () => {
    const h = harness();
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);

    const subtaskId = taskById(h, id).subtasks[0].id;
    const veryFirstTitle = taskById(h, id).subtasks[0].title;

    await h.tasks.getState().simplifySubtask(id, subtaskId);
    const afterFirst = taskById(h, id).subtasks[0];
    expect(afterFirst.originalTitle).toBe(veryFirstTitle);

    // a second simplify must not replace the true original with the already-simplified wording
    expect(afterFirst.title).not.toBe(veryFirstTitle);
    await h.tasks.getState().simplifySubtask(id, subtaskId);
    const afterSecond = taskById(h, id).subtasks[0];
    expect(afterSecond.originalTitle).toBe(veryFirstTitle);
  });
});

describe('restoreSubtask', () => {
  it('puts the original title back and clears originalTitle', async () => {
    const h = harness();
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);

    const subtaskId = taskById(h, id).subtasks[0].id;
    const original = taskById(h, id).subtasks[0].title;

    await h.tasks.getState().simplifySubtask(id, subtaskId);
    expect(taskById(h, id).subtasks[0].title).not.toBe(original);

    h.tasks.getState().restoreSubtask(id, subtaskId);

    const restored = taskById(h, id).subtasks[0];
    expect(restored.title).toBe(original);
    expect(restored.originalTitle).toBeUndefined();
  });

  it('round-trips through simplify then restore', async () => {
    const h = harness();
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);

    const subtaskId = taskById(h, id).subtasks[0].id;
    const original = taskById(h, id).subtasks[0].title;

    await h.tasks.getState().simplifySubtask(id, subtaskId);
    h.tasks.getState().restoreSubtask(id, subtaskId);

    expect(taskById(h, id).subtasks[0]).toMatchObject({ title: original, originalTitle: undefined });
  });

  it('is a no-op on a subtask that was never simplified', async () => {
    const h = harness();
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);

    const before = taskById(h, id);
    h.tasks.getState().restoreSubtask(id, before.subtasks[0].id);

    expect(taskById(h, id)).toEqual(before);
  });

  it('is a no-op for a task or subtask that does not exist', () => {
    const h = harness();
    const id = h.addTask();
    const before = taskById(h, id);

    h.tasks.getState().restoreSubtask('missing-task', 'missing-subtask');
    h.tasks.getState().restoreSubtask(id, 'missing-subtask');

    expect(taskById(h, id)).toEqual(before);
  });

  it('persists the cleared field through the repository', async () => {
    const h = harness();
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);
    const subtaskId = taskById(h, id).subtasks[0].id;

    await h.tasks.getState().simplifySubtask(id, subtaskId);
    h.tasks.getState().restoreSubtask(id, subtaskId);
    await h.queue.flush();

    const stored = await h.repository.load<{ id: string; subtasks: { id: string; originalTitle?: string }[] }[]>(
      'tether:v1:tasks',
    );
    const storedSubtask = stored?.find((t) => t.id === id)?.subtasks.find((s) => s.id === subtaskId);
    expect(storedSubtask?.originalTitle).toBeUndefined();
  });

  it('persists originalTitle after a simplification, before any restore', async () => {
    const h = harness();
    const id = h.addTask();
    await h.tasks.getState().breakdown(id);
    const subtaskId = taskById(h, id).subtasks[0].id;
    const original = taskById(h, id).subtasks[0].title;

    await h.tasks.getState().simplifySubtask(id, subtaskId);
    await h.queue.flush();

    const stored = await h.repository.load<{ id: string; subtasks: { id: string; originalTitle?: string }[] }[]>(
      'tether:v1:tasks',
    );
    const storedSubtask = stored?.find((t) => t.id === id)?.subtasks.find((s) => s.id === subtaskId);
    expect(storedSubtask?.originalTitle).toBe(original);
  });
});
