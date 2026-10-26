// subtasks are embedded on the task, and their order stays dense (0-based, no gaps) through
// every insert, delete and reorder
import { createStore, type StoreApi } from 'zustand/vanilla';

import { STORAGE_KEYS } from '@/data/keys';
import type { WriteQueue } from '@/data/writeQueue';
import type { GenerationKind } from '@/services/generation';
import { forecastFeasibility } from '@/services/scheduler';
import { validateTaskTiming } from '@/services/validation';
import type { SchedulingState } from '@/store/schedulingStore';
import type { SettingsState } from '@/store/settingsStore';
import type {
  BreakdownInput,
  BreakdownResult,
  BreakdownSource,
  ExtractionResult,
  FocusSession,
  SimplifyInput,
  SimplifyResult,
  SchedulingSignal,
  Subtask,
  Task,
  TaskStatus,
} from '@/types';

// ids, order, timestamps and fields that must agree with another field are never caller-supplied
export type NewTaskInput = Pick<Task, 'title' | 'dueDate'> &
  Partial<Pick<Task, 'subject' | 'description' | 'startTime' | 'durationMinutes'>>;

// status and completedAt change together through the status actions, subtasks only through
// the subtask actions that keep order dense
export type TaskUpdate = Partial<
  Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'subtasks' | 'status' | 'completedAt'>
>;

export type NewSubtaskInput = Pick<Subtask, 'title' | 'estimatedMinutes'>;

// order only changes through reorderSubtasks
export type SubtaskUpdate = Partial<Omit<Subtask, 'id' | 'parentTaskId' | 'order'>>;

// takes a dueDate, not a duePhrase: making the phrase needs services/prompt.ts, which app/ can't import
export interface BreakdownDraft {
  title: string;
  subject: string | null;
  description: string | null;
  dueDate: string;
  sessionMinutes: number;
}

export interface ProposeContext {
  task: Task;
  allTasks: Task[];
  settings: SettingsState;
  signals: SchedulingSignal[];
}

export interface ProposedSlot {
  startTime: string;
}

export interface StoreDeps {
  queue: WriteQueue;
  now: () => string;
  newId: () => string;
  settingsStore: { getState: () => SettingsState };
  schedulingStore: { getState: () => SchedulingState };
  // narrow on purpose: this file must not import sessionStore.ts, which imports TaskState from here
  sessionStore: { getState: () => { sessions: FocusSession[] } };
  // optional so tests that don't care about notifications can omit it
  notificationStore?: { getState: () => { syncNotifications: () => void } };
  propose?: (context: ProposeContext) => ProposedSlot | null;
  // never rejects except on cancellation. a generation failure falls back to a template instead
  generate?: (input: BreakdownInput) => Promise<BreakdownResult>;
  generateExtraction?: (text: string) => Promise<ExtractionResult>;
  generateSimplification?: (input: SimplifyInput) => Promise<SimplifyResult>;
  // takes a kind so cancelling a breakdown doesn't abort every other generation
  cancelGeneration?: (kind?: GenerationKind) => void;
  // a cancellation is not a failure and leaves the task exactly as it was
  isCancellation?: (error: unknown) => boolean;
  generationStore?: {
    getState: () => {
      setTier: (tier: 'model' | 'template') => void;
      recordFailure: (reason: string) => void;
      clearFailure: () => void;
    };
  };
  // absolute dates never reach the model. injected so tests control the clock
  duePhraseFor?: (dueDateIso: string) => string;
}

// what /task/new previewed, carried into the saved task
export interface BreakdownPreview {
  starterAction: string;
  steps: readonly NewSubtaskInput[];
  source: BreakdownSource;
}

// what a re-breakdown overwrote, enough to put the task back
export interface BreakdownUndo {
  taskId: string;
  subtasks: Subtask[];
  starterAction: string | null;
  durationMinutes: number | null;
  breakdownSource: BreakdownSource | null;
  status: TaskStatus;
}

export interface TaskState {
  tasks: Task[];

  addTask: (input: NewTaskInput) => string;
  updateTask: (id: string, updates: TaskUpdate) => void;
  deleteTask: (id: string) => void;
  setTaskStatus: (id: string, status: TaskStatus) => void;
  completeTask: (id: string) => void;
  // status goes back to whatever the subtasks say
  uncompleteTask: (id: string) => void;

  addSubtasks: (taskId: string, subtasks: NewSubtaskInput[]) => void;
  // also re-derives the parent task's status
  toggleSubtask: (taskId: string, subtaskId: string) => void;
  updateSubtask: (taskId: string, subtaskId: string, updates: SubtaskUpdate) => void;
  deleteSubtask: (taskId: string, subtaskId: string) => void;
  reorderSubtasks: (taskId: string, orderedSubtaskIds: string[]) => void;

  // a 'system' proposal never stamps updatedAt, because the inactivity nudge measures real
  // activity from it and an hourly sweep would keep resetting it. an identical slot writes nothing
  proposeSchedule: (taskId: string, options?: { initiatedBy?: 'user' | 'system' }) => void;
  // proposeSchedule never touches a pinned task, so unpinning has to be its own action
  releaseSchedule: (taskId: string) => void;
  rescheduleAll: () => void;

  // read-only, so a screen can call it every render instead of storing a flag that goes stale.
  // true for a missing task, since that says nothing about the calendar
  canSchedule: (taskId: string) => boolean;

  // never persisted, or a crash would restore a spinner that never stops
  breakdownInFlight: string[];
  // never rejects. true only when new steps were written, so Undo is offered only then
  breakdown: (taskId: string) => Promise<boolean>;
  // memory only. null when the task had no steps to lose
  lastBreakdown: BreakdownUndo | null;
  // no-op unless lastBreakdown belongs to taskId, so Undo never reverts another task
  undoBreakdown: (taskId: string) => void;
  cancelBreakdown: (taskId: string) => void;

  // for a task not saved yet. stores nothing. null only on cancellation
  previewBreakdown: (draft: BreakdownDraft) => Promise<BreakdownResult | null>;
  cancelPreview: () => void;
  // the task keeps the duration the student set
  applyBreakdownPreview: (taskId: string, preview: BreakdownPreview) => void;

  // returns candidates for the modal to confirm, since eight tasks from one paste can't be undone
  // in one tap. an empty list means nothing was found, null only on cancellation
  extractTasks: (text: string) => Promise<ExtractionResult | null>;
  cancelExtraction: () => void;

  // the parent title goes in as context. the explanation is shown once and never stored.
  // null on cancellation or when the subtask is gone
  simplifySubtask: (taskId: string, subtaskId: string) => Promise<SimplifyResult | null>;

  // puts back the title from before the first simplification
  restoreSubtask: (taskId: string, subtaskId: string) => void;
  cancelSimplification: () => void;

  // for "delete all data", where nothing started before the wipe may land after it
  cancelAllGeneration: () => void;
}

function statusFromSubtasks(subtasks: Subtask[]): TaskStatus {
  if (subtasks.length === 0) return 'not_started';
  if (subtasks.every((s) => s.isComplete)) return 'complete';
  if (subtasks.some((s) => s.isComplete)) return 'in_progress';
  return 'not_started';
}

function reindex(subtasks: Subtask[]): Subtask[] {
  return subtasks.map((s, index) => ({ ...s, order: index }));
}

export function createTaskStore(deps: StoreDeps, initial: Task[]): StoreApi<TaskState> {
  return createStore<TaskState>()((set, get) => {
    // counts for kinds with no per-task state, so cancel-on-unmount only aborts running work
    let previewsInFlight = 0;
    let extractionsInFlight = 0;
    let simplificationsInFlight = 0;
    const persist = (): void => deps.queue.queue(STORAGE_KEYS.tasks, get().tasks);
    const syncNotifications = (): void => deps.notificationStore?.getState().syncNotifications();
    // any tasks mutation can change the notification plan, a status derived from subtasks
    // included, so persist and resync always go together
    const afterMutation = (): void => {
      persist();
      syncNotifications();
    };

    return {
      tasks: initial,

      addTask: (input) => {
        const id = deps.newId();
        const timestamp = deps.now();
        // a start after the due date is dropped rather than blocking the save
        const requestedStartTime = input.startTime ?? null;
        const startTime = validateTaskTiming({ dueDate: input.dueDate, startTime: requestedStartTime }).ok
          ? requestedStartTime
          : null;
        const task: Task = {
          id,
          title: input.title,
          subject: input.subject ?? null,
          description: input.description ?? null,
          dueDate: input.dueDate,
          startTime,
          proposedTime: null,
          proposedAt: null,
          durationMinutes: input.durationMinutes ?? null,
          status: 'not_started',
          scheduleStatus: 'unscheduled',
          subtasks: [],
          starterAction: null,
          breakdownSource: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null,
        };
        set((state) => ({ tasks: [...state.tasks, task] }));
        afterMutation();
        // placed the moment it's created, straight to startTime as 'auto' with no Accept step.
        // 'unplaced' when nothing fits, so screens can tell that apart from not placed yet
        if (task.startTime === null && deps.propose) {
          const slot = deps.propose({
            task,
            allTasks: get().tasks,
            settings: deps.settingsStore.getState(),
            signals: deps.schedulingStore.getState().signals,
          });
          set((state) => ({
            tasks: state.tasks.map((t) =>
              t.id === id
                ? slot
                  ? { ...t, startTime: slot.startTime, scheduleStatus: 'auto' as const }
                  : { ...t, scheduleStatus: 'unplaced' as const }
                : t,
            ),
          }));
          afterMutation();
        }
        return id;
      },

      updateTask: (id, updates) => {
        const timestamp = deps.now();
        set((state) => ({
          tasks: state.tasks.map((t) => {
            if (t.id !== id) return t;
            const merged = { ...t, ...updates };
            // same rule as addTask, so pulling a due date ahead of the start still lands
            const startTime = validateTaskTiming(merged).ok ? merged.startTime : null;
            return { ...merged, startTime, updatedAt: timestamp };
          }),
        }));
        afterMutation();
      },

      deleteTask: (id) => {
        set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }));
        afterMutation();
        // sessions keep their title snapshot. signals are orphaned, not deleted, to keep the history
        deps.schedulingStore.getState().orphanSignalsForTask(id);
      },

      setTaskStatus: (id, status) => {
        const timestamp = deps.now();
        const before = get().tasks.find((t) => t.id === id);
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === id
              ? { ...t, status, completedAt: status === 'complete' ? timestamp : null, updatedAt: timestamp }
              : t,
          ),
        }));
        // ticking a task off is the usual way to finish one, so it teaches the scheduler too.
        // addSignal drops the duplicate when a session already recorded this slot
        if (status === 'complete' && before !== undefined && before.status !== 'complete') {
          const slot = before.startTime ?? before.proposedTime;
          if (slot !== null) {
            const scheduled = new Date(slot);
            deps.schedulingStore.getState().addSignal({
              taskId: before.id,
              dayOfWeek: scheduled.getDay() as SchedulingSignal['dayOfWeek'],
              hourOfDay: scheduled.getHours(),
              outcome: 'completed',
              actualDurationMinutes: null,
              estimatedDurationMinutes: before.durationMinutes,
            });
          }
        }
        afterMutation();
      },

      completeTask: (id) => {
        get().setTaskStatus(id, 'complete');
      },

      uncompleteTask: (id) => {
        const task = get().tasks.find((t) => t.id === id);
        if (!task) return;
        get().setTaskStatus(id, statusFromSubtasks(task.subtasks));
      },

      addSubtasks: (taskId, inputs) => {
        const timestamp = deps.now();
        set((state) => ({
          tasks: state.tasks.map((t) => {
            if (t.id !== taskId) return t;
            const startOrder = t.subtasks.length;
            const created: Subtask[] = inputs.map((input, i) => ({
              id: deps.newId(),
              parentTaskId: taskId,
              title: input.title,
              estimatedMinutes: input.estimatedMinutes,
              isComplete: false,
              order: startOrder + i,
              completedAt: null,
            }));
            return { ...t, subtasks: [...t.subtasks, ...created], updatedAt: timestamp };
          }),
        }));
        afterMutation();
      },

      toggleSubtask: (taskId, subtaskId) => {
        const timestamp = deps.now();
        set((state) => ({
          tasks: state.tasks.map((t) => {
            if (t.id !== taskId) return t;
            const subtasks = t.subtasks.map((s) => {
              if (s.id !== subtaskId) return s;
              const isComplete = !s.isComplete;
              return { ...s, isComplete, completedAt: isComplete ? timestamp : null };
            });
            const status = statusFromSubtasks(subtasks);
            return {
              ...t,
              subtasks,
              status,
              completedAt: status === 'complete' ? timestamp : null,
              updatedAt: timestamp,
            };
          }),
        }));
        afterMutation();
      },

      updateSubtask: (taskId, subtaskId, updates) => {
        const timestamp = deps.now();
        set((state) => ({
          tasks: state.tasks.map((t) => {
            if (t.id !== taskId) return t;
            // updates can include isComplete, so re-derive the parent status
            const subtasks = t.subtasks.map((s) => (s.id === subtaskId ? { ...s, ...updates } : s));
            const status = statusFromSubtasks(subtasks);
            return {
              ...t,
              subtasks,
              status,
              completedAt: status === 'complete' ? timestamp : null,
              updatedAt: timestamp,
            };
          }),
        }));
        afterMutation();
      },

      deleteSubtask: (taskId, subtaskId) => {
        const timestamp = deps.now();
        set((state) => ({
          tasks: state.tasks.map((t) => {
            if (t.id !== taskId) return t;
            const remaining = reindex(t.subtasks.filter((s) => s.id !== subtaskId));
            return { ...t, subtasks: remaining, status: statusFromSubtasks(remaining), updatedAt: timestamp };
          }),
        }));
        afterMutation();
      },

      reorderSubtasks: (taskId, orderedSubtaskIds) => {
        const timestamp = deps.now();
        set((state) => ({
          tasks: state.tasks.map((t) => {
            if (t.id !== taskId) return t;
            const byId = new Map(t.subtasks.map((s) => [s.id, s]));
            const reordered = reindex(
              orderedSubtaskIds
                .map((subtaskId) => byId.get(subtaskId))
                .filter((s): s is Subtask => s !== undefined),
            );
            return { ...t, subtasks: reordered, updatedAt: timestamp };
          }),
        }));
        afterMutation();
      },

      proposeSchedule: (taskId, options) => {
        const initiatedBy = options?.initiatedBy ?? 'user';
        const task = get().tasks.find((t) => t.id === taskId);
        if (!task || !deps.propose) return;
        const slot = deps.propose({
          task,
          allTasks: get().tasks,
          settings: deps.settingsStore.getState(),
          signals: deps.schedulingStore.getState().signals,
        });
        // a pinned block is the student's own choice and never moves, whoever asks
        if (task.scheduleStatus === 'pinned') return;
        if (!slot) {
          // say nothing fits rather than leave the task looking unconsidered
          if (task.scheduleStatus === 'unplaced') return;
          set((state) => ({
            tasks: state.tasks.map((t) =>
              t.id === taskId ? { ...t, scheduleStatus: 'unplaced' as const } : t,
            ),
          }));
          afterMutation();
          return;
        }
        // the hourly sweep usually lands on the same slot, so skip the write and resync
        if (task.startTime === slot.startTime && task.scheduleStatus === 'auto') return;
        const timestamp = deps.now();
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  // placed, not proposed. clear proposedTime so no stale suggestion survives
                  startTime: slot.startTime,
                  proposedTime: null,
                  proposedAt: null,
                  scheduleStatus: 'auto',
                  updatedAt: initiatedBy === 'system' ? t.updatedAt : timestamp,
                }
              : t,
          ),
        }));
        afterMutation();
      },

      canSchedule: (taskId) => {
        const task = get().tasks.find((t) => t.id === taskId);
        if (!task) return true;
        // the capacity forecast, not a fresh slot search
        const result = forecastFeasibility({
          task,
          otherTasks: get().tasks.filter((t) => t.id !== taskId),
          sessions: deps.sessionStore.getState().sessions,
          settings: deps.settingsStore.getState(),
          signals: deps.schedulingStore.getState().signals,
          now: new Date(deps.now()),
        });
        return result.fits;
      },

      releaseSchedule: (taskId) => {
        const task = get().tasks.find((t) => t.id === taskId);
        if (!task || task.scheduleStatus !== 'pinned') return;
        const timestamp = deps.now();
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId
              ? { ...t, scheduleStatus: 'auto' as const, updatedAt: timestamp }
              : t,
          ),
        }));
        get().proposeSchedule(taskId);
        afterMutation();
      },

      rescheduleAll: () => {
        // everything the app owns, legacy unscheduled and proposed rows included. pinned and
        // confirmed belong to the student. the hourly throttle lives in app/_layout.tsx
        const candidates = get().tasks.filter(
          (t) =>
            t.scheduleStatus === 'auto' ||
            t.scheduleStatus === 'unplaced' ||
            t.scheduleStatus === 'unscheduled' ||
            t.scheduleStatus === 'proposed',
        );
        for (const task of candidates) {
          get().proposeSchedule(task.id, { initiatedBy: 'system' });
        }
      },

      breakdownInFlight: [],
      lastBreakdown: null,

      undoBreakdown: (taskId) => {
        const undo = get().lastBreakdown;
        if (undo === null || undo.taskId !== taskId) return;
        if (!get().tasks.some((t) => t.id === undo.taskId)) {
          set({ lastBreakdown: null });
          return;
        }
        const timestamp = deps.now();
        set((state) => ({
          lastBreakdown: null,
          tasks: state.tasks.map((t) =>
            t.id === undo.taskId
              ? {
                  ...t,
                  subtasks: undo.subtasks,
                  starterAction: undo.starterAction,
                  durationMinutes: undo.durationMinutes,
                  breakdownSource: undo.breakdownSource,
                  status: undo.status,
                  updatedAt: timestamp,
                }
              : t,
          ),
        }));
        afterMutation();
      },

      breakdown: async (taskId) => {
        const task = get().tasks.find((t) => t.id === taskId);
        if (!task || !deps.generate) return false;
        // a second request would race the first to replace the steps
        if (get().breakdownInFlight.includes(taskId)) return false;

        set((state) => ({ breakdownInFlight: [...state.breakdownInFlight, taskId] }));

        const clearInFlight = (): void =>
          set((state) => ({
            breakdownInFlight: state.breakdownInFlight.filter((id) => id !== taskId),
          }));

        let result: BreakdownResult;
        try {
          result = await deps.generate({
            title: task.title,
            subject: task.subject,
            description: task.description,
            duePhrase: deps.duePhraseFor ? deps.duePhraseFor(task.dueDate) : 'in 3 days',
            sessionMinutes:
              task.durationMinutes ?? deps.settingsStore.getState().typicalSessionMinutes,
          });
        } catch (error) {
          clearInFlight();
          // cancellation is the only expected rejection: no result, no error, task untouched
          if (deps.isCancellation?.(error)) return false;
          deps.generationStore?.getState().recordFailure(
            error instanceof Error ? error.message : String(error),
          );
          return false;
        }

        // cancelled or deleted while the model worked. applying it now would undo that choice
        if (!get().breakdownInFlight.includes(taskId)) return false;
        clearInFlight();
        if (!get().tasks.some((t) => t.id === taskId)) return false;

        const timestamp = deps.now();
        // snapshot only when there is something to lose
        const previous = get().tasks.find((t) => t.id === taskId);
        const undo: BreakdownUndo | null =
          previous !== undefined && previous.subtasks.length > 0
            ? {
                taskId,
                subtasks: previous.subtasks,
                starterAction: previous.starterAction,
                durationMinutes: previous.durationMinutes,
                breakdownSource: previous.breakdownSource,
                status: previous.status,
              }
            : null;
        const subtasks: Subtask[] = result.breakdown.steps.map((step, index) => ({
          id: deps.newId(),
          parentTaskId: taskId,
          title: step.title,
          estimatedMinutes: step.minutes,
          isComplete: false,
          order: index,
          completedAt: null,
        }));

        set((state) => ({
          lastBreakdown: undo,
          tasks: state.tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  // replaced, not appended. two stacked answers to "how do I start" is worse than one
                  subtasks,
                  starterAction: result.breakdown.starterAction,
                  durationMinutes: subtasks.reduce((sum, sub) => sum + sub.estimatedMinutes, 0),
                  breakdownSource: result.tier,
                  status: statusFromSubtasks(subtasks),
                  updatedAt: timestamp,
                }
              : t,
          ),
        }));

        const generation = deps.generationStore?.getState();
        generation?.setTier(result.tier);
        if (result.tier === 'model') generation?.clearFailure();

        afterMutation();
        // the duration changed, so place it again
        get().proposeSchedule(taskId);
        return true;
      },

      previewBreakdown: async (draft) => {
        if (!deps.generate) return null;
        previewsInFlight += 1;
        try {
          return await deps.generate({
            title: draft.title,
            subject: draft.subject,
            description: draft.description,
            duePhrase: deps.duePhraseFor ? deps.duePhraseFor(draft.dueDate) : 'in 3 days',
            sessionMinutes: draft.sessionMinutes,
          });
        } catch (error) {
          if (deps.isCancellation?.(error)) return null;
          deps.generationStore?.getState().recordFailure(
            error instanceof Error ? error.message : String(error),
          );
          return null;
        } finally {
          previewsInFlight -= 1;
        }
      },

      cancelPreview: () => {
        if (previewsInFlight === 0) return;
        deps.cancelGeneration?.('breakdown');
      },

      applyBreakdownPreview: (taskId, preview) => {
        if (!get().tasks.some((t) => t.id === taskId)) return;
        const timestamp = deps.now();
        set((state) => ({
          tasks: state.tasks.map((t) => {
            if (t.id !== taskId) return t;
            const subtasks: Subtask[] = preview.steps.map((step, index) => ({
              id: deps.newId(),
              parentTaskId: taskId,
              title: step.title,
              estimatedMinutes: step.estimatedMinutes,
              isComplete: false,
              order: index,
              completedAt: null,
            }));
            return {
              ...t,
              subtasks,
              starterAction: preview.starterAction,
              breakdownSource: preview.source,
              status: statusFromSubtasks(subtasks),
              updatedAt: timestamp,
            };
          }),
        }));
        afterMutation();
      },

      extractTasks: async (text) => {
        if (!deps.generateExtraction) return { extraction: { tasks: [] }, tier: 'template', latencyMs: 0 };
        extractionsInFlight += 1;
        try {
          return await deps.generateExtraction(text);
        } catch (error) {
          if (deps.isCancellation?.(error)) return null;
          deps.generationStore?.getState().recordFailure(
            error instanceof Error ? error.message : String(error),
          );
          return { extraction: { tasks: [] }, tier: 'template', latencyMs: 0 };
        } finally {
          extractionsInFlight -= 1;
        }
      },

      cancelExtraction: () => {
        if (extractionsInFlight === 0) return;
        deps.cancelGeneration?.('extraction');
      },

      simplifySubtask: async (taskId, subtaskId) => {
        const task = get().tasks.find((t) => t.id === taskId);
        const subtask = task?.subtasks.find((s) => s.id === subtaskId);
        if (!task || !subtask || !deps.generateSimplification) return null;

        let result: SimplifyResult;
        simplificationsInFlight += 1;
        try {
          result = await deps.generateSimplification({
            title: subtask.title,
            description: task.title,
          });
        } catch (error) {
          if (deps.isCancellation?.(error)) return null;
          deps.generationStore?.getState().recordFailure(
            error instanceof Error ? error.message : String(error),
          );
          return null;
        } finally {
          simplificationsInFlight -= 1;
        }

        // the subtask may have changed or gone while the model worked. only the title is written
        const current = get().tasks.find((t) => t.id === taskId)?.subtasks.find((s) => s.id === subtaskId);
        if (!current) return result;
        // the template tier keeps the wording, and writing it would offer a Restore that does nothing
        if (result.tier === 'template' && result.simplification.title === current.title) {
          deps.generationStore?.getState().setTier(result.tier);
          return result;
        }

        const timestamp = deps.now();
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  subtasks: t.subtasks.map((sub) =>
                    sub.id === subtaskId
                      ? {
                          ...sub,
                          title: result.simplification.title,
                          // set once, so a second simplification keeps the true original
                          originalTitle: sub.originalTitle ?? sub.title,
                        }
                      : sub,
                  ),
                  updatedAt: timestamp,
                }
              : t,
          ),
        }));
        deps.generationStore?.getState().setTier(result.tier);
        afterMutation();
        return result;
      },

      restoreSubtask: (taskId, subtaskId) => {
        const task = get().tasks.find((t) => t.id === taskId);
        const subtask = task?.subtasks.find((s) => s.id === subtaskId);
        if (!task || !subtask || subtask.originalTitle === undefined) return;
        // narrowed here because TS can't carry the guard into the map closure
        const originalTitle: string = subtask.originalTitle;

        const timestamp = deps.now();
        set((state) => ({
          tasks: state.tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  subtasks: t.subtasks.map((sub) =>
                    sub.id === subtaskId
                      ? { ...sub, title: originalTitle, originalTitle: undefined }
                      : sub,
                  ),
                  updatedAt: timestamp,
                }
              : t,
          ),
        }));
        afterMutation();
      },

      cancelBreakdown: (taskId) => {
        if (!get().breakdownInFlight.includes(taskId)) return;
        set((state) => ({
          breakdownInFlight: state.breakdownInFlight.filter((id) => id !== taskId),
        }));
        // scoped so a concurrent extraction or simplification keeps running
        deps.cancelGeneration?.('breakdown');
      },

      cancelSimplification: () => {
        if (simplificationsInFlight === 0) return;
        deps.cancelGeneration?.('simplification');
      },

      cancelAllGeneration: () => {
        // no kind aborts every controller
        deps.cancelGeneration?.();
        set({ breakdownInFlight: [], lastBreakdown: null });
      },
    };
  });
}
