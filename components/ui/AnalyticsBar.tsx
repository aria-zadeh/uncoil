import React from "react";
import { View, Text, useWindowDimensions } from "react-native";
import { spacing, ANALYTICS_MIN_SEGMENT } from "@/utils/design-tokens";

// above this Dynamic Type scale two legend columns truncate the labels, so use one
const LARGE_TYPE_SCALE = 1.3;

const BAR_HEIGHT = spacing.sm;
// a zero segment still shows its colour at this width
const MIN_SEGMENT = ANALYTICS_MIN_SEGMENT;
const SWATCH = spacing.sm;

export type AnalyticsToken = "success" | "barBlue" | "barPink" | "accent";

export interface AnalyticsSegment {
  key: string;
  // 0 to 1, relative to the other segments
  value: number;
  token: AnalyticsToken;
  label: string;
  // the legend carries the number ("80%", "2h10"), so the bar itself is decorative
  display: string;
}

export interface AnalyticsBarProps {
  segments: readonly AnalyticsSegment[];
}

const fillClasses: Record<AnalyticsToken, string> = {
  success: "bg-success dark:bg-success-bright",
  barBlue: "bg-bar-blue dark:bg-bar-blue-bright",
  barPink: "bg-bar-pink dark:bg-bar-pink-bright",
  accent: "bg-accent dark:bg-accent-bright",
};

export function AnalyticsBar({ segments }: AnalyticsBarProps) {
  const { fontScale } = useWindowDimensions();
  const perRow = fontScale >= LARGE_TYPE_SCALE ? 1 : 2;
  const total = segments.reduce((sum, s) => sum + Math.max(s.value, 0), 0);
  // grow factors must sum to 1, flex leaves space unfilled when they sum below it
  const share = (value: number) => (total > 0 ? Math.max(value, 0) / total : 1 / Math.max(segments.length, 1));
  const summary = segments.map((s) => `${s.label} ${s.display}`).join(", ");
  const rows: AnalyticsSegment[][] = [];
  for (let i = 0; i < segments.length; i += perRow) rows.push(segments.slice(i, i + perRow));

  return (
    <View accessibilityLabel={summary}>
      <View className="flex-row" style={{ height: BAR_HEIGHT, gap: spacing.xs }} accessible={false} importantForAccessibility="no-hide-descendants">
        {segments.map((s) => (
          <View
            key={s.key}
            className={`rounded-full ${fillClasses[s.token]}`}
            style={{ flexGrow: share(s.value), flexBasis: MIN_SEGMENT, minWidth: MIN_SEGMENT }}
          />
        ))}
      </View>
      <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
        {rows.map((row, index) => (
          <View key={index} className="flex-row" style={{ gap: spacing.base }}>
            {row.map((s) => (
              <View key={s.key} className="flex-1 flex-row items-center">
                <View className={`rounded-2xs ${fillClasses[s.token]}`} style={{ width: SWATCH, height: SWATCH }} />
                <Text
                  className="flex-1 text-body font-sans text-content-secondary dark:text-content-dark-secondary"
                  style={{ marginLeft: spacing.sm }}
                  numberOfLines={2}
                >
                  {s.label}
                </Text>
                <Text className="text-body font-semibold text-content dark:text-content-dark-primary" style={{ marginLeft: spacing.sm, fontVariant: ["tabular-nums"] }}>
                  {s.display}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}
