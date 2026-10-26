import React from "react";
import { View, Text, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeOut, Easing, useReducedMotion } from "react-native-reanimated";
import { shadows, motion, spacing, TAB_PILL, TOUCH_TARGET_MIN } from "@/utils/design-tokens";

// no exclamation mark. __tests__/unit/copy.test.ts pins the exact wording
export const TASK_COMPLETED_COPY = "Task completed";

const ENTER_RISE = spacing.base;
const ABOVE_PILL = TAB_PILL.gap + TAB_PILL.height + TAB_PILL.gap;

interface UndoToastProps {
  visible: boolean;
  message: string;
  // omit when there is nothing real to undo
  onUndo?: () => void;
}

// callers own the timeout, the message and the undo action
export function UndoToast({ visible, message, onUndo }: UndoToastProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  if (!visible) return null;

  const entering = reduceMotion
    ? undefined
    : FadeIn.duration(motion.enter)
        .easing(Easing.out(Easing.cubic))
        .withInitialValues({ opacity: 0, transform: [{ translateY: ENTER_RISE }] });
  const exiting = reduceMotion ? undefined : FadeOut.duration(motion.exit).easing(Easing.in(Easing.cubic));

  return (
    <Animated.View
      entering={entering}
      exiting={exiting}
      className="absolute rounded-full bg-primary dark:bg-primary-bright flex-row items-center justify-between"
      style={[
        { left: spacing.base, right: spacing.base, bottom: insets.bottom + ABOVE_PILL, paddingLeft: spacing.lg, paddingRight: spacing.sm, minHeight: TOUCH_TARGET_MIN },
        shadows.lg,
      ]}
      accessibilityLiveRegion="polite"
    >
      <Text
        className="flex-1 text-body font-sans bg-primary dark:bg-primary-bright text-primary-foreground dark:text-primary-bright-foreground"
        numberOfLines={1}
      >
        {message}
      </Text>
      {onUndo && (
        <View style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}>
          <Pressable
            onPress={onUndo}
            className="items-center justify-center rounded-full"
            style={{ minHeight: TOUCH_TARGET_MIN, minWidth: TOUCH_TARGET_MIN, paddingHorizontal: spacing.md, marginLeft: spacing.sm }}
            accessibilityRole="button"
            accessibilityLabel="Undo task completion"
          >
            <Text className="text-bodyMedium font-medium bg-primary dark:bg-primary-bright text-primary-foreground dark:text-primary-bright-foreground">
              Undo
            </Text>
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
}
