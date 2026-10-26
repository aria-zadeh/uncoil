import React, { useEffect, useRef } from "react";
import { View, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withSequence,
  withTiming,
  Easing,
  useReducedMotion,
} from "react-native-reanimated";
import { colors, motion, springs, CHECKBOX_SIZE, HAIRLINE, ICON_SIZE, TOUCH_TARGET_MIN } from "@/utils/design-tokens";

const CHECK_ENTER_SCALE = 0.6;
const POP_SCALE = 1.12;

// round is the completion disc on task cards
export type CheckboxShape = "square" | "round";

interface InteractiveCheckboxProps {
  checked: boolean;
  onToggle: () => void;
  accessibilityLabel: string;
  size?: number;
  shape?: CheckboxShape;
  decorative?: false;
}

// illustration only, for rows that are the control themselves. hidden from accessibility
interface DecorativeCheckboxProps {
  checked: boolean;
  decorative: true;
  size?: number;
  shape?: CheckboxShape;
  onToggle?: never;
  accessibilityLabel?: never;
}

export type CheckboxProps = InteractiveCheckboxProps | DecorativeCheckboxProps;

export function Checkbox(props: CheckboxProps) {
  const { checked, size = CHECKBOX_SIZE, shape = "square" } = props;
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const reduceMotion = useReducedMotion();
  const glyphScale = useSharedValue(checked ? 1 : CHECK_ENTER_SCALE);
  const boxScale = useSharedValue(1);
  const mounted = useRef(false);

  useEffect(() => {
    if (!checked) {
      glyphScale.value = CHECK_ENTER_SCALE;
      return;
    }
    if (reduceMotion) {
      glyphScale.value = 1;
    } else {
      glyphScale.value = withSpring(1, springs.press);
    }
  }, [checked, reduceMotion, glyphScale]);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!checked || reduceMotion) {
      boxScale.value = 1;
      return;
    }
    boxScale.value = withSequence(
      withTiming(POP_SCALE, { duration: motion.press, easing: Easing.out(Easing.cubic) }),
      withSpring(1, springs.settle)
    );
  }, [checked, reduceMotion, boxScale]);

  const glyphStyle = useAnimatedStyle(() => ({
    transform: [{ scale: glyphScale.value }],
  }));
  const boxStyle = useAnimatedStyle(() => ({
    transform: [{ scale: boxScale.value }],
  }));

  const box = (
    <Animated.View
      className={`items-center justify-center ${shape === "round" ? "rounded-full" : "rounded-xs"} ${
        checked
          ? "bg-accent dark:bg-accent-bright"
          : "bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark"
      }`}
      style={[{ width: size, height: size, borderWidth: checked ? 0 : HAIRLINE }, boxStyle]}
    >
      {checked && (
        <Animated.View style={glyphStyle}>
          <Ionicons name="checkmark" size={ICON_SIZE.chip} color={colors[scheme].primaryForeground} />
        </Animated.View>
      )}
    </Animated.View>
  );

  if (props.decorative) {
    return (
      <View accessible={false} importantForAccessibility="no-hide-descendants">
        {box}
      </View>
    );
  }

  const slop = Math.max(0, (TOUCH_TARGET_MIN - size) / 2);

  return (
    <Pressable
      onPress={props.onToggle}
      className="items-center justify-center"
      style={{ minWidth: size, minHeight: size }}
      hitSlop={slop}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={props.accessibilityLabel}
    >
      {box}
    </Pressable>
  );
}
