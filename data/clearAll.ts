// removes whatever keys() reports, legacy keys and leftover backups included.
// allSettled so one failed remove doesn't stop the rest and failedKeys says what survived
import type { Repository } from '@/data/repository';
import type { StorageKey } from '@/data/keys';

export class ClearAllDataError extends Error {
  readonly failedKeys: readonly StorageKey[];

  constructor(failedKeys: readonly StorageKey[]) {
    super(
      `clearAllData: failed to remove ${failedKeys.length} key(s): ${failedKeys.join(', ')}`,
    );
    this.name = 'ClearAllDataError';
    this.failedKeys = failedKeys;
  }
}

export async function clearAllData(repository: Repository): Promise<void> {
  const keys = await repository.keys();
  const results = await Promise.allSettled(keys.map((key) => repository.remove(key)));
  const failedKeys = keys.filter((_, i) => results[i].status === 'rejected');
  if (failedKeys.length > 0) {
    throw new ClearAllDataError(failedKeys);
  }
}
