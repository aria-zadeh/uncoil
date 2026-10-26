// platform half of backup: cache file, share sheet, document picker. backup.ts is the pure half
import { Directory, File, Paths } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';

import { readAndDiscard } from '@/services/backupFileRead';

export async function writeBackupAndShare(text: string, fileName: string): Promise<void> {
  const dir = new Directory(Paths.cache, 'backups');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

  const file = new File(dir, fileName);
  if (file.exists) file.delete();
  file.write(text);

  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      throw new Error('Sharing is not available on this device.');
    }
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      UTI: 'public.json',
    });
  } finally {
    // the share sheet is done with it. don't leave a second copy of the user's data on disk
    if (file.exists) file.delete();
  }
}

/** the picked file's text, or null if cancelled */
export async function pickBackupText(): Promise<string | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset === undefined) return null;
  // keep copyToCacheDirectory: on android the uri can be a content:// uri that File can't read.
  // readAndDiscard deletes the copy
  return readAndDiscard(new File(asset.uri));
}
