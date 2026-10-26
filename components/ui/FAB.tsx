import React from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  useReducedMotion,
} from "react-native-reanimated";
import { colors, shadows, press, springs, ICON_SIZE, FAB_SIZE } from "@/utils/design-tokens";
import type { Glyph } from "./icons";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface FABProps {
  onPress: () => void;
  icon?: Glyph;
  // the caller positions it
  style?: StyleProp<ViewStyle>;
}

export function FAB({ onPress, icon = "add-circle", style }: FABProps) {
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => {
        if (!reduceMotion) scale.value = withSpring(press.scale, springs.press);
      }}
      onPressOut={() => {
        if (!reduceMotion) scale.value = withSpring(1, springs.press);
      }}
      className="rounded-full items-center justify-center bg-primary dark:bg-primary-bright active:bg-primary-dark dark:active:bg-primary-bright-dark"
      style={[{ width: FAB_SIZE, height: FAB_SIZE }, shadows.lg, animatedStyle, style]}
      accessibilityRole="button"
      accessibilityLabel="Add a task"
      accessibilityHint="Opens the new task form"
    >
      <Ionicons name={icon} size={ICON_SIZE.fab} color={colors[scheme].primaryForeground} />
    </AnimatedPressable>
  );
}
