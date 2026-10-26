// seeds through importAllData so the pre-import backup, flush and resync all happen and the
// seed can be undone. runtime.ts must never import this file
import { CURRENT_SCHEMA_VERSION } from '@/data/migrations';
import { buildBackup, serializeBackup } from '@/services/backup';
import { generateDemoData } from '@/services/demoSeed';
import { getSettingsSnapshot, importAllData } from '@/store/runtime';
import type { ImportResult } from '@/store/importData';

// __DEV__ doesn't exist at all in node tests, it isn't just false
function isDevBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

// dev builds only. passes the live settings back through, since import replaces settings
// wholesale and defaults would reset the student's choices and rerun onboarding
export async function seedDemoData(): Promise<ImportResult> {
  if (!isDevBuild()) {
    return {
      ok: false,
      reason: 'invalid-shape',
      detail: 'Demo data can only be seeded in a development build.',
    };
  }

  const now = new Date();
  const demo = generateDemoData(now);
  const file = buildBackup({
    tasks: demo.tasks,
    sessions: demo.sessions,
    signals: demo.signals,
    settings: getSettingsSnapshot(),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    now,
  });

  return importAllData(serializeBackup(file));
}
