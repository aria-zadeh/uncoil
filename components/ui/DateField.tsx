import React from "react";
import { View, Text } from "react-native";
import { spacing, borderRadius, HAIRLINE, TOUCH_TARGET_MIN } from "@/utils/design-tokens";
import { PressableScale } from "./PressableScale";

// same label gap as Input
const LABEL_GAP = spacing.xs + 2;

export interface DateFieldProps {
  label: string;
  // already formatted. empty shows the placeholder
  value: string;
  placeholder?: string;
  onPress: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
}

export function DateField({ label, value, placeholder = "Choose", onPress, accessibilityLabel, accessibilityHint, disabled = false }: DateFieldProps) {
  const empty = value.length === 0;
  return (
    <View className={disabled ? "opacity-50" : ""}>
      <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary" style={{ marginBottom: LABEL_GAP }}>
        {label}
      </Text>
      <PressableScale
        onPress={onPress}
        disabled={disabled}
        radius={borderRadius.full}
        className="justify-center rounded-full bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark"
        style={{ minHeight: TOUCH_TARGET_MIN, borderWidth: HAIRLINE, paddingHorizontal: spacing.base }}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? `${label}, ${empty ? "not set" : value}`}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled }}
      >
        <Text
          className={`text-body font-sans ${empty ? "text-content-muted dark:text-content-dark-muted" : "text-content dark:text-content-dark-primary"}`}
          numberOfLines={1}
        >
          {empty ? placeholder : value}
        </Text>
      </PressableScale>
    </View>
  );
}
