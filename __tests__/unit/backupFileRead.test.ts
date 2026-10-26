import { describe, expect, it } from 'vitest';

import { BACKUP_LIMITS } from '@/services/backup';
import { BackupFileTooLargeError, readAndDiscard, type TemporaryFile } from '@/services/backupFileRead';

// a picked cache file whose read resolves only when the test says so
function slowFile(contents: string, size = contents.length) {
  const events: string[] = [];
  let resolveRead: (() => void) | null = null;
  let exists = true;
  const file: TemporaryFile = {
    get exists() {
      return exists;
    },
    size,
    text: () =>
      new Promise<string>((resolve, reject) => {
        events.push('read-start');
        resolveRead = () => {
          if (!exists) {
            reject(new Error('file was deleted before the read finished'));
            return;
          }
          events.push('read-end');
          resolve(contents);
        };
      }),
    delete: () => {
      exists = false;
      events.push('delete');
    },
  };
  return { file, events, finishRead: () => resolveRead?.() };
}

describe('readAndDiscard', () => {
  it('deletes the cache copy only after the read has finished', async () => {
    const { file, events, finishRead } = slowFile('{"format":"tether-backup"}');
    const pending = readAndDiscard(file);
    // let the try/finally run as far as it will before the read settles
    await Promise.resolve();
    await Promise.resolve();
    expect(events).not.toContain('delete');

    finishRead();
    await expect(pending).resolves.toBe('{"format":"tether-backup"}');
    expect(events).toEqual(['read-start', 'read-end', 'delete']);
  });

  it('deletes the cache copy when the read fails', async () => {
    const file: TemporaryFile = {
      exists: true,
      size: 10,
      text: async () => {
        throw new Error('read failed');
      },
      delete: () => {
        deleted = true;
      },
    };
    let deleted = false;
    await expect(readAndDiscard(file)).rejects.toThrow('read failed');
    expect(deleted).toBe(true);
  });

  it('rejects a file over the size limit without reading it, and still deletes it', async () => {
    const { file, events } = slowFile('x', BACKUP_LIMITS.maxFileBytes + 1);
    await expect(readAndDiscard(file)).rejects.toBeInstanceOf(BackupFileTooLargeError);
    expect(events).toEqual(['delete']);
  });

  it('accepts a file exactly at the limit', async () => {
    const { file, finishRead } = slowFile('{}', BACKUP_LIMITS.maxFileBytes);
    const pending = readAndDiscard(file);
    await Promise.resolve();
    finishRead();
    await expect(pending).resolves.toBe('{}');
  });
});
