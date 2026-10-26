// diffs the pure plan against what was last scheduled and touches only what changed, so an
// unrelated edit doesn't churn the OS list. syncs are debounced so a burst of edits makes one
import { createStore, type StoreApi } from 'zustand/vanilla';

import { planNotifications, type PlannedNotification } from '@/services/notificationPlan';
import type { PermissionOutcome } from '@/services/notifications';
import type { Task, UserSettings } from '@/types';

export interface NotificationAdapter {
  requestPermission: () => Promise<PermissionOutcome>;
  getPermissionStatus: () => Promise<PermissionOutcome>;
  cancelOne: (id: string) => Promise<void>;
  scheduleOne: (notification: PlannedNotification) => Promise<void>;
  // for the data wipe, which can't rely on the diff
  cancelAll: () => Promise<void>;
  // read once per launch. scheduled starts empty, so without this a reminder for a task
  // finished just before the app was killed would never be cancelled
  getScheduledIds: () => Promise<string[]>;
}

export interface StoreDeps {
  taskStore: { getState: () => { tasks: Task[] } };
  settingsStore: { getState: () => UserSettings };
  adapter: NotificationAdapter;
  now?: () => Date;
  debounceMs?: number;
}

export interface NotificationState {
  // last confirmed with the adapter. not persisted, the OS is the source of truth
  scheduled: PlannedNotification[];
  permissionStatus: PermissionOutcome | 'unknown';
  // the debounced sync records failures here, since nothing could catch a rejection
  lastError: Error | null;

  syncNotifications: () => void;
  flushNotifications: () => Promise<void>;
  // call only from the student's own tap
  requestPermission: () => Promise<PermissionOutcome>;
  // a read, not a request, so it is safe to call anywhere
  refreshPermissionStatus: () => Promise<void>;
  // skips the permission check and the diff, for the data wipe
  cancelAllScheduled: () => Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 300;
const ADAPTER_TIMEOUT_MS = 10_000;

// a hung adapter call must not wedge every later sync
function withTimeout<T>(promise: Promise<T>, ms = ADAPTER_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`adapter call exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function sameNotification(a: PlannedNotification, b: PlannedNotification): boolean {
  return (
    a.fireAt === b.fireAt &&
    a.title === b.title &&
    a.body === b.body &&
    a.kind === b.kind &&
    a.taskId === b.taskId
  );
}

export interface DiffResult {
  // a failed schedule call never counts as scheduled
  scheduled: PlannedNotification[];
  // first rejection. every other entry is still applied
  error: Error | null;
  // retried next sync
  failedCancels: string[];
}

async function applyDiff(
  previous: readonly PlannedNotification[],
  next: readonly PlannedNotification[],
  adapter: NotificationAdapter,
  // OS orphans found at launch and cancels that failed last time
  extraCancels: ReadonlySet<string>,
): Promise<DiffResult> {
  const prevById = new Map(previous.map((n) => [n.id, n]));
  const nextById = new Map(next.map((n) => [n.id, n]));

  const toCancel: string[] = [];
  const toSchedule: PlannedNotification[] = [];
  const unchanged: PlannedNotification[] = [];

  for (const [id, prev] of prevById) {
    const candidate = nextById.get(id);
    if (!candidate) {
      toCancel.push(id);
    } else if (!sameNotification(prev, candidate)) {
      toCancel.push(id);
      toSchedule.push(candidate);
    } else {
      unchanged.push(prev);
    }
  }
  for (const [id, candidate] of nextById) {
    if (!prevById.has(id)) toSchedule.push(candidate);
  }
  for (const id of extraCancels) {
    if (!nextById.has(id) && !prevById.has(id)) toCancel.push(id);
  }

  const cancelResults = await Promise.allSettled(toCancel.map((id) => withTimeout(adapter.cancelOne(id))));
  const scheduleResults = await Promise.allSettled(
    toSchedule.map((n) => withTimeout(adapter.scheduleOne(n))),
  );
  const scheduledNow = toSchedule.filter((_, i) => scheduleResults[i].status === 'fulfilled');

  const firstRejection = [...cancelResults, ...scheduleResults].find(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  );
  const error = firstRejection
    ? firstRejection.reason instanceof Error
      ? firstRejection.reason
      : new Error(String(firstRejection.reason))
    : null;

  // a changed entry is rescheduled under the same id, which replaces it either way, so only
  // ids the plan dropped need a retry
  const failedCancels = toCancel.filter((id, i) => cancelResults[i].status === 'rejected' && !nextById.has(id));

  return { scheduled: [...unchanged, ...scheduledNow], error, failedCancels };
}

export function createNotificationStore(deps: StoreDeps): StoreApi<NotificationState> {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const clock = deps.now ?? (() => new Date());

  let timer: ReturnType<typeof setTimeout> | null = null;
  // syncs chain onto this, so two never diff against the same uncommitted baseline and
  // schedule an entry twice
  let pending: Promise<void> | null = null;
  // stays false until the OS read succeeds, so a failed read retries
  let reconciledWithOs = false;
  let retryCancels = new Set<string>();

  return createStore<NotificationState>()((set, get) => {
    const refreshPermission = async (): Promise<PermissionOutcome> => {
      const outcome = await withTimeout(deps.adapter.getPermissionStatus());
      set({ permissionStatus: outcome });
      return outcome;
    };

    const runOnce = async (): Promise<void> => {
      // checked every sync, the student can revoke it anytime. a failed check fails closed but
      // still falls through to cancel whatever is stale
      let permissionStatus: PermissionOutcome;
      let permissionError: Error | null = null;
      try {
        permissionStatus = await refreshPermission();
      } catch (error) {
        permissionStatus = 'undetermined';
        permissionError = error instanceof Error ? error : new Error(String(error));
        set({ permissionStatus });
      }

      try {
        const tasks = deps.taskStore.getState().tasks;
        const settings = deps.settingsStore.getState();
        const plan =
          permissionStatus === 'granted' ? planNotifications(tasks, settings, clock()) : [];
        const extraCancels = new Set(retryCancels);
        let reconcileError: Error | null = null;
        if (!reconciledWithOs) {
          try {
            for (const id of await withTimeout(deps.adapter.getScheduledIds())) extraCancels.add(id);
            reconciledWithOs = true;
          } catch (error) {
            reconcileError = error instanceof Error ? error : new Error(String(error));
          }
        }
        const { scheduled, error, failedCancels } = await applyDiff(
          get().scheduled,
          plan,
          deps.adapter,
          extraCancels,
        );
        retryCancels = new Set(failedCancels);
        set({ scheduled, lastError: permissionError ?? reconcileError ?? error });
      } catch (error) {
        set({ lastError: error instanceof Error ? error : new Error(String(error)) });
      }
    };

    const enqueueSync = (): Promise<void> => {
      const chained = pending ? pending.then(runOnce) : runOnce();
      pending = chained;
      // clear only if nothing chained on since, or a queued sync would lose its reference
      void chained.finally(() => {
        if (pending === chained) pending = null;
      });
      return chained;
    };

    const flushNotifications = async (): Promise<void> => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        await enqueueSync();
        return;
      }
      if (pending) await pending;
    };

    return {
      scheduled: [],
      permissionStatus: 'unknown',
      lastError: null,

      syncNotifications: () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void enqueueSync();
        }, debounceMs);
      },

      flushNotifications,

      requestPermission: async () => {
        const outcome = await deps.adapter.requestPermission();
        set({ permissionStatus: outcome });
        return outcome;
      },

      refreshPermissionStatus: async () => {
        await refreshPermission();
      },

      cancelAllScheduled: async () => {
        await withTimeout(deps.adapter.cancelAll());
        set({ scheduled: [] });
      },
    };
  });
}
