import React from "react";
import { View, Text, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, borderRadius, HAIRLINE, ICON_SIZE, CHIP_HEIGHT, TOUCH_TARGET_MIN } from "@/utils/design-tokens";
import { PressableScale } from "./PressableScale";
import type { Glyph } from "./icons";

// past this the chip row breaks
const MAX_FONT_SCALE = 1.6;

export interface SelectChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  icon?: Glyph;
  disabled?: boolean;
  // SelectChipRow sets field itself when it has columns
  size?: "select" | "field";
}

const selectedClasses = {
  box: "bg-selected-light dark:bg-selected-bright-light border-selected dark:border-selected-bright",
  text: "text-selected-dark dark:text-selected-bright-dark",
};
const idleClasses = {
  box: "bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark",
  text: "text-content-secondary dark:text-content-dark-secondary",
};

export function SelectChip({ label, selected, onPress, accessibilityLabel, icon, disabled = false, size = "select" }: SelectChipProps) {
  const palette = selected ? selectedClasses : idleClasses;
  const height = CHIP_HEIGHT[size];
  const slop = Math.max(0, (TOUCH_TARGET_MIN - height) / 2);
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      radius={borderRadius.full}
      hitSlop={{ top: slop, bottom: slop }}
      className={`flex-row items-center justify-center rounded-full ${palette.box} ${disabled ? "opacity-50" : ""}`}
      style={{ height, paddingHorizontal: size === "field" ? spacing.sm : spacing.base, borderWidth: HAIRLINE }}
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected, disabled }}
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {icon ? (
        <Ionicons name={icon} size={ICON_SIZE.chip} className={palette.text} style={{ marginRight: spacing.xs + 2 }} />
      ) : null}
      <Text className={`text-bodyMedium font-medium ${palette.text}`} maxFontSizeMultiplier={MAX_FONT_SCALE} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
}

export interface SelectChipRowProps {
  children: React.ReactNode;
  accessibilityLabel: string;
  scrollable?: boolean;
  // equal-width rows of this many chips, a short last row keeps the width. wins over scrollable
  columns?: number;
}

export function SelectChipRow({ children, accessibilityLabel, scrollable = false, columns }: SelectChipRowProps) {
  if (columns && columns > 0) {
    const items = React.Children.toArray(children);
    const rows: React.ReactNode[][] = [];
    for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
    return (
      <View style={{ gap: spacing.sm }} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
        {rows.map((row, rowIndex) => (
          <View key={rowIndex} className="flex-row" style={{ gap: spacing.sm }}>
            {row.map((child, index) => (
              <View key={index} className="flex-1">
                {React.isValidElement<SelectChipProps>(child) ? React.cloneElement(child, { size: "field" }) : child}
              </View>
            ))}
            {Array.from({ length: columns - row.length }, (_, index) => (
              <View key={`pad-${index}`} className="flex-1" />
            ))}
          </View>
        ))}
      </View>
    );
  }
  if (scrollable) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: spacing.sm }}
        accessibilityRole="radiogroup"
        accessibilityLabel={accessibilityLabel}
      >
        {children}
      </ScrollView>
    );
  }
  return (
    <View className="flex-row flex-wrap" style={{ gap: spacing.sm }} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      {children}
    </View>
  );
}
