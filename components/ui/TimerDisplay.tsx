import React from "react";
import { View, Text } from "react-native";
import { fontFamily, spacing } from "@/utils/design-tokens";

// larger than any type token
const TIMER_FONT = { fontSize: spacing["4xl"], lineHeight: spacing["4xl"] + spacing.sm } as const;
// past this the timer wraps
const MAX_FONT_SCALE = 1.6;

interface TimerDisplayProps {
  seconds: number;
  running: boolean;
  label?: string;
}

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(Math.abs(totalSeconds) / 60);
  const secs = Math.abs(totalSeconds) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function TimerDisplay({ seconds, running, label }: TimerDisplayProps) {
  return (
    <View
      accessibilityRole="timer"
      accessibilityLabel={`${formatTime(seconds)} ${running ? "running" : "paused"}`}
    >
      {label && (
        <Text
          className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
          style={{ marginBottom: spacing.xs }}
        >
          {label}
        </Text>
      )}
      <Text
        className={running ? "text-content dark:text-content-dark-primary" : "text-content-muted dark:text-content-dark-muted"}
        style={{ ...TIMER_FONT, fontFamily: fontFamily.semibold, fontVariant: ["tabular-nums"] }}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
      >
        {formatTime(seconds)}
      </Text>
    </View>
  );
}
