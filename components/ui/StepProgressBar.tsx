import React from "react";
import { View } from "react-native";
import { spacing } from "@/utils/design-tokens";

const BAR_HEIGHT = spacing.xs;

export interface StepProgressBarProps {
  steps: number;
  // 1-based
  current: number;
}

export function StepProgressBar({ steps, current }: StepProgressBarProps) {
  const filled = Math.min(Math.max(current, 0), steps);
  return (
    <View
      className="flex-row"
      style={{ height: BAR_HEIGHT, gap: spacing.xs }}
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${filled} of ${steps}`}
      accessibilityValue={{ min: 0, max: steps, now: filled }}
    >
      {Array.from({ length: steps }, (_, i) => (
        <View
          key={i}
          className={`flex-1 rounded-full ${
            i < filled ? "bg-primary dark:bg-primary-bright" : "bg-surface-elevated dark:bg-surface-dark-elevated"
          }`}
        />
      ))}
    </View>
  );
}
