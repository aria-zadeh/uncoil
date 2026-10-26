// typed glue over palette.cjs, which tailwind.config.js reads too. no colour literals here
import palette from "./palette.cjs";

const { light, dark, shadowColor, CONTRAST_MANIFEST: RAW_CONTRAST_MANIFEST, NON_TEXT_TOKENS: RAW_NON_TEXT_TOKENS } = palette;

export const colors = {
  light,
  dark,
} as const;

// light and dark must declare the same keys. a missing one is a tsc error here, not
// an undefined colour on a device
const _darkParity: Record<keyof typeof colors.light, string> = colors.dark;
const _lightParity: Record<keyof typeof colors.dark, string> = colors.light;
void _darkParity;
void _lightParity;

export type ColorName = keyof typeof colors.light;
export type TextSize = "body" | "large"; // 4.5:1 and 3:1

export interface ContrastPair {
  readonly fg: ColorName;
  readonly bg: ColorName;
  readonly size: TextSize;
  readonly where: string;
}

// the data lives in palette.cjs so scripts/verify/a11y.mjs can read it without TypeScript
export const CONTRAST_MANIFEST: readonly ContrastPair[] = RAW_CONTRAST_MANIFEST as readonly ContrastPair[];

// each entry says in palette.cjs why it never carries text
export const NON_TEXT_TOKENS: readonly ColorName[] = RAW_NON_TEXT_TOKENS as readonly ColorName[];

// every colour token must be in the manifest or NON_TEXT_TOKENS, or _AssertNever fails.
// uses the raw imports because the typed exports above are widened and would pass vacuously
type _ManifestTokens =
  | (typeof RAW_CONTRAST_MANIFEST)[number]["fg"]
  | (typeof RAW_CONTRAST_MANIFEST)[number]["bg"];
type _NonTextTokens = (typeof RAW_NON_TEXT_TOKENS)[number];
type _Uncovered = Exclude<ColorName, _ManifestTokens | _NonTextTokens>;
type _AssertNever<T extends never> = T;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AllColorTokensCovered = _AssertNever<_Uncovered>;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  "2xl": 32,
  "3xl": 40,
  "4xl": 48,
  "5xl": 64,
} as const;

// tailwind.config.js borderRadius carries the same names
export const borderRadius = {
  "2xs": 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;

// React Native picks a static face by family name, not fontWeight, so each weight is its
// own family. must match useFonts in app/_layout.tsx and fontFamily in tailwind.config.js
export const fontFamily = {
  regular: "InstrumentSans_400Regular",
  medium: "InstrumentSans_500Medium",
  semibold: "InstrumentSans_600SemiBold",
} as const;

// tailwind.config.js fontSize carries the same names and sizes. letterSpacing goes on via style
export const typography = {
  display: { fontSize: 32, lineHeight: 40, fontWeight: "500" as const, fontFamily: fontFamily.medium, letterSpacing: -0.6 },
  title: { fontSize: 26, lineHeight: 32, fontWeight: "500" as const, fontFamily: fontFamily.medium, letterSpacing: -0.4 },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: "500" as const, fontFamily: fontFamily.medium, letterSpacing: -0.2 },
  subheading: { fontSize: 18, lineHeight: 24, fontWeight: "500" as const, fontFamily: fontFamily.medium, letterSpacing: -0.1 },
  body: { fontSize: 15, lineHeight: 22, fontWeight: "400" as const, fontFamily: fontFamily.regular, letterSpacing: 0 },
  bodyMedium: { fontSize: 15, lineHeight: 22, fontWeight: "500" as const, fontFamily: fontFamily.medium, letterSpacing: 0 },
  caption: { fontSize: 14, lineHeight: 20, fontWeight: "400" as const, fontFamily: fontFamily.regular, letterSpacing: 0 },
  small: { fontSize: 13, lineHeight: 18, fontWeight: "500" as const, fontFamily: fontFamily.medium, letterSpacing: 0 },
} as const;

export const shadows = {
  sm: {
    shadowColor,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 2,
  },
  lg: {
    shadowColor,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 8,
  },
} as const;

// ms. exits are shorter than enters, nothing runs longer than sheet
export const motion = {
  press: 150,
  enter: 220,
  exit: 160,
  sheet: 300,
  shimmer: 1000,
  stagger: 50,
  // later items share this one's delay so a long list never crawls
  staggerMax: 6,
} as const;

// the palette is near monochrome, so the press itself is what shows a thing is tappable
export const press = {
  scale: 0.97,
  // light surfaces darken, dark ones lighten
  overlay: 0.1,
  rise: 8,
} as const;

// press and settle are underdamped (ratios 0.56 and 0.71), a small overshoot over short distances.
// sheet is critically damped because settle's overshoot over a full screen is about 40 pt
export const springs = {
  press: { damping: 18, stiffness: 260 },
  settle: { damping: 20, stiffness: 200 },
  sheet: { damping: 30, stiffness: 220, mass: 1 },
} as const;

// Apple HIG minimum
export const TOUCH_TARGET_MIN = 44;
export const TOUCH_TARGET_PRIMARY = 52;
export const BUTTON_MIN_HEIGHT = 52;
// added above insets.bottom so the floating tab bar never covers the last card
export const TAB_BAR_CLEARANCE = 112;
// outline glyphs everywhere except the active tab and the checked box
export const ICON_SIZE = {
  chip: 14,
  inline: 18,
  row: 22,
  action: 20,
  tab: 24,
  fab: 24,
  hero: 40,
} as const;
export const CHECKBOX_SIZE = 18;
export const CARD_CHECK_SIZE = 24;
// 1, not StyleSheet.hairlineWidth, which is too faint on 3x displays
export const HAIRLINE = 1;
export const CIRCLE_BUTTON = 44;
export const AVATAR_SIZE = 56;
export const SEGMENT_TRACK = { height: 44, inset: 4 } as const;
export const ANALYTICS_MIN_SEGMENT = 16;
export const CHIP_HEIGHT = {
  sm: 24,
  md: 28,
  select: 36,
  field: 44,
} as const;
export const TAB_PILL = {
  height: 56,
  slot: 48,
  inset: 4,
  gap: 12,
} as const;
export const FAB_SIZE = 56;
export const WEEK_DISC = 36;
export const GUTTER_WIDTH = 52;
