import { describe, expect, it } from 'vitest';

import palette from '@/utils/palette.cjs';
import { SUBJECT_HUES, subjectHue, type SubjectHue } from '@/utils/subjectColor';

describe('subjectHue', () => {
  it('returns null when there is no subject to draw', () => {
    expect(subjectHue(null)).toBeNull();
    expect(subjectHue(undefined)).toBeNull();
    expect(subjectHue('')).toBeNull();
    expect(subjectHue('   ')).toBeNull();
  });

  it.each<[string, SubjectHue]>([
    ['Spanish', 'pink'],
    ['AP French', 'pink'],
    ['German 2', 'pink'],
    ['Latin', 'pink'],
    ['World Language', 'pink'],
    ['Español', 'pink'],
    ['Chemistry', 'teal'],
    ['AP Physics C', 'teal'],
    ['Science', 'teal'],
    ['Computer Science', 'teal'],
    ['English', 'yellow'],
    ['AP Literature', 'yellow'],
    ['Creative Writing', 'yellow'],
    ['AP Lit', 'yellow'],
    ['History', 'orange'],
    ['AP Government', 'orange'],
    ['Social Studies', 'orange'],
    ['Economics', 'orange'],
    ['Math', 'blue'],
    ['Calculus BC', 'blue'],
    ['Algebra 2', 'blue'],
    ['Pre-Algebra', 'blue'],
    ['Statistics', 'blue'],
    ['Stats', 'blue'],
    ['Geometry', 'blue'],
    ['Biology', 'green'],
    ['AP Bio', 'green'],
    ['Life Science', 'green'],
    ['Anatomy', 'green'],
  ])('puts %s on %s', (subject, hue) => {
    expect(subjectHue(subject)).toBe(hue);
  });

  it('lets the narrower group win where two keywords overlap', () => {
    // "science" alone is teal, but these name a different field first
    expect(subjectHue('Environmental Science')).toBe('green');
    expect(subjectHue('Political Science')).toBe('orange');
    // "language" alone is pink, but these are English
    expect(subjectHue('Language Arts')).toBe('yellow');
    expect(subjectHue('English Language')).toBe('yellow');
    // "chem" inside biochem is a biology course
    expect(subjectHue('Biochemistry')).toBe('green');
    // "lit" is a whole word, not a prefix: lithium is chemistry, not English
    expect(subjectHue('Lithium chemistry')).toBe('teal');
  });

  it('ignores case and extra whitespace', () => {
    expect(subjectHue('  bIoLoGy ')).toBe('green');
    expect(subjectHue('SOCIAL   STUDIES')).toBe('orange');
    expect(subjectHue('Robotics Club')).toBe(subjectHue('  robotics   club'));
  });

  it('hashes an unknown name into one of the six hues, the same one every time', () => {
    const names = ['Band', 'Art', 'Debate', 'Drama', 'Physical Education', 'Yearbook', 'Choir', 'Woodshop', 'Study Hall', 'Mock Trial'];
    for (const name of names) {
      const hue = subjectHue(name);
      expect(hue).not.toBeNull();
      expect(SUBJECT_HUES).toContain(hue);
      expect(subjectHue(name)).toBe(hue);
    }
  });

  it('spreads unknown names over more than one hue', () => {
    const names = ['Band', 'Art', 'Debate', 'Drama', 'Yearbook', 'Choir', 'Woodshop', 'Study Hall', 'Mock Trial', 'Orchestra', 'Photography', 'Ceramics'];
    const used = new Set(names.map((name) => subjectHue(name)));
    expect(used.size).toBeGreaterThan(2);
  });
});

describe('subject pill palette', () => {
  const capitalize = (hue: string) => hue.charAt(0).toUpperCase() + hue.slice(1);

  it('has a tint and an ink for every hue, in both appearances', () => {
    const light = palette.light as Record<string, string>;
    const dark = palette.dark as Record<string, string>;
    for (const hue of SUBJECT_HUES) {
      for (const part of ['Tint', 'Ink']) {
        const key = `subject${capitalize(hue)}${part}`;
        expect(light[key], `light.${key}`).toMatch(/^hsl\(/);
        expect(dark[key], `dark.${key}`).toMatch(/^hsl\(/);
      }
    }
  });

  it('checks every hue ink against its tint in CONTRAST_MANIFEST', () => {
    const pairs = palette.CONTRAST_MANIFEST.map((p) => `${p.fg}|${p.bg}`);
    for (const hue of SUBJECT_HUES) {
      const name = capitalize(hue);
      expect(pairs).toContain(`subject${name}Ink|subject${name}Tint`);
    }
  });
});
