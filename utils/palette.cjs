// CommonJS because tailwind.config.js require()s it. no colour literal lives anywhere else
// every value is hsl(), the contrast scripts in scripts/verify parse only that form
// light and dark must declare the same keys
// one hue, one job: blue is action and choice, teal is progress, amber is medium, coral is urgent
"use strict";

const light = {
  primary: "hsl(216, 82%, 48%)",
  // the pressed shade, not the dark-appearance value
  primaryDark: "hsl(216, 82%, 40%)",
  primaryForeground: "hsl(0, 0%, 100%)",
  // separate so text-primary-deep sites keep compiling and get their own contrast pairs
  primaryDeep: "hsl(240, 10%, 6%)",

  // background is the screen and sub-panels, card is cards and controls,
  // elevated is tracks, the active tab disc and secondary fills
  background: "hsl(220, 22%, 97%)",
  card: "hsl(0, 0%, 100%)",
  elevated: "hsl(220, 18%, 93%)",

  // all three clear 4.5:1 on all three surfaces
  text: "hsl(240, 12%, 12%)",
  textSecondary: "hsl(232, 7%, 38%)",
  textMuted: "hsl(240, 5%, 42%)",

  border: "hsl(220, 15%, 88%)",

  // the base tone is for icons and fills, *Light is the chip fill, *Dark is the text shade.
  // text in this appearance always uses *Dark
  success: "hsl(172, 75%, 29%)",
  successLight: "hsl(172, 60%, 89%)",
  successDark: "hsl(175, 90%, 18%)",

  // dark enough to clear 3:1 as an icon
  warning: "hsl(34, 100%, 38%)",
  warningLight: "hsl(42, 100%, 88%)",
  warningDark: "hsl(28, 100%, 23%)",

  // also a solid fill under white text, so it's verified against dangerForeground
  danger: "hsl(6, 78%, 47%)",
  dangerLight: "hsl(6, 100%, 94%)",
  dangerDark: "hsl(4, 80%, 34%)",
  dangerForeground: "hsl(0, 0%, 100%)",
  // danger text for dark appearance. Tailwind resolves from colors.light only, so this
  // holds the bright value in both palettes and is only ever used behind dark:
  dangerBright: "hsl(6, 90%, 74%)",

  accent: "hsl(216, 82%, 48%)",
  accentLight: "hsl(216, 90%, 93%)",
  accentDark: "hsl(216, 82%, 36%)",
  accentPanel: "hsl(216, 80%, 97%)",

  selected: "hsl(216, 82%, 48%)",
  selectedLight: "hsl(216, 90%, 93%)",
  selectedDark: "hsl(216, 82%, 36%)",

  // gold despite the name, a blue segment would repeat the accent streak segment
  barBlue: "hsl(42, 100%, 36%)",
  barPink: "hsl(337, 76%, 61%)",

  dropzoneFill: "hsl(216, 80%, 97%)",
  dropzoneStroke: "hsl(216, 60%, 82%)",

  // subject pills, the one decorative use of hue. each ink-on-tint pair is in CONTRAST_MANIFEST
  subjectPinkTint: "hsl(340, 70%, 92%)",
  subjectPinkInk: "hsl(340, 68%, 40%)",
  subjectTealTint: "hsl(178, 70%, 92%)",
  subjectTealInk: "hsl(178, 68%, 27%)",
  subjectYellowTint: "hsl(46, 70%, 92%)",
  subjectYellowInk: "hsl(46, 78%, 27%)",
  subjectOrangeTint: "hsl(24, 48%, 92%)",
  subjectOrangeInk: "hsl(24, 46%, 37%)",
  subjectBlueTint: "hsl(212, 70%, 92%)",
  subjectBlueInk: "hsl(212, 70%, 40%)",
  subjectGreenTint: "hsl(92, 58%, 92%)",
  subjectGreenInk: "hsl(92, 56%, 29%)",
};

const dark = {
  primary: "hsl(216, 90%, 68%)",
  primaryDark: "hsl(216, 80%, 60%)",
  primaryForeground: "hsl(240, 10%, 6%)",
  primaryDeep: "hsl(0, 0%, 96%)",

  background: "hsl(230, 25%, 8%)",
  card: "hsl(230, 20%, 12%)",
  elevated: "hsl(230, 18%, 17%)",

  text: "hsl(240, 8%, 95%)",
  textSecondary: "hsl(240, 5%, 68%)",
  textMuted: "hsl(240, 4%, 62%)",

  border: "hsl(230, 15%, 22%)",

  // here the base tone is bright enough for text, *Dark is tuned for the deep *Light fills
  success: "hsl(172, 65%, 46%)",
  successLight: "hsl(172, 45%, 15%)",
  successDark: "hsl(172, 65%, 62%)",

  warning: "hsl(38, 95%, 55%)",
  warningLight: "hsl(38, 50%, 16%)",
  warningDark: "hsl(40, 100%, 68%)",

  // a mid tone so white still reads on it as a fill. any darker and it fails 3:1 as an icon
  danger: "hsl(6, 72%, 50%)",
  dangerLight: "hsl(8, 45%, 18%)",
  dangerDark: "hsl(8, 100%, 76%)",
  dangerForeground: "hsl(0, 0%, 100%)",
  dangerBright: "hsl(6, 90%, 74%)",

  accent: "hsl(216, 90%, 68%)",
  accentLight: "hsl(216, 45%, 21%)",
  accentDark: "hsl(216, 100%, 82%)",
  accentPanel: "hsl(218, 35%, 16%)",

  selected: "hsl(216, 90%, 70%)",
  selectedLight: "hsl(216, 45%, 21%)",
  selectedDark: "hsl(216, 100%, 82%)",

  barBlue: "hsl(44, 90%, 58%)",
  barPink: "hsl(337, 76%, 66%)",

  dropzoneFill: "hsl(218, 35%, 16%)",
  dropzoneStroke: "hsl(216, 35%, 34%)",

  subjectPinkTint: "hsl(340, 33%, 19%)",
  subjectPinkInk: "hsl(340, 80%, 69%)",
  subjectTealTint: "hsl(178, 33%, 19%)",
  subjectTealInk: "hsl(178, 80%, 60%)",
  subjectYellowTint: "hsl(46, 39%, 19%)",
  subjectYellowInk: "hsl(46, 90%, 60%)",
  subjectOrangeTint: "hsl(24, 21%, 19%)",
  subjectOrangeInk: "hsl(24, 58%, 62%)",
  subjectBlueTint: "hsl(212, 34%, 19%)",
  subjectBlueInk: "hsl(212, 82%, 65%)",
  subjectGreenTint: "hsl(92, 26%, 19%)",
  subjectGreenInk: "hsl(92, 68%, 60%)",
};

const shadowColor = "hsl(240, 20%, 20%)";

// every text pair, checked in both appearances by scripts/verify/a11y.mjs. body is 4.5:1, large 3:1.
// the @type {const} cast keeps the literals, without it the design-tokens checks pass vacuously
const CONTRAST_MANIFEST = /** @type {const} */ ([
  { fg: "text", bg: "background", size: "body", where: "Ink text directly on the screen ground and inside sub-panels" },
  { fg: "text", bg: "card", size: "body", where: "Card titles, row labels and chip values inside a card" },
  { fg: "text", bg: "elevated", size: "body", where: "Active segment label; text on the secondary button" },
  { fg: "text", bg: "accentLight", size: "body", where: "Title on the suggested-time banner" },
  { fg: "text", bg: "selectedLight", size: "body", where: "Text on a selected fill where the plain ink is kept" },
  { fg: "text", bg: "accentPanel", size: "body", where: "The proposed time on the suggested-time panel" },

  { fg: "textSecondary", bg: "background", size: "body", where: "Descriptions and the time gutter on the screen ground; panel labels in a sub-panel" },
  { fg: "textSecondary", bg: "card", size: "body", where: "Card descriptions, count chips, inactive tab glyphs, settings chevrons" },
  { fg: "textSecondary", bg: "elevated", size: "body", where: "Inactive segment labels on the segmented track" },
  { fg: "textSecondary", bg: "accentLight", size: "body", where: "Caption on the suggested-time banner" },
  { fg: "textSecondary", bg: "dropzoneFill", size: "body", where: "Dropzone hint line" },
  { fg: "textSecondary", bg: "accentPanel", size: "body", where: "The 'Suggested time' label on the suggested-time panel" },

  { fg: "textMuted", bg: "background", size: "body", where: "Struck-through checklist text in a sub-panel" },
  { fg: "textMuted", bg: "card", size: "body", where: "Struck-through checklist text in a card" },
  { fg: "textMuted", bg: "elevated", size: "body", where: "TimerDisplay paused state; muted text on elevated fill" },
  { fg: "textMuted", bg: "accentLight", size: "body", where: "Muted caption on the suggested-time banner" },

  { fg: "primaryForeground", bg: "primary", size: "body", where: "Primary button label; the FAB glyph" },
  { fg: "primaryForeground", bg: "primaryDark", size: "body", where: "Primary action label, pressed state (active:bg-primary-dark)" },

  { fg: "primaryDeep", bg: "background", size: "body", where: "text-primary-deep body text/icon tint directly on the screen ground" },
  { fg: "primaryDeep", bg: "card", size: "body", where: "text-primary-deep body text/icon tint inside a card" },
  { fg: "primaryDeep", bg: "elevated", size: "body", where: "text-primary-deep body text/icon tint on elevated fill" },

  { fg: "dangerForeground", bg: "danger", size: "body", where: "Button danger variant label" },

  { fg: "successDark", bg: "successLight", size: "body", where: "Done chip label on its teal fill" },
  { fg: "successDark", bg: "card", size: "body", where: "Teal text or glyph directly on a card" },
  { fg: "warningDark", bg: "warningLight", size: "body", where: "Medium chip label on its amber fill" },
  { fg: "warningDark", bg: "card", size: "body", where: "Amber text or glyph directly on a card" },
  { fg: "dangerDark", bg: "dangerLight", size: "body", where: "Hard or overdue chip label on its coral fill" },
  { fg: "dangerDark", bg: "card", size: "body", where: "Delete row label directly on a card" },
  { fg: "accentDark", bg: "accentLight", size: "body", where: "Suggested-time banner text" },
  { fg: "accentDark", bg: "card", size: "body", where: "Accent blue text directly on a card" },
  { fg: "accentDark", bg: "accentPanel", size: "body", where: "Sparkle glyph on the suggested-time panel" },
  { fg: "selectedDark", bg: "selectedLight", size: "body", where: "Selected day number; selected chip label" },
  { fg: "selectedDark", bg: "card", size: "body", where: "Blue text directly on a card" },
  { fg: "selectedDark", bg: "background", size: "body", where: "Blue text directly on the screen ground" },

  { fg: "primaryForeground", bg: "accent", size: "body", where: "White check inside a checked checkbox" },
  { fg: "primaryForeground", bg: "selected", size: "body", where: "White (ink in dark) on a solid selected fill" },

  { fg: "subjectPinkInk", bg: "subjectPinkTint", size: "body", where: "Subject pill, languages (pink)" },
  { fg: "subjectTealInk", bg: "subjectTealTint", size: "body", where: "Subject pill, chemistry, physics and science (teal)" },
  { fg: "subjectYellowInk", bg: "subjectYellowTint", size: "body", where: "Subject pill, English and writing (yellow)" },
  { fg: "subjectOrangeInk", bg: "subjectOrangeTint", size: "body", where: "Subject pill, history and social studies (orange)" },
  { fg: "subjectBlueInk", bg: "subjectBlueTint", size: "body", where: "Subject pill, math (blue)" },
  { fg: "subjectGreenInk", bg: "subjectGreenTint", size: "body", where: "Subject pill, biology (green)" },
]);

// tokens that never carry text. every key of light must be here or in CONTRAST_MANIFEST
const NON_TEXT_TOKENS = /** @type {const} */ ([
  // decorative hairline
  "border",
  // fills and dots beside a label, teal text uses successDark
  "success",
  // icon and dot, 3.80:1 on card
  "warning",
  // icon and solid fill, verified against dangerForeground
  "danger",
  // fills and dots, accentDark is the text shade
  "accent",
  // borders, the active tab glyph and the dropzone icon, at least 4.32:1 wherever it sits
  "selected",
  // bar segments and swatches, each beside a label
  "barBlue",
  "barPink",
  // a fill, textSecondary on it is in CONTRAST_MANIFEST
  "dropzoneFill",
  // decorative outline
  "dropzoneStroke",
  // this one is text, but it's bright in both palettes so no literal pair passes on the pale
  // surfaces. measured by hand on the dark ones: 8.2 background, 7.5 card, 6.5 elevated
  "dangerBright",
]);

module.exports = { light, dark, shadowColor, CONTRAST_MANIFEST, NON_TEXT_TOKENS };
