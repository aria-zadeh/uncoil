import React, { useEffect, useRef } from "react";
import { View, Text } from "react-native";
import Animated, { useSharedValue, useAnimatedStyle, withSequence, withTiming, Easing } from "react-native-reanimated";
import { spacing, motion, borderRadius, TOUCH_TARGET_MIN } from "@/utils/design-tokens";
import { Checkbox } from "./Checkbox";
import { PressableScale } from "./PressableScale";

const ROW_HEIGHT = 30;
// past this the minutes wrap
const MAX_FONT_SCALE = 1.6;

export interface ChecklistRowProps {
  title: string;
  checked: boolean;
  // omit for a read-only row
  onToggle?: () => void;
  minutes?: number;
  disabled?: boolean;
  accessibilityLabel?: string;
  // for fixed-height hosts like calendar blocks. omitted, the title wraps and the row grows
  titleLines?: number;
}

export function ChecklistRow({ title, checked, onToggle, minutes, disabled = false, accessibilityLabel, titleLines }: ChecklistRowProps) {
  const label = accessibilityLabel ?? (minutes !== undefined ? `${title}, ${minutes} minutes` : title);

  // opacity only, so it stays on under Reduce Motion. skipped on mount so a list
  // that loads with steps already checked doesn't flicker
  const textOpacity = useSharedValue(1);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    textOpacity.value = withSequence(
      withTiming(0, { duration: motion.exit, easing: Easing.in(Easing.cubic) }),
      withTiming(1, { duration: motion.enter, easing: Easing.out(Easing.cubic) })
    );
  }, [checked, textOpacity]);
  const textStyle = useAnimatedStyle(() => ({ opacity: textOpacity.value }));

  const content = (
    <>
      <Checkbox checked={checked} decorative />
      <Animated.View style={[{ flex: 1, flexDirection: "row", alignItems: "center" }, textStyle]}>
        <Text
          className={`flex-1 text-body font-sans ${
            checked
              ? "line-through text-content-muted dark:text-content-dark-muted"
              : "text-content dark:text-content-dark-primary"
          }`}
          style={{ marginLeft: spacing.sm }}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          numberOfLines={titleLines}
        >
          {title}
        </Text>
        {minutes !== undefined ? (
          <Text
            className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginLeft: spacing.sm }}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
          >
            {minutes}m
          </Text>
        ) : null}
      </Animated.View>
    </>
  );

  if (!onToggle) {
    return (
      <View
        className="flex-row items-center"
        style={{ minHeight: ROW_HEIGHT }}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: true }}
        accessibilityLabel={label}
      >
        {content}
      </View>
    );
  }

  const slop = Math.max(0, (TOUCH_TARGET_MIN - ROW_HEIGHT) / 2);
  return (
    <PressableScale
      onPress={onToggle}
      disabled={disabled}
      radius={borderRadius.sm}
      hitSlop={{ top: slop, bottom: slop }}
      className={`flex-row items-center ${disabled ? "opacity-50" : ""}`}
      style={{ minHeight: ROW_HEIGHT }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
    >
      {content}
    </PressableScale>
  );
}
