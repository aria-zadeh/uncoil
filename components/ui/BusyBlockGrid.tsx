// weekly busy grid for onboarding and settings. busy cells get a glyph so the
// state is never carried by colour alone

import React from "react";
import { View, Text, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import type { DayKey, PeriodKey, BusyBlock } from "@/types";
import { colors, spacing, ICON_SIZE, TOUCH_TARGET_MIN } from "@/utils/design-tokens";

const DAYS: { key: DayKey; label: string; letter: string }[] = [
  { key: "mon", label: "Monday", letter: "M" },
  { key: "tue", label: "Tuesday", letter: "T" },
  { key: "wed", label: "Wednesday", letter: "W" },
  { key: "thu", label: "Thursday", letter: "T" },
  { key: "fri", label: "Friday", letter: "F" },
  { key: "sat", label: "Saturday", letter: "S" },
  { key: "sun", label: "Sunday", letter: "S" },
];

const PERIODS: { key: PeriodKey; label: string; hint: string }[] = [
  { key: "morning", label: "Morning", hint: "8am to 12pm" },
  { key: "afternoon", label: "Afternoon", hint: "12 to 5pm" },
  { key: "evening", label: "Evening", hint: "5 to 9pm" },
];

const CELL = spacing["3xl"];
const GAP = spacing.xs;
const PERIOD_COLUMN = spacing["5xl"] + spacing.base;

interface BusyBlockGridProps {
  busyBlocks: BusyBlock[];
  onToggle: (block: BusyBlock) => void;
}

const FREE_CELL = "bg-surface-elevated dark:bg-surface-dark-elevated";
const BUSY_CELL = "bg-primary dark:bg-primary-bright";

export function BusyBlockGrid({ busyBlocks, onToggle }: BusyBlockGridProps) {
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const isBusy = (day: DayKey, period: PeriodKey) =>
    busyBlocks.some((b) => b.day === day && b.period === period);
  const slop = (TOUCH_TARGET_MIN - CELL) / 2;

  return (
    <View style={{ gap: GAP }}>
      <View className="flex-row" style={{ gap: GAP }}>
        <View style={{ width: PERIOD_COLUMN }} />
        {DAYS.map((day) => (
          <Text
            key={day.key}
            className="flex-1 text-small font-medium text-content-secondary dark:text-content-dark-secondary text-center"
            accessibilityLabel={day.label}
          >
            {day.letter}
          </Text>
        ))}
      </View>

      {/* rows are periods, columns are days */}
      {PERIODS.map((period) => (
        <View key={period.key} className="flex-row items-center" style={{ gap: GAP }}>
          <View style={{ width: PERIOD_COLUMN }}>
            <Text className="text-small font-medium text-content-secondary dark:text-content-dark-secondary">{period.label}</Text>
            <Text className="text-small font-medium text-content-muted dark:text-content-dark-muted">{period.hint}</Text>
          </View>
          {DAYS.map((day) => {
            const busy = isBusy(day.key, period.key);
            return (
              <Pressable
                key={day.key}
                onPress={() => onToggle({ day: day.key, period: period.key })}
                className={`flex-1 rounded-sm items-center justify-center ${busy ? BUSY_CELL : FREE_CELL}`}
                style={{ height: CELL }}
                hitSlop={{ top: slop, bottom: slop }}
                accessibilityRole="switch"
                accessibilityState={{ checked: busy }}
                accessibilityLabel={`${day.label} ${period.label}, ${busy ? "busy" : "free"}`}
              >
                {busy && <Ionicons name="close" size={ICON_SIZE.inline} color={colors[scheme].primaryForeground} />}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
