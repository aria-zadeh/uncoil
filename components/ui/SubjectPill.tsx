import React from "react";
import { View, Text, type StyleProp, type ViewStyle } from "react-native";
import { spacing } from "@/utils/design-tokens";
import { subjectHue, type SubjectHue } from "@/utils/subjectColor";

// past this the card breaks
const MAX_FONT_SCALE = 1.6;
const PAD_X = spacing.sm + 2;
const PAD_Y = spacing.xs / 2;

export interface SubjectPillProps {
  // empty or missing renders nothing
  subject: string | null | undefined;
  style?: StyleProp<ViewStyle>;
}

// whole class strings so Tailwind can find them
const hueClasses: Record<SubjectHue, { box: string; text: string }> = {
  pink: {
    box: "bg-subject-pink-tint dark:bg-subject-pink-tint-bright",
    text: "text-subject-pink-ink dark:text-subject-pink-ink-bright",
  },
  teal: {
    box: "bg-subject-teal-tint dark:bg-subject-teal-tint-bright",
    text: "text-subject-teal-ink dark:text-subject-teal-ink-bright",
  },
  yellow: {
    box: "bg-subject-yellow-tint dark:bg-subject-yellow-tint-bright",
    text: "text-subject-yellow-ink dark:text-subject-yellow-ink-bright",
  },
  orange: {
    box: "bg-subject-orange-tint dark:bg-subject-orange-tint-bright",
    text: "text-subject-orange-ink dark:text-subject-orange-ink-bright",
  },
  blue: {
    box: "bg-subject-blue-tint dark:bg-subject-blue-tint-bright",
    text: "text-subject-blue-ink dark:text-subject-blue-ink-bright",
  },
  green: {
    box: "bg-subject-green-tint dark:bg-subject-green-tint-bright",
    text: "text-subject-green-ink dark:text-subject-green-ink-bright",
  },
};

export function SubjectPill({ subject, style }: SubjectPillProps) {
  const hue = subjectHue(subject);
  if (!hue) return null;
  const classes = hueClasses[hue];
  return (
    <View
      className={`self-start rounded-full ${classes.box}`}
      style={[{ paddingHorizontal: PAD_X, paddingVertical: PAD_Y, maxWidth: "100%" }, style]}
    >
      <Text className={`text-small font-medium ${classes.text}`} maxFontSizeMultiplier={MAX_FONT_SCALE} numberOfLines={2}>
        {(subject ?? "").trim()}
      </Text>
    </View>
  );
}
