import { describe, expect, it } from 'vitest';

import { previewInputOf, previewMatches } from '@/utils/breakdownPreview';

describe('previewMatches', () => {
  const snapshot = previewInputOf(' Essay ', 'English', 'Five paragraphs');

  it('matches the same input, ignoring surrounding whitespace', () => {
    expect(previewMatches(snapshot, previewInputOf('Essay', ' English ', 'Five paragraphs '))).toBe(true);
  });

  it('stops matching when the title changes, so stale steps are not saved', () => {
    expect(previewMatches(snapshot, previewInputOf('Lab report', 'English', 'Five paragraphs'))).toBe(false);
  });

  it('stops matching when the description changes', () => {
    expect(previewMatches(snapshot, previewInputOf('Essay', 'English', 'Three paragraphs'))).toBe(false);
  });

  it('stops matching when the subject changes', () => {
    expect(previewMatches(snapshot, previewInputOf('Essay', 'History', 'Five paragraphs'))).toBe(false);
  });
});
