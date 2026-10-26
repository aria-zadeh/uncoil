// a failed write retries with backoff, then surfaces through onFailure. nothing is dropped silently
import type { StorageKey } from '@/data/keys';
import type { Repository } from '@/data/repository';

export interface WriteFailure {
  key: StorageKey;
  attempts: number;
  error: unknown;
  // re-runs with the value that failed, not the latest one
  retry: () => Promise<void>;
}

export interface WriteQueueOptions {
  debounceMs?: number;
  // retries after the first attempt
  maxRetries?: number;
  backoffMs?: (attempt: number) => number;
  // called once retries run out
  onFailure?: (failure: WriteFailure) => void;
}

const DEFAULTS = {
  debounceMs: 300,
  maxRetries: 2,
  backoffMs: (attempt: number) => 100 * 2 ** attempt,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WriteQueue {
  private pending = new Map<StorageKey, unknown>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;

  private readonly debounceMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly onFailure: (failure: WriteFailure) => void;

  constructor(
    private readonly repository: Repository,
    options: WriteQueueOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULTS.debounceMs;
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.backoffMs = options.backoffMs ?? DEFAULTS.backoffMs;
    this.onFailure = options.onFailure ?? (() => {});
  }

  /** the last value per key inside the debounce window wins */
  queue<T>(key: StorageKey, value: T): void {
    this.pending.set(key, value);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.debounceMs);
  }

  get isDirty(): boolean {
    return this.pending.size > 0 || this.inFlight !== null;
  }

  // called when the app backgrounds, so a pending debounce can't die with the process
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // one drain isn't enough: the timer's drain can still be writing when ours returns,
    // and anything queued meanwhile would be left behind
    while (this.inFlight !== null || this.pending.size > 0) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      await this.drain();
    }
  }

  private async drain(): Promise<void> {
    // a loop, not one await: two drains waiting on the same batch both wake, and the
    // second must wait on the batch the first just started instead of writing on top
    while (this.inFlight) {
      await this.inFlight;
    }
    if (this.pending.size === 0) return;

    const batch = [...this.pending.entries()];
    this.pending.clear();

    const run = (async () => {
      for (const [key, value] of batch) {
        await this.writeWithRetry(key, value);
      }
    })();

    this.inFlight = run.finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  private async writeWithRetry(key: StorageKey, value: unknown): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        await this.repository.save(key, value);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt));
        }
      }
    }
    this.onFailure({
      key,
      attempts: this.maxRetries + 1,
      error: lastError,
      retry: () => this.writeWithRetry(key, value),
    });
  }
}
