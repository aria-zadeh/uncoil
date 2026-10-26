import { describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '@/data/keys';
import { MemoryRepository } from '@/data/memoryRepository';
import { WriteQueue } from '@/data/writeQueue';
import { createWriteStatusStore } from '@/store/writeStatusStore';

// same onFailure wiring as store/runtime.ts, against an in-memory repository
function wired() {
  const repository = new MemoryRepository({ failWrites: true });
  const status = createWriteStatusStore();
  const queue = new WriteQueue(repository, {
    debounceMs: 0,
    maxRetries: 1,
    backoffMs: () => 0,
    onFailure: (failure) => status.getState().recordFailure(failure),
  });
  return { repository, status, queue };
}

describe('write status store', () => {
  it('records a write that exhausted its retries instead of dropping it silently', async () => {
    const { status, queue } = wired();
    queue.queue(STORAGE_KEYS.tasks, [{ n: 1 }]);
    await queue.flush();

    const failures = status.getState().failures;
    expect(failures).toHaveLength(1);
    expect(failures[0].key).toBe(STORAGE_KEYS.tasks);
    expect(failures[0].attempts).toBe(2);
  });

  it('keeps one entry per key, the latest', async () => {
    const { status, queue } = wired();
    queue.queue(STORAGE_KEYS.tasks, [{ n: 1 }]);
    await queue.flush();
    queue.queue(STORAGE_KEYS.tasks, [{ n: 2 }]);
    await queue.flush();
    expect(status.getState().failures).toHaveLength(1);
  });

  it('clears a failure once its retry lands, and keeps it when the retry fails again', async () => {
    const { repository, status, queue } = wired();
    queue.queue(STORAGE_KEYS.tasks, [{ n: 1 }]);
    await queue.flush();

    await status.getState().retryAll();
    expect(status.getState().failures).toHaveLength(1);

    repository.failWrites = false;
    await status.getState().retryAll();
    expect(status.getState().failures).toHaveLength(0);
    expect(await repository.load(STORAGE_KEYS.tasks)).toEqual([{ n: 1 }]);
  });

  it('never rejects from retryAll', async () => {
    const status = createWriteStatusStore();
    status.getState().recordFailure({
      key: STORAGE_KEYS.tasks,
      attempts: 3,
      error: new Error('x'),
      retry: vi.fn(async () => {
        throw new Error('still failing');
      }),
    });
    await expect(status.getState().retryAll()).resolves.toBeUndefined();
    expect(status.getState().failures).toHaveLength(1);
  });
});
