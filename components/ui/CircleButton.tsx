import React from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  useReducedMotion,
} from "react-native-reanimated";
import { press, springs, ICON_SIZE, CIRCLE_BUTTON } from "@/utils/design-tokens";
import type { Glyph } from "./icons";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface CircleButtonProps {
  icon: Glyph;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  disabled?: boolean;
  tone?: "default" | "danger";
  style?: StyleProp<ViewStyle>;
}

const toneClasses = {
  default: "text-content dark:text-content-dark-primary",
  danger: "text-danger-dark dark:text-danger-bright",
} as const;

export function CircleButton({
  icon,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  tone = "default",
  style,
}: CircleButtonProps) {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={disabled}
      onPressIn={() => {
        if (!reduceMotion) scale.value = withSpring(press.scale, springs.press);
      }}
      onPressOut={() => {
        if (!reduceMotion) scale.value = withSpring(1, springs.press);
      }}
      className={`items-center justify-center rounded-full border bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark active:bg-surface-elevated dark:active:bg-surface-dark-elevated ${disabled ? "opacity-50" : ""}`}
      style={[{ width: CIRCLE_BUTTON, height: CIRCLE_BUTTON }, animatedStyle, style]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
    >
      <Ionicons name={icon} size={ICON_SIZE.action} className={toneClasses[tone]} />
    </AnimatedPressable>
  );
}
