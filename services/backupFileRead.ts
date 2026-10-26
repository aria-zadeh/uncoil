// split out of backupFiles.ts so it runs in node, where expo-file-system can't be imported
import { BACKUP_LIMITS } from '@/services/backup';

// the slice of expo-file-system's File this needs
export interface TemporaryFile {
  readonly exists: boolean;
  // bytes
  readonly size: number;
  text(): Promise<string>;
  delete(): void;
}

export class BackupFileTooLargeError extends Error {
  constructor(readonly sizeBytes: number, readonly maxBytes: number) {
    super(`The backup file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`);
    this.name = 'BackupFileTooLargeError';
  }
}

// always deletes the file. the read is awaited inside try so finally can't delete it mid-read
export async function readAndDiscard(
  file: TemporaryFile,
  maxBytes: number = BACKUP_LIMITS.maxFileBytes,
): Promise<string> {
  try {
    if (file.size > maxBytes) throw new BackupFileTooLargeError(file.size, maxBytes);
    return await file.text();
  } finally {
    if (file.exists) file.delete();
  }
}
