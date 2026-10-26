import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SUBTASK_ROW_PATH = 'components/ui/SubtaskRow.tsx';
const SESSION_PATH = 'app/focus/session.tsx';

// read as text because SubtaskRow pulls in react-native. session.tsx builds its
// current step card by hand, so it must import RESTORE_LABEL instead of the literal
describe('"Restore original" copy has a single source', () => {
  it('SubtaskRow exports the literal copy', () => {
    const source = readFileSync(SUBTASK_ROW_PATH, 'utf8');
    const match = /export const RESTORE_LABEL = "([^"]*)";/.exec(source);
    expect(match?.[1]).toBe('Restore original');
  });

  it('app/focus/session.tsx never hardcodes the literal, only imports the constant', () => {
    const source = readFileSync(SESSION_PATH, 'utf8');
    expect(source).toMatch(
      /import\s*\{[^}]*\bRESTORE_LABEL\b[^}]*\}\s*from\s*["']@\/components\/ui\/SubtaskRow["']/,
    );
    expect(source).not.toContain('Restore original');
  });
});
