import React, { useEffect } from "react";
import { View, Text } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  useReducedMotion,
} from "react-native-reanimated";
import { motion, spacing } from "@/utils/design-tokens";

const TRACK_HEIGHT = spacing.sm;

interface ProgressBarProps {
  progress: number; // 0 to 1
  // tailwind fill classes, not a colour value
  color?: string;
  // card on a grey SubPanel, elevated on a white card
  track?: "card" | "elevated";
  label?: string;
  showPercent?: boolean;
  /** @deprecated use showPercent */
  showPercentage?: boolean;
  height?: number;
}

const trackClasses = {
  card: "bg-surface-card dark:bg-surface-dark-card",
  elevated: "bg-surface-elevated dark:bg-surface-dark-elevated",
} as const;

export function ProgressBar({
  progress,
  color,
  track = "elevated",
  label,
  showPercent,
  showPercentage,
  height = TRACK_HEIGHT,
}: ProgressBarProps) {
  const reduceMotion = useReducedMotion();
  const clamped = Math.min(Math.max(progress, 0), 1);
  const scaleX = useSharedValue(clamped);
  const withPercent = showPercent ?? showPercentage ?? false;

  useEffect(() => {
    if (reduceMotion) {
      scaleX.value = clamped;
      return;
    }
    // timing, not a spring, so a measurement never overshoots
    scaleX.value = withTiming(clamped, {
      duration: motion.enter,
      easing: Easing.out(Easing.cubic),
    });
  }, [clamped, reduceMotion, scaleX]);

  const fillStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: scaleX.value }],
  }));

  const fillClass = color || "bg-success dark:bg-success-bright";
  const percent = Math.round(clamped * 100);

  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: percent }}>
      {label ? (
        <Text className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary" style={{ marginBottom: spacing.sm }}>
          {label}
        </Text>
      ) : null}
      <View className="flex-row items-center">
        <View className={`flex-1 rounded-full overflow-hidden ${trackClasses[track]}`} style={{ height }}>
          <Animated.View
            className={`h-full w-full rounded-full ${fillClass}`}
            style={[{ transformOrigin: "left" }, fillStyle]}
          />
        </View>
        {withPercent ? (
          <Text
            className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginLeft: spacing.md, fontVariant: ["tabular-nums"] }}
          >
            {percent}%
          </Text>
        ) : null}
      </View>
    </View>
  );
}
