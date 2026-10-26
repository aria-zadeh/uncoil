import React from "react";
import { Ionicons } from "@expo/vector-icons";
import { borderRadius, HAIRLINE, ICON_SIZE, TOUCH_TARGET_MIN } from "@/utils/design-tokens";
import { PressableScale } from "./PressableScale";

export interface PlayCircleProps {
  onPress: () => void;
  accessibilityLabel: string;
  // 28 inside schedule blocks
  size?: 28 | 32;
  disabled?: boolean;
}

export function PlayCircle({ onPress, accessibilityLabel, size = 32, disabled = false }: PlayCircleProps) {
  const slop = Math.max(0, (TOUCH_TARGET_MIN - size) / 2);
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      radius={borderRadius.full}
      hitSlop={slop}
      className={`items-center justify-center rounded-full bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark ${disabled ? "opacity-50" : ""}`}
      style={{ width: size, height: size, borderWidth: HAIRLINE }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
    >
      <Ionicons name="play" size={ICON_SIZE.inline} className="text-content dark:text-content-dark-primary" />
    </PressableScale>
  );
}
