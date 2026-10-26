import { describe, expect, it } from 'vitest';

import { pickForMinutes } from '@/services/rightNow';
import type { Subtask, Task } from '@/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// a monday at 09:00 local, the same anchor scheduler.test.ts uses
const NOW = new Date(2026, 8, 7, 9, 0, 0, 0);

// what blockLengthMultiplier returns with no history yet
const UNTRAINED = 1;

function subtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    id: 'sub-a',
    parentTaskId: 'task-a',
    title: 'Read the assignment sheet',
    estimatedMinutes: 15,
    isComplete: false,
    order: 0,
    completedAt: null,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-a',
    title: 'Chapter 4 notes',
    subject: 'Biology',
    description: null,
    dueDate: new Date(NOW.getTime() + 2 * DAY).toISOString(),
    startTime: null,
    proposedTime: null,
    proposedAt: null,
    durationMinutes: null,
    status: 'not_started',
    scheduleStatus: 'unscheduled',
    subtasks: [],
    starterAction: null,
    breakdownSource: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    completedAt: null,
    ...overrides,
  };
}

describe('pickForMinutes, what fits the window', () => {
  it('returns null when every candidate is too large', () => {
    const tasks = [
      task({
        subtasks: [
          subtask({ id: 'sub-a', estimatedMinutes: 45, order: 0 }),
          subtask({ id: 'sub-b', estimatedMinutes: 40, order: 1 }),
        ],
      }),
    ];
    expect(pickForMinutes(tasks, 30, UNTRAINED, NOW)).toBeNull();
  });

  it('accepts an exact fit at the boundary', () => {
    const tasks = [task({ subtasks: [subtask({ estimatedMinutes: 30 })] })];
    const pick = pickForMinutes(tasks, 30, UNTRAINED, NOW);
    expect(pick).not.toBeNull();
    expect(pick!.subtaskId).toBe('sub-a');
    expect(pick!.fitMinutes).toBe(30);
  });

  it('rejects a candidate one minute over the boundary', () => {
    const tasks = [task({ subtasks: [subtask({ estimatedMinutes: 31 })] })];
    expect(pickForMinutes(tasks, 30, UNTRAINED, NOW)).toBeNull();
  });

  it('reports the padded cost, rounded up', () => {
    // 15 x 1.5 = 22.5, and a window has to hold the whole thing
    const tasks = [task({ subtasks: [subtask({ estimatedMinutes: 15 })] })];
    expect(pickForMinutes(tasks, 30, 1.5, NOW)!.fitMinutes).toBe(23);
  });
});

describe('pickForMinutes, the learned multiplier', () => {
  it('offers a 30-minute step for a 30-minute window at 1.0', () => {
    const tasks = [task({ subtasks: [subtask({ estimatedMinutes: 30 })] })];
    const pick = pickForMinutes(tasks, 30, 1, NOW);
    expect(pick).not.toBeNull();
    expect(pick!.fitMinutes).toBe(30);
  });

  it('withholds the same step at 1.5, which is the point of the feature', () => {
    const tasks = [task({ subtasks: [subtask({ estimatedMinutes: 30 })] })];
    expect(pickForMinutes(tasks, 30, 1.5, NOW)).toBeNull();
  });

  it('treats a zero, negative or non-finite multiplier as 1.0', () => {
    const tasks = [task({ subtasks: [subtask({ estimatedMinutes: 30 })] })];
    for (const multiplier of [0, -1, -2.5, NaN, Infinity]) {
      const pick = pickForMinutes(tasks, 30, multiplier, NOW);
      expect(pick, `multiplier ${multiplier}`).not.toBeNull();
      expect(pick!.fitMinutes, `multiplier ${multiplier}`).toBe(30);
    }
  });
});

describe('pickForMinutes, completed work', () => {
  it('never picks from a completed task', () => {
    const tasks = [
      task({
        status: 'complete',
        completedAt: NOW.toISOString(),
        subtasks: [subtask({ estimatedMinutes: 10 })],
      }),
    ];
    expect(pickForMinutes(tasks, 30, UNTRAINED, NOW)).toBeNull();
  });

  it('never picks a completed subtask, even when it is the better fit', () => {
    const tasks = [
      task({
        subtasks: [
          subtask({
            id: 'sub-done',
            estimatedMinutes: 30,
            order: 0,
            isComplete: true,
            completedAt: NOW.toISOString(),
          }),
          subtask({ id: 'sub-open', estimatedMinutes: 10, order: 1 }),
        ],
      }),
    ];
    const pick = pickForMinutes(tasks, 30, UNTRAINED, NOW);
    expect(pick!.subtaskId).toBe('sub-open');
    expect(pick!.fitMinutes).toBe(10);
  });
});

describe('pickForMinutes, tasks without subtasks', () => {
  it('picks the whole task when it has a duration', () => {
    const tasks = [task({ durationMinutes: 25, subtasks: [] })];
    const pick = pickForMinutes(tasks, 30, UNTRAINED, NOW);
    expect(pick).toEqual({
      taskId: 'task-a',
      taskTitle: 'Chapter 4 notes',
      subtaskId: null,
      title: 'Chapter 4 notes',
      fitMinutes: 25,
    });
  });

  it('never picks a task with no subtasks and no duration', () => {
    const tasks = [task({ durationMinutes: null, subtasks: [] })];
    expect(pickForMinutes(tasks, 45, UNTRAINED, NOW)).toBeNull();
  });
});

describe('pickForMinutes, ranking', () => {
  it('prefers the sooner due date over the larger fit', () => {
    const tasks = [
      task({
        id: 'task-later',
        dueDate: new Date(NOW.getTime() + 3 * DAY).toISOString(),
        subtasks: [subtask({ id: 'sub-big', parentTaskId: 'task-later', estimatedMinutes: 30 })],
      }),
      task({
        id: 'task-sooner',
        dueDate: new Date(NOW.getTime() + 1 * DAY).toISOString(),
        subtasks: [subtask({ id: 'sub-small', parentTaskId: 'task-sooner', estimatedMinutes: 10 })],
      }),
    ];
    expect(pickForMinutes(tasks, 30, UNTRAINED, NOW)!.subtaskId).toBe('sub-small');
  });

  it('treats an overdue task as the most urgent through the ordinary ordering', () => {
    const tasks = [
      task({
        id: 'task-tomorrow',
        dueDate: new Date(NOW.getTime() + 1 * DAY).toISOString(),
        subtasks: [subtask({ id: 'sub-tomorrow', parentTaskId: 'task-tomorrow' })],
      }),
      task({
        id: 'task-overdue',
        dueDate: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
        subtasks: [subtask({ id: 'sub-overdue', parentTaskId: 'task-overdue' })],
      }),
    ];
    expect(pickForMinutes(tasks, 30, UNTRAINED, NOW)!.subtaskId).toBe('sub-overdue');
  });

  it('prefers the larger padded cost among equal due dates', () => {
    const tasks = [
      task({
        subtasks: [
          subtask({ id: 'sub-small', estimatedMinutes: 10, order: 0 }),
          subtask({ id: 'sub-large', estimatedMinutes: 25, order: 1 }),
        ],
      }),
    ];
    const pick = pickForMinutes(tasks, 30, UNTRAINED, NOW);
    expect(pick!.subtaskId).toBe('sub-large');
    expect(pick!.fitMinutes).toBe(25);
  });

  it('prefers the lower order among equal due dates and equal costs', () => {
    const tasks = [
      task({
        subtasks: [
          subtask({ id: 'sub-second', estimatedMinutes: 20, order: 1 }),
          subtask({ id: 'sub-first', estimatedMinutes: 20, order: 0 }),
        ],
      }),
    ];
    expect(pickForMinutes(tasks, 30, UNTRAINED, NOW)!.subtaskId).toBe('sub-first');
  });

  it('falls back to the id so the pick is deterministic on a full tie', () => {
    const due = new Date(NOW.getTime() + 2 * DAY).toISOString();
    const tasks = [
      task({
        id: 'task-z',
        dueDate: due,
        subtasks: [subtask({ id: 'sub-z', parentTaskId: 'task-z', estimatedMinutes: 20 })],
      }),
      task({
        id: 'task-b',
        dueDate: due,
        subtasks: [subtask({ id: 'sub-b', parentTaskId: 'task-b', estimatedMinutes: 20 })],
      }),
    ];
    expect(pickForMinutes(tasks, 30, UNTRAINED, NOW)!.subtaskId).toBe('sub-b');
    expect(pickForMinutes([...tasks].reverse(), 30, UNTRAINED, NOW)!.subtaskId).toBe('sub-b');
  });
});

describe('pickForMinutes, guards', () => {
  it('returns null for a zero or negative window', () => {
    const tasks = [task({ subtasks: [subtask({ estimatedMinutes: 5 })] })];
    expect(pickForMinutes(tasks, 0, UNTRAINED, NOW)).toBeNull();
    expect(pickForMinutes(tasks, -15, UNTRAINED, NOW)).toBeNull();
  });

  it('returns null for an empty task list', () => {
    expect(pickForMinutes([], 30, UNTRAINED, NOW)).toBeNull();
  });
});
