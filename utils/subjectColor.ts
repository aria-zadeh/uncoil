// known subjects get a fixed hue by keyword. anything else hashes into the six, so a
// name keeps its hue across launches

export type SubjectHue = 'pink' | 'teal' | 'yellow' | 'orange' | 'blue' | 'green';

// the hash indexes into this, so reordering changes every hashed subject's colour
export const SUBJECT_HUES: readonly SubjectHue[] = ['pink', 'teal', 'yellow', 'orange', 'blue', 'green'];

// first match wins, so a narrow group must come before a broad one that would swallow it
// ("environmental science" is green, not teal)
const KEYWORD_GROUPS: readonly (readonly [SubjectHue, RegExp])[] = [
  ['green', /\b(?:bio|life science|anatom|physiolog|ecolog|environment|botan|zoolog|genetic|marine|health)/],
  ['yellow', /\b(?:english|literat|writ|composition|language arts|journalism|poetry|rhetoric|essay|grammar|reading)|\b(?:ela|lit)\b/],
  ['pink', /\b(?:span|espa|french|fran[cç]ais|german|deutsch|latin|italian|portuguese|chinese|mandarin|japanese|korean|arabic|russian|hebrew|greek|foreign|esl)|language/],
  ['orange', /\b(?:history|government|gov|civics|social|politic|econom|geograph|sociolog|psycholog|anthropolog|world cultures)/],
  ['teal', /\b(?:chem|physics|science|astronom|geolog|earth|engineer|robotic|computer|coding|programming)/],
  ['blue', /\b(?:math|calc|algebra|statistic|geometry|geom|trig|precalc|arithmetic|finance|accounting)|\bstats?\b/],
];

// FNV-1a, stable across platforms
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function subjectHue(subject: string | null | undefined): SubjectHue | null {
  const name = (subject ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!name) return null;
  for (const [hue, pattern] of KEYWORD_GROUPS) {
    if (pattern.test(name)) return hue;
  }
  return SUBJECT_HUES[hash(name) % SUBJECT_HUES.length];
}
