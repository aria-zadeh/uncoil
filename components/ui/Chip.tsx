import React from "react";
import { View, Text, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, borderRadius, HAIRLINE, ICON_SIZE, CHIP_HEIGHT, TOUCH_TARGET_MIN } from "@/utils/design-tokens";
import { PressableScale } from "./PressableScale";
import type { Glyph } from "./icons";

// past this the chip row breaks
const MAX_FONT_SCALE = 1.6;
// 8 by 6, an oval on purpose
const DOT = { width: spacing.sm, height: spacing.sm - 2 } as const;
const PAD_X = spacing.sm + 2;

export type ChipDot = "success" | "warning" | "danger";
export type ChipTone = "neutral" | "success" | "warning" | "danger" | "selected";

export interface ChipProps {
  label: string;
  prefix?: string;
  icon?: Glyph;
  // never the only carrier of meaning, the label has to say it too
  dot?: ChipDot;
  // md is the count chip, with a muted label
  size?: "sm" | "md";
  // selected wins over tone
  tone?: ChipTone;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
  /** @deprecated use SelectChip */
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  className?: string;
}

const dotClasses: Record<ChipDot, string> = {
  success: "bg-success dark:bg-success-bright",
  warning: "bg-warning dark:bg-warning-bright",
  danger: "bg-danger dark:bg-danger-bright",
};

const toneBox: Record<Exclude<ChipTone, "neutral">, string> = {
  success: "bg-success-light dark:bg-success-bright-light border-success-light dark:border-success-bright-light",
  warning: "bg-warning-light dark:bg-warning-bright-light border-warning-light dark:border-warning-bright-light",
  danger: "bg-danger-light dark:bg-danger-bright-light border-danger-light dark:border-danger-bright-light",
  selected: "bg-selected-light dark:bg-selected-bright-light border-selected-light dark:border-selected-bright-light",
};
const toneText: Record<Exclude<ChipTone, "neutral">, string> = {
  success: "text-success-dark dark:text-success-bright-dark",
  warning: "text-warning-dark dark:text-warning-bright-dark",
  danger: "text-danger-dark dark:text-danger-bright-dark",
  selected: "text-selected-dark dark:text-selected-bright-dark",
};

const idleBox = "bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark";
const selectedBox = "bg-selected-light dark:bg-selected-bright-light border-selected dark:border-selected-bright";
const inkText = "text-content dark:text-content-dark-primary";
const secondaryText = "text-content-secondary dark:text-content-dark-secondary";
const selectedText = "text-selected-dark dark:text-selected-bright-dark";

export function Chip({
  label,
  prefix,
  icon,
  dot,
  size = "sm",
  tone = "neutral",
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  selected = false,
  style,
  className = "",
}: ChipProps) {
  const height = CHIP_HEIGHT[size];
  const tint = !selected && tone !== "neutral" ? tone : null;
  const labelClass = selected ? selectedText : tint ? toneText[tint] : size === "md" ? secondaryText : inkText;
  // textSecondary isn't contrast-checked against the tint fills, the tone's dark shade is
  const prefixClass = tint ? toneText[tint] : secondaryText;
  const fillClass = selected ? selectedBox : tint ? toneBox[tint] : idleBox;
  const boxClass = `flex-row items-center justify-center rounded-sm ${fillClass} ${disabled ? "opacity-50" : ""} ${className}`;
  // minHeight, not height: at large Dynamic Type the label outgrows the box, and a
  // fixed height let it overflow onto the next row
  const boxStyle = { minHeight: height, paddingHorizontal: PAD_X, paddingVertical: 2, borderWidth: HAIRLINE };
  const readable = prefix ? `${prefix} ${label}` : label;

  const content = (
    <>
      {dot ? <View className={`rounded-full ${dotClasses[dot]}`} style={{ width: DOT.width, height: DOT.height, marginRight: spacing.sm - 2 }} /> : null}
      {icon ? <Ionicons name={icon} size={ICON_SIZE.chip} className={labelClass} style={{ marginRight: spacing.xs }} /> : null}
      <Text className="text-caption" maxFontSizeMultiplier={MAX_FONT_SCALE} numberOfLines={1}>
        {prefix ? <Text className={`text-caption font-sans ${prefixClass}`}>{prefix} </Text> : null}
        <Text className={`text-caption font-medium ${labelClass}`}>{label}</Text>
      </Text>
    </>
  );

  if (!onPress) {
    return (
      <View className={boxClass} style={[boxStyle, style]} accessibilityLabel={accessibilityLabel ?? readable}>
        {content}
      </View>
    );
  }

  const slop = Math.max(0, (TOUCH_TARGET_MIN - height) / 2);
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      radius={borderRadius.sm}
      className={boxClass}
      style={[boxStyle, style]}
      hitSlop={{ top: slop, bottom: slop, left: spacing.xs, right: spacing.xs }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? readable}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected, disabled }}
    >
      {content}
    </PressableScale>
  );
}
