import React from "react";
import { View, Text, Pressable } from "react-native";
import { spacing, HAIRLINE, WEEK_DISC, TOUCH_TARGET_MIN } from "@/utils/design-tokens";

// past this the strip wraps
const MAX_FONT_SCALE = 1.6;
// marks today when another day is selected
const TODAY_DOT = spacing.xs;

export interface WeekStripDay {
  key: string;
  weekday: string;
  dayNumber: number;
  isToday: boolean;
  isSelected: boolean;
  isPast?: boolean;
}

export interface WeekStripProps {
  days: readonly WeekStripDay[];
  onSelect: (key: string) => void;
}

export function WeekStrip({ days, onSelect }: WeekStripProps) {
  return (
    <View className="flex-row justify-between">
      {days.map((day) => {
        const discClass = day.isSelected
          ? "bg-selected-light dark:bg-selected-bright-light border-selected dark:border-selected-bright"
          : day.isPast
            ? "bg-surface-elevated dark:bg-surface-dark-elevated border-transparent"
            : "bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark";
        const numberClass = day.isSelected
          ? "text-caption font-medium text-selected-dark dark:text-selected-bright-dark"
          : "text-caption font-sans text-content-secondary dark:text-content-dark-secondary";
        return (
          <Pressable
            key={day.key}
            onPress={() => onSelect(day.key)}
            className="items-center"
            style={{ minWidth: WEEK_DISC, minHeight: TOUCH_TARGET_MIN }}
            hitSlop={spacing.xs}
            accessibilityRole="button"
            accessibilityLabel={`${day.weekday} ${day.dayNumber}${day.isToday ? ", today" : ""}`}
            accessibilityState={{ selected: day.isSelected }}
          >
            <Text
              className="text-small font-medium text-content-secondary dark:text-content-dark-secondary"
              style={{ marginBottom: spacing.sm }}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
            >
              {day.weekday}
            </Text>
            <View
              className={`items-center justify-center rounded-full ${discClass}`}
              style={{ width: WEEK_DISC, height: WEEK_DISC, borderWidth: HAIRLINE }}
            >
              <Text className={numberClass} style={{ fontVariant: ["tabular-nums"] }} maxFontSizeMultiplier={MAX_FONT_SCALE}>
                {day.dayNumber}
              </Text>
            </View>
            <View
              className={`rounded-full ${day.isToday && !day.isSelected ? "bg-selected dark:bg-selected-bright" : ""}`}
              style={{ width: TODAY_DOT, height: TODAY_DOT, marginTop: spacing.xs }}
            />
          </Pressable>
        );
      })}
    </View>
  );
}
