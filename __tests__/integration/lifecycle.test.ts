import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '@/data/keys';
import { MemoryRepository } from '@/data/memoryRepository';
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS } from '@/data/migrations';
import { hydrate } from '@/data/hydrate';
import { WriteQueue } from '@/data/writeQueue';
import { highestPriorityTask, currentStreak } from '@/services/insights';
import { buildHistory, proposeSlot, scoreSlot } from '@/services/scheduler';
import { forTask } from '@/services/templates';
import { createSchedulingStore } from '@/store/schedulingStore';
import { createSessionStore } from '@/store/sessionStore';
import { createSettingsStore } from '@/store/settingsStore';
import { createTaskStore } from '@/store/taskStore';
import type { DayOfWeek, Task, UserSettings } from '@/types';

const NOW = new Date(2026, 8, 7, 9, 0, 0, 0);

function deterministicDeps(repository: MemoryRepository) {
  let clock = NOW.getTime();
  let counter = 0;
  const queue = new WriteQueue(repository, { debounceMs: 0 });
  return {
    queue,
    now: () => {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    newId: () => `id-${String(counter++).padStart(4, '0')}`,
  };
}

function buildStores(repository = new MemoryRepository()) {
  const base = deterministicDeps(repository);
  const settings = createSettingsStore(base, { ...DEFAULT_SETTINGS, onboardingComplete: true });
  const scheduling = createSchedulingStore(base, []);
  const tasks = createTaskStore(
    {
      ...base,
      settingsStore: { getState: settings.getState },
      schedulingStore: { getState: scheduling.getState },
      sessionStore: { getState: () => ({ sessions: [] }) },
      propose: ({ task, allTasks, settings: s, signals }) => {
        const slot = proposeSlot({
          task,
          otherTasks: allTasks.filter((t) => t.id !== task.id),
          settings: s as UserSettings,
          signals,
          now: NOW,
        });
        return slot === null ? null : { startTime: slot.startIso };
      },
    },
    [],
  );
  const sessions = createSessionStore(
    { ...base, taskStore: { getState: tasks.getState }, schedulingStore: { getState: scheduling.getState } },
    [],
  );
  return { repository, queue: base.queue, settings, scheduling, tasks, sessions };
}

describe('task lifecycle through the repository', () => {
  let ctx: ReturnType<typeof buildStores>;

  beforeEach(() => {
    ctx = buildStores();
  });

  it('creates a task and persists it', async () => {
    const id = ctx.tasks.getState().addTask({
      title: 'Write a 5-paragraph essay on The Great Gatsby',
      dueDate: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(),
      subject: 'English 2H',
    });

    // state updates synchronously so saving feels instant
    expect(ctx.tasks.getState().tasks).toHaveLength(1);
    expect(ctx.tasks.getState().tasks[0].id).toBe(id);

    await ctx.queue.flush();
    const stored = JSON.parse(ctx.repository.raw()[STORAGE_KEYS.tasks]) as Task[];
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('Write a 5-paragraph essay on The Great Gatsby');
  });

  it('round-trips through hydrate, so what is written is what is read', async () => {
    ctx.tasks.getState().addTask({ title: 'Chapter 4 notes', dueDate: NOW.toISOString() });
    ctx.settings.getState().updateSetting('displayName', 'Sam');
    await ctx.queue.flush();

    // stamp meta so hydrate treats this as a current install, not one to migrate
    await ctx.repository.save(STORAGE_KEYS.meta, {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      lastRescheduleAt: null,
      installedAt: NOW.toISOString(),
    });

    const hydrated = await hydrate(ctx.repository);
    expect(hydrated.tasks).toHaveLength(1);
    expect(hydrated.tasks[0].title).toBe('Chapter 4 notes');
    expect(hydrated.settings.displayName).toBe('Sam');
    expect(hydrated.migrated).toBe(false);
  });

  it('adds a breakdown, keeps order dense, and derives parent status', async () => {
    const id = ctx.tasks.getState().addTask({
      title: 'Write an essay on the Bill of Rights',
      dueDate: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(),
    });

    const breakdown = forTask({
      title: 'Write an essay on the Bill of Rights',
      subject: null,
      description: null,
      duePhrase: 'in 3 days',
      sessionMinutes: 30,
    });
    ctx.tasks.getState().addSubtasks(
      id,
      breakdown.steps.map((s) => ({ title: s.title, estimatedMinutes: s.minutes })),
    );

    const task = () => ctx.tasks.getState().tasks.find((t) => t.id === id)!;
    expect(task().subtasks.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(task().status).toBe('not_started');

    ctx.tasks.getState().toggleSubtask(id, task().subtasks[0].id);
    expect(task().status).toBe('in_progress');

    for (const subtask of task().subtasks.filter((s) => !s.isComplete)) {
      ctx.tasks.getState().toggleSubtask(id, subtask.id);
    }
    expect(task().status).toBe('complete');
  });

  it('keeps order dense after deleting a middle subtask', () => {
    const id = ctx.tasks.getState().addTask({ title: 'Read chapter 4', dueDate: NOW.toISOString() });
    ctx.tasks.getState().addSubtasks(id, [
      { title: 'Open the book to chapter 4', estimatedMinutes: 5 },
      { title: 'Read the first section', estimatedMinutes: 20 },
      { title: 'Write one sentence about it', estimatedMinutes: 5 },
    ]);
    const task = () => ctx.tasks.getState().tasks.find((t) => t.id === id)!;
    ctx.tasks.getState().deleteSubtask(id, task().subtasks[1].id);
    expect(task().subtasks.map((s) => s.order)).toEqual([0, 1]);
  });

  it('places a schedule through the injected scheduler', () => {
    const id = ctx.tasks.getState().addTask({
      title: 'Chapter 7 problem set',
      dueDate: new Date(NOW.getTime() + 4 * 86_400_000).toISOString(),
      durationMinutes: 45,
    });
    ctx.tasks.getState().proposeSchedule(id);
    const task = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
    expect(task.startTime).not.toBeNull();
    expect(task.scheduleStatus).toBe('auto');
    expect(task.proposedTime).toBeNull();
  });

  it('canSchedule reports whether a slot exists before the due date (PRD.md 5.3)', () => {
    const schedulableId = ctx.tasks.getState().addTask({
      title: 'Chapter 8 problem set',
      dueDate: new Date(NOW.getTime() + 4 * 86_400_000).toISOString(),
      durationMinutes: 45,
    });
    expect(ctx.tasks.getState().canSchedule(schedulableId)).toBe(true);

    // due in 5 minutes with a 45-minute task, so no slot can ever end before the deadline
    const impossibleId = ctx.tasks.getState().addTask({
      title: 'Impossible in the time left',
      dueDate: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
      durationMinutes: 45,
    });
    expect(ctx.tasks.getState().canSchedule(impossibleId)).toBe(false);
  });

  it('places the task on the calendar on create when no start time is given (SCHEDULING.md 1)', () => {
    // placed on create, not proposed: a suggestion asks a student already avoiding the task
    // to make one more decision
    const id = ctx.tasks.getState().addTask({
      title: 'Chapter 9 worksheet',
      dueDate: new Date(NOW.getTime() + 4 * 86_400_000).toISOString(),
      durationMinutes: 45,
    });
    const task = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
    expect(task.startTime).not.toBeNull();
    expect(task.scheduleStatus).toBe('auto');
    expect(task.proposedTime).toBeNull();
  });

  it('does not propose a slot on create when a start time is already given', () => {
    const id = ctx.tasks.getState().addTask({
      title: 'Chapter 9 worksheet',
      dueDate: new Date(NOW.getTime() + 4 * 86_400_000).toISOString(),
      startTime: new Date(NOW.getTime() + 2 * 86_400_000).toISOString(),
    });
    const task = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
    expect(task.proposedTime).toBeNull();
    expect(task.scheduleStatus).toBe('unscheduled');
  });

  it("drops a start time that falls after the task's own due date, on create (PRD.md 5.1)", () => {
    const due = new Date(NOW.getTime() + 2 * 86_400_000);
    const badStart = new Date(due.getTime() + 86_400_000);
    const id = ctx.tasks.getState().addTask({
      title: 'Lab report',
      dueDate: due.toISOString(),
      startTime: badStart.toISOString(),
    });
    const task = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
    expect(task.startTime).not.toBe(badStart.toISOString());
    if (task.startTime !== null) {
      expect(new Date(task.startTime).getTime()).toBeLessThanOrEqual(due.getTime());
    }
  });

  it('drops an existing start time when an update pulls the due date in ahead of it', () => {
    const farDue = new Date(NOW.getTime() + 5 * 86_400_000);
    const start = new Date(NOW.getTime() + 3 * 86_400_000);
    const id = ctx.tasks.getState().addTask({
      title: 'Lab report',
      dueDate: farDue.toISOString(),
      startTime: start.toISOString(),
    });
    expect(ctx.tasks.getState().tasks.find((t) => t.id === id)!.startTime).toBe(start.toISOString());

    const earlierDue = new Date(NOW.getTime() + 86_400_000);
    ctx.tasks.getState().updateTask(id, { dueDate: earlierDue.toISOString() });
    const task = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
    expect(task.dueDate).toBe(earlierDue.toISOString());
    expect(task.startTime).toBeNull();
  });

  it('runs a focus session and records it', async () => {
    const id = ctx.tasks.getState().addTask({ title: 'Read chapter 4', dueDate: NOW.toISOString() });
    ctx.sessions.getState().startSession(id, null);
    expect(ctx.sessions.getState().activeSession).not.toBeNull();

    ctx.sessions.getState().startBreak();
    ctx.sessions.getState().endBreak(300);
    ctx.sessions.getState().endSession('completed');

    expect(ctx.sessions.getState().activeSession).toBeNull();
    expect(ctx.sessions.getState().sessions).toHaveLength(1);
    const recorded = ctx.sessions.getState().sessions[0];
    expect(recorded.taskTitleSnapshot).toBe('Read chapter 4');
    expect(recorded.breaksTaken).toBe(1);
    expect(recorded.breakSecondsTotal).toBe(300);
    expect(recorded.endReason).toBe('completed');

    await ctx.queue.flush();
    expect(ctx.repository.raw()[STORAGE_KEYS.sessions]).toBeDefined();
  });

  it(
    "records a scheduling signal for the task's scheduled slot when a session ends, and it actually " +
      'changes what scoreSlot returns (PRD.md 5.5, 5.3)',
    () => {
      const dueDate = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
      const id = ctx.tasks.getState().addTask({ title: 'Chapter 4 notes', dueDate, durationMinutes: 30 });
      // confirmed slot at NOW (Monday 09:00), the weekday and hour the seeded signals use
      ctx.tasks.getState().updateTask(id, { startTime: NOW.toISOString(), scheduleStatus: 'confirmed' });

      // a bucket is judged against this person's own average, so an all-skip history has nothing
      // to fall short of. completions elsewhere set a real average for the skips below to sit under
      for (let i = 0; i < 10; i += 1) {
        ctx.scheduling.getState().addSignal({
          taskId: `baseline-${i}`,
          dayOfWeek: 3 as DayOfWeek,
          hourOfDay: 15,
          outcome: 'completed',
          actualDurationMinutes: 30,
          estimatedDurationMinutes: 30,
        });
      }

      // two earlier skips at the task's own weekday and hour, from other tasks
      ctx.scheduling.getState().addSignal({
        taskId: 'other-1',
        dayOfWeek: NOW.getDay() as DayOfWeek,
        hourOfDay: NOW.getHours(),
        outcome: 'skipped',
        actualDurationMinutes: null,
        estimatedDurationMinutes: 30,
      });
      ctx.scheduling.getState().addSignal({
        taskId: 'other-2',
        dayOfWeek: NOW.getDay() as DayOfWeek,
        hourOfDay: NOW.getHours(),
        outcome: 'skipped',
        actualDurationMinutes: null,
        estimatedDurationMinutes: 30,
      });

      const durationMs = 30 * 60_000;
      const scoreFor = () =>
        scoreSlot(
          NOW.getTime(),
          durationMs,
          {
            task: ctx.tasks.getState().tasks.find((t) => t.id === id)!,
            otherTasks: [],
            settings: ctx.settings.getState(),
            signals: ctx.scheduling.getState().signals,
            now: NOW,
          },
          buildHistory(ctx.scheduling.getState().signals, NOW),
          [],
        );
      const scoreBefore = scoreFor();

      // ending without completing writes a third skip for the task's own slot
      ctx.sessions.getState().startSession(id, null);
      ctx.sessions.getState().endSession('abandoned');

      expect(ctx.scheduling.getState().signals).toHaveLength(13);
      const written = ctx.scheduling.getState().signals[12];
      expect(written.taskId).toBe(id);
      expect(written.dayOfWeek).toBe(NOW.getDay());
      expect(written.hourOfDay).toBe(NOW.getHours());
      expect(written.outcome).toBe('skipped');

      expect(scoreFor()).toBeLessThan(scoreBefore);
    },
  );

  it('records a completed signal when a scheduled task is simply ticked off, with no focus session', () => {
    const dueDate = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
    const id = ctx.tasks.getState().addTask({ title: 'Vocab list', dueDate, durationMinutes: 30 });
    ctx.tasks.getState().updateTask(id, { startTime: NOW.toISOString(), scheduleStatus: 'confirmed' });

    ctx.tasks.getState().completeTask(id);

    const signals = ctx.scheduling.getState().signals.filter((s) => s.taskId === id);
    expect(signals).toHaveLength(1);
    expect(signals[0].outcome).toBe('completed');
    expect(signals[0].dayOfWeek).toBe(NOW.getDay());
    expect(signals[0].hourOfDay).toBe(NOW.getHours());

    // ticking it off again after an undo must not double-count
    ctx.tasks.getState().uncompleteTask(id);
    ctx.tasks.getState().completeTask(id);
    expect(ctx.scheduling.getState().signals.filter((s) => s.taskId === id)).toHaveLength(1);
  });

  it('records nothing when a task with no scheduled or proposed slot is ticked off', () => {
    const dueDate = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
    const id = ctx.tasks.getState().addTask({ title: 'Unscheduled thing', dueDate });
    ctx.tasks.getState().updateTask(id, { startTime: null, proposedTime: null, scheduleStatus: 'unscheduled' });

    ctx.tasks.getState().completeTask(id);

    expect(ctx.scheduling.getState().signals.filter((s) => s.taskId === id)).toHaveLength(0);
  });

  it('does not double-write a signal when the review flow already recorded the same task and slot', () => {
    const dueDate = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
    const id = ctx.tasks.getState().addTask({ title: 'Chapter 4 notes', dueDate });
    ctx.tasks.getState().updateTask(id, { startTime: NOW.toISOString(), scheduleStatus: 'confirmed' });

    // stands in for Review yesterday having already recorded this slot
    ctx.scheduling.getState().addSignal({
      taskId: id,
      dayOfWeek: NOW.getDay() as DayOfWeek,
      hourOfDay: NOW.getHours(),
      outcome: 'completed',
      actualDurationMinutes: 30,
      estimatedDurationMinutes: 30,
    });
    expect(ctx.scheduling.getState().signals).toHaveLength(1);

    ctx.sessions.getState().startSession(id, null);
    ctx.sessions.getState().endSession('completed');

    expect(ctx.scheduling.getState().signals).toHaveLength(1);
  });

  it('records nothing when the session\'s task has no scheduled slot', () => {
    const id = ctx.tasks.getState().addTask({
      title: 'Quick review',
      dueDate: new Date(NOW.getTime() + 86_400_000).toISOString(),
      startTime: null,
    });
    // undo the placement addTask makes so the task truly has no slot
    ctx.tasks.getState().updateTask(id, {
      startTime: null,
      proposedTime: null,
      scheduleStatus: 'unscheduled',
    });

    ctx.sessions.getState().startSession(id, null);
    ctx.sessions.getState().endSession('abandoned');

    expect(ctx.scheduling.getState().signals).toHaveLength(0);
  });

  it('completes a task and can undo it', () => {
    const id = ctx.tasks.getState().addTask({ title: 'Read chapter 4', dueDate: NOW.toISOString() });
    ctx.tasks.getState().completeTask(id);

    const done = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
    expect(done.status).toBe('complete');
    expect(done.completedAt).not.toBeNull();

    ctx.tasks.getState().uncompleteTask(id);
    const undone = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
    expect(undone.status).not.toBe('complete');
    expect(undone.completedAt).toBeNull();
  });

  it('orphans signals on delete rather than dropping them', () => {
    const id = ctx.tasks.getState().addTask({ title: 'Read chapter 4', dueDate: NOW.toISOString() });
    ctx.scheduling.getState().addSignal({
      taskId: id,
      dayOfWeek: 1,
      hourOfDay: 15,
      outcome: 'completed',
      actualDurationMinutes: 45,
      estimatedDurationMinutes: 30,
    });

    ctx.tasks.getState().deleteTask(id);

    expect(ctx.tasks.getState().tasks).toHaveLength(0);
    expect(ctx.scheduling.getState().signals).toHaveLength(1);
    expect(ctx.scheduling.getState().signals[0].taskId).toBeNull();
  });

  it('feeds insights from the same state the stores hold', () => {
    const id = ctx.tasks.getState().addTask({
      title: 'Overdue thing',
      dueDate: new Date(NOW.getTime() - 86_400_000).toISOString(),
    });
    ctx.tasks.getState().addTask({
      title: 'Later thing',
      dueDate: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(),
    });

    expect(highestPriorityTask(ctx.tasks.getState().tasks, NOW)!.id).toBe(id);

    ctx.tasks.getState().completeTask(id);
    expect(currentStreak(ctx.tasks.getState().tasks, NOW)).toBeGreaterThanOrEqual(1);
  });

    it('converts a legacy proposal into a real placement on the first sweep', () => {
      const id = ctx.tasks.getState().addTask({
        title: 'Chapter 9 worksheet',
        dueDate: new Date(NOW.getTime() + 6 * 86_400_000).toISOString(),
        durationMinutes: 45,
      });
      // the shape an older install wrote: a suggestion, never accepted
      const placed = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
      ctx.tasks.getState().updateTask(id, {
        startTime: null,
        proposedTime: placed.startTime,
        scheduleStatus: 'proposed',
      });

      ctx.tasks.getState().rescheduleAll();

      const swept = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
      expect(swept.scheduleStatus).toBe('auto');
      expect(swept.startTime).not.toBeNull();
      expect(swept.proposedTime).toBeNull();
    });

    it('releaseSchedule hands a pinned task back to the scheduler', () => {
    const id = ctx.tasks.getState().addTask({
      title: 'Chapter 11 worksheet',
      dueDate: new Date(NOW.getTime() + 6 * 86_400_000).toISOString(),
      durationMinutes: 45,
    });
    const chosen = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();
    ctx.tasks.getState().updateTask(id, { startTime: chosen, scheduleStatus: 'pinned' });

    ctx.tasks.getState().releaseSchedule(id);

    const released = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
    // proposeSchedule alone would refuse here, a pinned block is never moved
    expect(released.scheduleStatus).toBe('auto');
    expect(released.startTime).not.toBeNull();
  });

  it('releaseSchedule does nothing to a task that is not pinned', () => {
    const id = ctx.tasks.getState().addTask({
      title: 'Chapter 12 worksheet',
      dueDate: new Date(NOW.getTime() + 6 * 86_400_000).toISOString(),
      durationMinutes: 45,
    });
    const before = ctx.tasks.getState().tasks.find((t) => t.id === id)!;

    ctx.tasks.getState().releaseSchedule(id);

    expect(ctx.tasks.getState().tasks.find((t) => t.id === id)).toEqual(before);
  });

  it('leaves a pinned task alone on a sweep', () => {
      const id = ctx.tasks.getState().addTask({
        title: 'Chapter 10 worksheet',
        dueDate: new Date(NOW.getTime() + 6 * 86_400_000).toISOString(),
        durationMinutes: 45,
      });
      const chosen = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();
      ctx.tasks.getState().updateTask(id, { startTime: chosen, scheduleStatus: 'pinned' });

      ctx.tasks.getState().rescheduleAll();

      const after = ctx.tasks.getState().tasks.find((t) => t.id === id)!;
      expect(after.startTime).toBe(chosen);
      expect(after.scheduleStatus).toBe('pinned');
    });
});

describe('write queue behaviour through the store layer', () => {
  it('coalesces repeated writes to one key inside the debounce window', async () => {
    vi.useFakeTimers();
    try {
      const repository = new MemoryRepository();
      const queue = new WriteQueue(repository, { debounceMs: 300 });
      queue.queue(STORAGE_KEYS.tasks, [{ n: 1 }]);
      queue.queue(STORAGE_KEYS.tasks, [{ n: 2 }]);
      queue.queue(STORAGE_KEYS.tasks, [{ n: 3 }]);
      expect(repository.writeLog).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(300);
      expect(repository.writeLog).toEqual([STORAGE_KEYS.tasks]);
      expect(JSON.parse(repository.raw()[STORAGE_KEYS.tasks])).toEqual([{ n: 3 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failing write twice, then surfaces it rather than dropping data', async () => {
    vi.useFakeTimers();
    try {
      const repository = new MemoryRepository({ failWrites: true });
      const failures: unknown[] = [];
      const queue = new WriteQueue(repository, {
        debounceMs: 0,
        maxRetries: 2,
        backoffMs: () => 10,
        onFailure: (f) => failures.push(f),
      });
      queue.queue(STORAGE_KEYS.tasks, [{ n: 1 }]);
      await vi.advanceTimersByTimeAsync(100);

      expect(failures).toHaveLength(1);
      expect((failures[0] as { attempts: number }).attempts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush writes everything pending immediately', async () => {
    const repository = new MemoryRepository();
    const queue = new WriteQueue(repository, { debounceMs: 10_000 });
    queue.queue(STORAGE_KEYS.tasks, [{ n: 1 }]);
    expect(queue.isDirty).toBe(true);
    await queue.flush();
    expect(repository.writeLog).toEqual([STORAGE_KEYS.tasks]);
  });

  it('flush does not return while a concurrent drain is still writing', async () => {
    // regression: a timer drain and flush()'s drain could both wait on one in-flight batch. the
    // second to wake found nothing pending, so flush() resolved while the newest batch was still writing
    const repository = new MemoryRepository();
    const realSave = repository.save.bind(repository);
    const gates: (() => void)[] = [];
    vi.spyOn(repository, 'save').mockImplementation(
      (key, value) =>
        new Promise<void>((resolve, reject) => {
          gates.push(() => {
            realSave(key, value).then(resolve, reject);
          });
        }),
    );
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const queue = new WriteQueue(repository, { debounceMs: 0 });

    queue.queue(STORAGE_KEYS.tasks, [{ n: 1 }]);
    await tick(); // timer drain A is now writing n:1, held at the gate
    expect(gates).toHaveLength(1);

    queue.queue(STORAGE_KEYS.tasks, [{ n: 2 }]);
    await tick(); // timer drain C is now waiting on A

    let flushed = false;
    const flushing = queue.flush().then(() => {
      flushed = true;
    });
    gates[0](); // A lands; C takes n:2 and starts writing it
    await tick();
    expect(gates).toHaveLength(2);
    expect(flushed).toBe(false);

    gates[1]();
    await flushing;
    expect(flushed).toBe(true);
    expect(JSON.parse(repository.raw()[STORAGE_KEYS.tasks])).toEqual([{ n: 2 }]);
    expect(queue.isDirty).toBe(false);
  });
});

