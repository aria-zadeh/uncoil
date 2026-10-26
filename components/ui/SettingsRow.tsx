import React from "react";
import { View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, borderRadius, ICON_SIZE, TOUCH_TARGET_MIN } from "@/utils/design-tokens";
import { PressableScale } from "./PressableScale";
import type { Glyph } from "./icons";

export interface SettingsRowProps {
  icon: Glyph;
  label: string;
  value?: string;
  onPress?: () => void;
  chevron?: boolean;
  tone?: "default" | "danger";
  // e.g. a Switch, shown in place of the chevron
  accessory?: React.ReactNode;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
}

const toneClasses = {
  default: {
    icon: "text-content-secondary dark:text-content-dark-secondary",
    label: "text-content dark:text-content-dark-primary",
  },
  danger: {
    icon: "text-danger-dark dark:text-danger-bright",
    label: "text-danger-dark dark:text-danger-bright",
  },
} as const;

export function SettingsRow({
  icon,
  label,
  value,
  onPress,
  chevron,
  tone = "default",
  accessory,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
}: SettingsRowProps) {
  const showChevron = chevron ?? Boolean(onPress);
  const classes = toneClasses[tone];
  const a11yLabel = accessibilityLabel ?? (value ? `${label}, ${value}` : label);

  const content = (
    <>
      <Ionicons name={icon} size={ICON_SIZE.row} className={classes.icon} />
      {/* flexShrink 0 so a long value can't squeeze the label into wrapping letter by letter */}
      <Text
        className={`flex-1 text-body font-sans ${classes.label}`}
        style={{ marginLeft: spacing.md, flexShrink: 0 }}
        numberOfLines={2}
      >
        {label}
      </Text>
      {value ? (
        <Text
          className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
          style={{ marginLeft: spacing.sm, flexShrink: 1 }}
          numberOfLines={2}
        >
          {value}
        </Text>
      ) : null}
      {accessory ? (
        <View style={{ marginLeft: spacing.sm }}>{accessory}</View>
      ) : showChevron ? (
        <Ionicons
          name="chevron-forward"
          size={ICON_SIZE.action}
          className="text-content-secondary dark:text-content-dark-secondary"
          style={{ marginLeft: spacing.sm }}
        />
      ) : null}
    </>
  );

  if (!onPress) {
    return (
      <View className="flex-row items-center" style={{ minHeight: TOUCH_TARGET_MIN }} accessibilityLabel={a11yLabel}>
        {content}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      radius={borderRadius.sm}
      className={`flex-row items-center rounded-sm ${disabled ? "opacity-50" : ""}`}
      style={{ minHeight: TOUCH_TARGET_MIN }}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
    >
      {content}
    </PressableScale>
  );
}
