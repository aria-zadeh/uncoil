#!/usr/bin/env node
// accessibility statics and WCAG AA contrast.
// part 1: every touchable has a role and a label. part 2: declared token pairs pass
// in both appearances. part 3: className strings in markup resolved back to real
// colors, because bare tones used as small text fail AA and the manifest never sees them.
// <Button> call sites are skipped: Button.tsx sets the role and defaults the label to
// `title`, and the Pressable inside it is scanned like any other
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import palette from '../../utils/palette.cjs';
import tailwind from '../../tailwind.config.js';
import { walk } from './walk.mjs';

const { light, dark, CONTRAST_MANIFEST, NON_TEXT_TOKENS } = palette;
const ROOT = process.cwd();
const violations = [];

const AA_BODY = 4.5;
const AA_LARGE = 3.0;

// WCAG 2.1, no epsilon: 4.487 against 4.5 fails

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

function parseColor(value) {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(String(value));
  if (!m) return null;
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

function luminance([r, g, b]) {
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// part 1: touchables carry a role and a label

const TOUCHABLES = ['Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback'];

// Button stays out on purpose: its call sites are not scanned, aliased or not
const ALIASABLE = new Set(TOUCHABLES);

// `import { Pressable as Tap }` would otherwise hide every <Tap> from a tag-name scan
function reactNativeAliases(source) {
  const aliases = new Map();
  const importRe = /import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]react-native['"]/g;
  let m;
  while ((m = importRe.exec(source)) !== null) {
    for (const spec of m[1].split(',')) {
      const asMatch = /^\s*(\w+)\s+as\s+(\w+)\s*$/.exec(spec);
      if (!asMatch) continue;
      const [, real, alias] = asMatch;
      if (ALIASABLE.has(real) && alias !== real) aliases.set(alias, real);
    }
  }
  return aliases;
}

function reactNativeNamespaces(source) {
  const namespaces = [];
  const nsRe = /import\s*\*\s*as\s+([\w$]+)\s*from\s*['"]react-native['"]/g;
  let m;
  while ((m = nsRe.exec(source)) !== null) namespaces.push(m[1]);
  return namespaces;
}

function namesFor(realName, aliases, namespaces) {
  const names = [realName];
  for (const [alias, real] of aliases) if (real === realName) names.push(alias);
  for (const ns of namespaces) names.push(`${ns}.${realName}`);
  return names;
}

function isNonLabelingExpression(expr) {
  const trimmed = expr.trim();
  if (trimmed.startsWith('/*') && trimmed.endsWith('*/')) return true;
  if (trimmed === 'null' || trimmed === 'undefined' || trimmed === 'false') return true;
  const m = /^(['"`])([\s\S]*)\1$/.exec(trimmed);
  if (!m) return false;
  return m[2].trim() === '';
}

function hasRealTextContent(content) {
  let literal = '';
  let i = 0;
  while (i < content.length) {
    if (content[i] === '{') {
      let depth = 1;
      let j = i + 1;
      let quote = null;
      while (j < content.length && depth > 0) {
        const ch = content[j];
        if (quote) {
          if (ch === quote && content[j - 1] !== '\\') quote = null;
        } else if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch;
        } else if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
        }
        j += 1;
      }
      const expr = content.slice(i + 1, j - 1);
      if (!isNonLabelingExpression(expr)) return true;
      i = j;
    } else {
      literal += content[i];
      i += 1;
    }
  }
  return literal.trim() !== '';
}

function hasLabelingTextChild(body) {
  const pattern = /<Text(?=[\s/>])/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const attrs = openingTag(body, match.index + 'Text'.length + 1);
    if (attrs === null) continue;
    if (/\/\s*$/.test(attrs)) continue; // <Text />, no content
    const inner = elementBody(body, match.index + 'Text'.length + attrs.length + 2, 'Text');
    if (hasRealTextContent(inner)) return true;
  }
  return false;
}

// tracks braces and quotes so `onPress={() => f({a: 1})}` does not end the tag early
function openingTag(source, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote && source[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(from, i);
  }
  return null;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function elementBody(source, afterOpen, name) {
  const open = new RegExp(`<${name}(?=[\\s/>])`, 'g');
  const close = new RegExp(`</${name}>`, 'g');
  let depth = 1;
  let cursor = afterOpen;
  while (depth > 0) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(source);
    const nextClose = close.exec(source);
    if (!nextClose) return source.slice(afterOpen);
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      cursor = nextOpen.index + 1;
    } else {
      depth -= 1;
      if (depth === 0) return source.slice(afterOpen, nextClose.index);
      cursor = nextClose.index + 1;
    }
  }
  return '';
}

function checkTouchables(rel, source) {
  const aliases = reactNativeAliases(source);
  const namespaces = reactNativeNamespaces(source);
  for (const realName of TOUCHABLES) {
    for (const name of namesFor(realName, aliases, namespaces)) {
      const pattern = new RegExp(`<${name}(?=[\\s/>])`, 'g');
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const attrs = openingTag(source, match.index + name.length + 1);
        if (attrs === null) continue;
        const line = lineOf(source, match.index);
        const isNamespaced = name.includes('.') && namespaces.includes(name.split('.')[0]);
        const tag =
          name === realName
            ? `<${name}>`
            : isNamespaced
              ? `<${name}> (namespace import of ${realName})`
              : `<${name}> (${realName} imported as ${name})`;

        // a spread is not enough, the tag must declare its own: a caller's props can
        // override whatever the spreading component set
        const hasRole = /\baccessibilityRole\s*=/.test(attrs);
        const hasLabel = /\baccessibility(Label|LabelledBy|labelledby)\s*=/.test(attrs);

        // accessible={false} is fine on a wrapper that only swallows taps (a modal card
        // stopping the backdrop). with a press handler it is a control voiceover cannot
        // reach. these four are the full handler set in this RN version. either way there
        // is nothing to label
        if (/\baccessible\s*=\s*\{\s*false\s*\}/.test(attrs)) {
          if (/\bon(?:Press|LongPress|PressIn|PressOut)\s*=/.test(attrs)) {
            violations.push({
              rel,
              line,
              kind: 'interactive control removed from accessibility tree',
              detail: `${tag} has accessible={false} and a press handler; it is unreachable to a screen reader but still interactive`,
            });
          }
          continue;
        }

        // react native reads a descendant Text as the label, so a button wrapping its own
        // caption passes. icon-only, or an empty Text, does not
        const body = elementBody(source, match.index + name.length + attrs.length + 2, name);
        const hasTextChild = hasLabelingTextChild(body);

        if (!hasRole) {
          violations.push({ rel, line, kind: 'missing accessibilityRole', detail: tag });
        }
        if (!hasLabel && !hasTextChild) {
          violations.push({
            rel,
            line,
            kind: 'missing accessibilityLabel',
            detail: `${tag} has no label and no Text child to serve as one`,
          });
        }
      }
    }
  }
}

// part 2: declared token pairs, both appearances

function checkManifest() {
  for (const pair of CONTRAST_MANIFEST) {
    const threshold = pair.size === 'large' ? AA_LARGE : AA_BODY;
    for (const [appearance, scheme] of [
      ['light', light],
      ['dark', dark],
    ]) {
      const fg = parseColor(scheme[pair.fg]);
      const bg = parseColor(scheme[pair.bg]);
      if (!fg || !bg) {
        violations.push({
          rel: 'utils/palette.cjs',
          line: 0,
          kind: 'unresolvable manifest pair',
          detail: `${pair.fg} on ${pair.bg} in ${appearance}`,
        });
        continue;
      }
      const r = ratio(fg, bg);
      if (r < threshold) {
        violations.push({
          rel: 'utils/palette.cjs',
          line: 0,
          kind: 'contrast below AA',
          detail: `${pair.fg} on ${pair.bg} (${appearance}) is ${r.toFixed(2)}:1, needs ${threshold}:1 — ${pair.where}`,
        });
      }
    }
  }

  // every token must be in one list, or a new one escapes the check
  const covered = new Set([
    ...CONTRAST_MANIFEST.flatMap((p) => [p.fg, p.bg]),
    ...NON_TEXT_TOKENS,
  ]);
  for (const key of Object.keys(light)) {
    if (!covered.has(key)) {
      violations.push({
        rel: 'utils/palette.cjs',
        line: 0,
        kind: 'token covered by nothing',
        detail: `${key} appears in neither CONTRAST_MANIFEST nor NON_TEXT_TOKENS`,
      });
    }
  }
}

// part 3: tailwind classes as written in markup

// built from the config so a new color is covered without editing this file
function classColorMap() {
  const map = new Map();
  const colors = tailwind.theme?.extend?.colors ?? {};
  for (const [group, value] of Object.entries(colors)) {
    if (typeof value === 'string') {
      map.set(group, value);
      continue;
    }
    for (const [shade, color] of Object.entries(value)) {
      map.set(shade === 'DEFAULT' ? group : `${group}-${shade}`, color);
    }
  }
  return map;
}

// text with no background of its own inherits one of these, so it must pass on all three
const SURFACES = ['background', 'card', 'elevated'];

// icons are graphics: WCAG 1.4.11 asks 3:1, not the 4.5:1 for text
const ICON_ELEMENTS = new Set(['Ionicons', 'MaterialIcons', 'MaterialCommunityIcons', 'Feather', 'FontAwesome', 'AntDesign', 'Entypo', 'Octicons', 'SymbolView', 'IconSymbol']);
const AA_NON_TEXT = 3.0;

function elementFor(source, index) {
  const before = source.slice(Math.max(0, index - 400), index);
  const matches = [...before.matchAll(/<([A-Z][A-Za-z0-9_.]*)/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : '';
}

const COLOR_MAP = classColorMap();

function splitVariant(cls) {
  return cls.startsWith('dark:')
    ? { appearance: 'dark', bare: cls.slice(5) }
    : { appearance: 'light', bare: cls };
}

function colorOf(bare, prefix) {
  if (!bare.startsWith(`${prefix}-`)) return null;
  const suffix = bare.slice(prefix.length + 1);
  return COLOR_MAP.has(suffix) ? parseColor(COLOR_MAP.get(suffix)) : null;
}

function checkClassPairs(rel, source) {
  const classAttr = /className\s*=\s*(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g;
  let match;
  while ((match = classAttr.exec(source)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').split(/\s+/).filter(Boolean);
    const line = lineOf(source, match.index);

    // interpolated parts of a template class list are checked where they are written
    const classes = raw.map(splitVariant);
    const element = elementFor(source, match.index);
    const isIcon = ICON_ELEMENTS.has(element);
    const isLarge = raw.some((c) => ['text-title', 'text-heading', 'text-display'].includes(c));
    const threshold = isIcon ? AA_NON_TEXT : isLarge ? AA_LARGE : AA_BODY;

    for (const appearance of ['light', 'dark']) {
      const scheme = appearance === 'light' ? light : dark;
      const texts = classes.filter((c) => c.appearance === appearance && colorOf(c.bare, 'text'));
      const backgrounds = classes.filter((c) => c.appearance === appearance && colorOf(c.bare, 'bg'));
      if (texts.length === 0) continue;

      for (const text of texts) {
        const fg = colorOf(text.bare, 'text');

        if (backgrounds.length > 0) {
          // its own background is the pair the user sees
          for (const background of backgrounds) {
            const bg = colorOf(background.bare, 'bg');
            const r = ratio(fg, bg);
            if (r < threshold) {
              violations.push({
                rel,
                line,
                kind: 'contrast below AA',
                detail: `${text.bare} on ${background.bare} (${appearance}) is ${r.toFixed(2)}:1, needs ${threshold}:1${isIcon ? ' (icon tint)' : ''}`,
              });
            }
          }
          continue;
        }

        for (const surface of SURFACES) {
          const bg = parseColor(scheme[surface]);
          if (!bg) continue;
          const r = ratio(fg, bg);
          if (r < threshold) {
            violations.push({
              rel,
              line,
              kind: 'contrast below AA',
              detail: `<${element || '?'}> ${text.bare} on the ${surface} surface (${appearance}) is ${r.toFixed(2)}:1, needs ${threshold}:1${isIcon ? ' (icon tint)' : ''}`,
            });
          }
        }
      }
    }
  }
}

const COMPONENT_EXTS = ['.tsx', '.jsx', '.js'];
const files = [];
for (const dir of ['app', 'components']) walk(join(ROOT, dir), ROOT, files);
const components = files.filter((f) => COMPONENT_EXTS.some((ext) => f.endsWith(ext)));
for (const rel of components) {
  // walk() reads the git index, which can still list a file just deleted from disk
  let source;
  try {
    source = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  checkTouchables(rel, source);
  checkClassPairs(rel, source);
}
checkManifest();

if (violations.length === 0) {
  console.log(
    `a11y: clean across ${components.length} components, ${CONTRAST_MANIFEST.length} declared pairs in both appearances.`,
  );
  process.exit(0);
}

const byKind = new Map();
for (const v of violations) byKind.set(v.kind, (byKind.get(v.kind) ?? 0) + 1);

for (const v of violations) {
  console.error(`${v.rel}:${v.line}  [${v.kind}] ${v.detail}`);
}
console.error('');
for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
  console.error(`  ${String(count).padStart(4)}  ${kind}`);
}
console.error(`\n${violations.length} accessibility violations.`);
process.exit(1);
