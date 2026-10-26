#!/usr/bin/env node
// every CONTRAST_MANIFEST pair passes WCAG AA (4.5:1 body, 3:1 large) in both
// appearances, and every token is covered. no epsilon: 4.487 against 4.5 fails
import palette from "../../utils/palette.cjs";

const { light, dark, CONTRAST_MANIFEST, NON_TEXT_TOKENS } = palette;

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r1 + m, g1 + m, b1 + m];
}

function parseHsl(value) {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(value);
  if (!m) throw new Error(`Not an hsl() color: ${value}`);
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
function relativeLuminance([r, g, b]) {
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(colorA, colorB) {
  const a = relativeLuminance(parseHsl(colorA));
  const b = relativeLuminance(parseHsl(colorB));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const THRESHOLD = { body: 4.5, large: 3 };
const failures = [];

for (const [appearance, tones] of [["light", light], ["dark", dark]]) {
  for (const { fg, bg, size, where } of CONTRAST_MANIFEST) {
    const need = THRESHOLD[size];
    const ratio = contrastRatio(tones[fg], tones[bg]);
    if (ratio < need) {
      failures.push(`${appearance}: ${fg} on ${bg} = ${ratio.toFixed(3)}:1, needs ${need}:1 (${size}) — ${where}`);
    }
  }
}

const covered = new Set(NON_TEXT_TOKENS);
for (const { fg, bg } of CONTRAST_MANIFEST) {
  covered.add(fg);
  covered.add(bg);
}
for (const token of Object.keys(light)) {
  if (!covered.has(token)) failures.push(`uncovered token (neither CONTRAST_MANIFEST nor NON_TEXT_TOKENS): ${token}`);
}

if (failures.length > 0) {
  console.error(`contrast: ${failures.length} failure(s)\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}

console.log(`contrast: OK — ${CONTRAST_MANIFEST.length} pair(s) checked in both appearances, ${Object.keys(light).length} tokens covered`);
