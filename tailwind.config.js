/** @type {import('tailwindcss').Config} */
const palette = require("./utils/palette.cjs");

// tailwind only sees palette.light, so `dark:text-accent` would render the light
// accent and fail contrast on dark surfaces. the `-bright`, `-bright-light` and
// `-bright-dark` aliases expose palette.dark values; write them only behind `dark:`.
// pair fill and text on one element: `bg-primary dark:bg-primary-bright` with
// `text-primary-foreground dark:text-primary-bright-foreground`

module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
    "./utils/**/*.{js,ts}",
  ],
  presets: [require("nativewind/preset")],
  darkMode: "class",
  theme: {
    extend: {
      // every value comes from utils/palette.cjs, shared with utils/design-tokens.ts.
      // no color literals here
      colors: {
        // `dark` is the pressed shade, not dark appearance
        primary: {
          DEFAULT: palette.light.primary,
          dark: palette.light.primaryDark,
          foreground: palette.light.primaryForeground,
          deep: palette.light.primaryDeep,
          bright: palette.dark.primary,
          "bright-dark": palette.dark.primaryDark,
          "bright-foreground": palette.dark.primaryForeground,
        },
        surface: {
          DEFAULT: palette.light.background,
          card: palette.light.card,
          elevated: palette.light.elevated,
          dark: palette.dark.background,
          "dark-card": palette.dark.card,
          "dark-elevated": palette.dark.elevated,
        },
        content: {
          DEFAULT: palette.light.text,
          secondary: palette.light.textSecondary,
          muted: palette.light.textMuted,
          // text on a surface that is always dark, whatever the appearance
          inverse: palette.dark.text,
          "dark-primary": palette.dark.text,
          "dark-secondary": palette.dark.textSecondary,
          "dark-muted": palette.dark.textMuted,
        },
        // `dark` is the readable text shade on the matching `light` fill
        success: {
          DEFAULT: palette.light.success,
          light: palette.light.successLight,
          dark: palette.light.successDark,
          bright: palette.dark.success,
          "bright-light": palette.dark.successLight,
          "bright-dark": palette.dark.successDark,
        },
        warning: {
          DEFAULT: palette.light.warning,
          light: palette.light.warningLight,
          dark: palette.light.warningDark,
          bright: palette.dark.warning,
          "bright-light": palette.dark.warningLight,
          "bright-dark": palette.dark.warningDark,
        },
        danger: {
          DEFAULT: palette.light.danger,
          light: palette.light.dangerLight,
          dark: palette.light.dangerDark,
          foreground: palette.light.dangerForeground,
          // its own palette token, same value in both appearances
          bright: palette.light.dangerBright,
          "bright-light": palette.dark.dangerLight,
          "bright-dark": palette.dark.dangerDark,
        },
        border: {
          DEFAULT: palette.light.border,
          dark: palette.dark.border,
        },
        accent: {
          DEFAULT: palette.light.accent,
          light: palette.light.accentLight,
          dark: palette.light.accentDark,
          panel: palette.light.accentPanel,
          bright: palette.dark.accent,
          "bright-light": palette.dark.accentLight,
          "bright-dark": palette.dark.accentDark,
          "panel-bright": palette.dark.accentPanel,
        },
        // DEFAULT is the border, `light` the fill, `dark` the text on it
        selected: {
          DEFAULT: palette.light.selected,
          light: palette.light.selectedLight,
          dark: palette.light.selectedDark,
          bright: palette.dark.selected,
          "bright-light": palette.dark.selectedLight,
          "bright-dark": palette.dark.selectedDark,
        },
        bar: {
          blue: palette.light.barBlue,
          pink: palette.light.barPink,
          "blue-bright": palette.dark.barBlue,
          "pink-bright": palette.dark.barPink,
        },
        subject: {
          "pink-tint": palette.light.subjectPinkTint,
          "pink-ink": palette.light.subjectPinkInk,
          "pink-tint-bright": palette.dark.subjectPinkTint,
          "pink-ink-bright": palette.dark.subjectPinkInk,
          "teal-tint": palette.light.subjectTealTint,
          "teal-ink": palette.light.subjectTealInk,
          "teal-tint-bright": palette.dark.subjectTealTint,
          "teal-ink-bright": palette.dark.subjectTealInk,
          "yellow-tint": palette.light.subjectYellowTint,
          "yellow-ink": palette.light.subjectYellowInk,
          "yellow-tint-bright": palette.dark.subjectYellowTint,
          "yellow-ink-bright": palette.dark.subjectYellowInk,
          "orange-tint": palette.light.subjectOrangeTint,
          "orange-ink": palette.light.subjectOrangeInk,
          "orange-tint-bright": palette.dark.subjectOrangeTint,
          "orange-ink-bright": palette.dark.subjectOrangeInk,
          "blue-tint": palette.light.subjectBlueTint,
          "blue-ink": palette.light.subjectBlueInk,
          "blue-tint-bright": palette.dark.subjectBlueTint,
          "blue-ink-bright": palette.dark.subjectBlueInk,
          "green-tint": palette.light.subjectGreenTint,
          "green-ink": palette.light.subjectGreenInk,
          "green-tint-bright": palette.dark.subjectGreenTint,
          "green-ink-bright": palette.dark.subjectGreenInk,
        },
        dropzone: {
          DEFAULT: palette.light.dropzoneFill,
          bright: palette.dark.dropzoneFill,
          stroke: palette.light.dropzoneStroke,
          "stroke-bright": palette.dark.dropzoneStroke,
        },
      },
      // so `border-dropzone` picks the stroke, not the fill
      borderColor: {
        dropzone: {
          DEFAULT: palette.light.dropzoneStroke,
          bright: palette.dark.dropzoneStroke,
        },
      },
      // same names and values as `borderRadius` in utils/design-tokens.ts
      borderRadius: {
        "2xs": "2px",
        xs: "4px",
        sm: "8px",
        md: "12px",
        lg: "16px",
        xl: "24px",
        full: "9999px",
      },
      // react native picks a static face by family name, so `font-medium` maps to the
      // Medium file. keys match the names app/_layout.tsx registers with useFonts
      fontFamily: {
        sans: ["InstrumentSans_400Regular"],
        medium: ["InstrumentSans_500Medium"],
        semibold: ["InstrumentSans_600SemiBold"],
      },
      // same names and values as `typography` in utils/design-tokens.ts. weights
      // 400/500/600 only; letter spacing goes in `style` at the call site
      fontSize: {
        display: ["32px", { lineHeight: "40px", fontWeight: "500" }],
        title: ["26px", { lineHeight: "32px", fontWeight: "500" }],
        heading: ["20px", { lineHeight: "26px", fontWeight: "500" }],
        subheading: ["18px", { lineHeight: "24px", fontWeight: "500" }],
        body: ["15px", { lineHeight: "22px", fontWeight: "400" }],
        bodyMedium: ["15px", { lineHeight: "22px", fontWeight: "500" }],
        caption: ["14px", { lineHeight: "20px", fontWeight: "400" }],
        small: ["13px", { lineHeight: "18px", fontWeight: "500" }],
      },
    },
  },
  plugins: [],
};
