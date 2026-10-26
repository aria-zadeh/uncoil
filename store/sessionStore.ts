// the active session is memory-only on purpose. only finished sessions are stored
import { createStore, type StoreApi } from 'zustand/vanilla';

import { STORAGE_KEYS } from '@/data/keys';
import type { WriteQueue } from '@/data/writeQueue';
import type { SchedulingState } from '@/store/schedulingStore';
import type { TaskState } from '@/store/taskStore';
import type { DayOfWeek, FocusSession, SessionEndReason } from '@/types';

export interface StoreDeps {
  queue: WriteQueue;
  // ISO 8601
  now: () => string;
  // UUID v4
  newId: () => string;
  taskStore: { getState: () => TaskState };
  schedulingStore: { getState: () => SchedulingState };
}

export interface SessionState {
  activeSession: FocusSession | null;
  sessions: FocusSession[];

  startSession: (taskId: string, subtaskId: string | null) => string;
  endSession: (reason: SessionEndReason) => void;
  markSubtaskCompleted: (subtaskId: string) => void;
  startBreak: () => void;
  endBreak: (durationSeconds: number) => void;
}

export function createSessionStore(deps: StoreDeps, initial: FocusSession[]): StoreApi<SessionState> {
  return createStore<SessionState>()((set, get) => ({
    activeSession: null,
    sessions: initial,

    startSession: (taskId, subtaskId) => {
      const id = deps.newId();
      const task = deps.taskStore.getState().tasks.find((t) => t.id === taskId);
      const session: FocusSession = {
        id,
        taskId,
        taskTitleSnapshot: task?.title ?? '',
        subtaskId,
        startedAt: deps.now(),
        endedAt: null,
        durationSeconds: null,
        breaksTaken: 0,
        breakSecondsTotal: 0,
        completedSubtaskIds: [],
        endReason: null,
      };
      set({ activeSession: session });
      return id;
    },

    endSession: (reason) => {
      const { activeSession } = get();
      if (!activeSession) return;
      const endedAt = deps.now();
      const durationSeconds = Math.round(
        (new Date(endedAt).getTime() - new Date(activeSession.startedAt).getTime()) / 1000,
      );
      const completed: FocusSession = { ...activeSession, endedAt, durationSeconds, endReason: reason };
      set((state) => ({ activeSession: null, sessions: [...state.sessions, completed] }));
      deps.queue.queue(STORAGE_KEYS.sessions, get().sessions);

      // record a signal for the scheduled slot so the scheduler learns from every session, not
      // only from review-yesterday. a task with no slot has nothing to attribute it to
      const task = deps.taskStore.getState().tasks.find((t) => t.id === activeSession.taskId);
      if (task && task.startTime !== null) {
        const scheduled = new Date(task.startTime);
        // a student can check off the last step and just close the screen, which ends as interrupted
        const outcome = reason === 'completed' || task.status === 'complete' ? 'completed' : 'skipped';
        deps.schedulingStore.getState().addSignal({
          taskId: task.id,
          dayOfWeek: scheduled.getDay() as DayOfWeek,
          hourOfDay: scheduled.getHours(),
          outcome,
          actualDurationMinutes: Math.round(durationSeconds / 60),
          estimatedDurationMinutes: task.durationMinutes,
        });
      }
    },

    markSubtaskCompleted: (subtaskId) => {
      set((state) =>
        state.activeSession
          ? {
              activeSession: {
                ...state.activeSession,
                completedSubtaskIds: [...state.activeSession.completedSubtaskIds, subtaskId],
              },
            }
          : {},
      );
    },

    startBreak: () => {
      set((state) =>
        state.activeSession
          ? { activeSession: { ...state.activeSession, breaksTaken: state.activeSession.breaksTaken + 1 } }
          : {},
      );
    },

    endBreak: (durationSeconds) => {
      set((state) =>
        state.activeSession
          ? {
              activeSession: {
                ...state.activeSession,
                breakSecondsTotal: state.activeSession.breakSecondsTotal + durationSeconds,
              },
            }
          : {},
      );
    },
  }));
}
