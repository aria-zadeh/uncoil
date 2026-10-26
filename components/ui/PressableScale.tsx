import React from "react";
import { Pressable, type PressableProps, type StyleProp, type ViewStyle, type GestureResponderEvent } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  Easing,
  useReducedMotion,
} from "react-native-reanimated";
import { motion, press, springs } from "@/utils/design-tokens";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressableScaleProps extends Omit<PressableProps, "style" | "children"> {
  children: React.ReactNode;
  // static only: Reanimated's animated Pressable drops function-form styles
  style?: StyleProp<ViewStyle> | StyleProp<ViewStyle>[];
  className?: string;
  // match the pressable's own shape, the press overlay clips to it
  radius?: number;
  disabled?: boolean | null;
}

// the overlay makes flat, near-monochrome surfaces read as pressed. it is opacity
// only and stays on under Reduce Motion, only the scale is gated
export function PressableScale({
  children,
  style,
  className = "",
  radius = 0,
  disabled = false,
  onPressIn,
  onPressOut,
  ...props
}: PressableScaleProps) {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const overlay = useSharedValue(0);

  const scaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const overlayStyle = useAnimatedStyle(() => ({ opacity: overlay.value }));

  return (
    <AnimatedPressable
      {...props}
      disabled={disabled}
      onPressIn={(e: GestureResponderEvent) => {
        overlay.value = withTiming(press.overlay, { duration: motion.press, easing: Easing.out(Easing.cubic) });
        if (!reduceMotion) scale.value = withSpring(press.scale, springs.press);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        overlay.value = withTiming(0, { duration: motion.press, easing: Easing.in(Easing.cubic) });
        if (!reduceMotion) scale.value = withSpring(1, springs.press);
        onPressOut?.(e);
      }}
      className={className}
      style={[style, scaleStyle]}
    >
      {children}
      <Animated.View
        pointerEvents="none"
        className="absolute inset-0 bg-content dark:bg-content-dark-primary"
        style={[{ borderRadius: radius }, overlayStyle]}
      />
    </AnimatedPressable>
  );
}
