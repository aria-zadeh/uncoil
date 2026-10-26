import React, { useEffect, useState } from "react";
import { View, Text, Modal, Pressable, ScrollView, KeyboardAvoidingView, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  Easing,
  useReducedMotion,
} from "react-native-reanimated";
import { motion, shadows, spacing, springs, typography } from "@/utils/design-tokens";
import { CircleButton } from "./CircleButton";

const GRABBER = { width: spacing["2xl"] + spacing.xs, height: spacing.xs } as const;
const SCRIM_OPACITY = 0.4;
const MAX_SHEET_HEIGHT = "88%";

export interface SheetFrameProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  // pinned below the scrolling body
  footer?: React.ReactNode;
  // labels both the close button and the scrim
  closeLabel?: string;
  // defaults to true so a screen can simply mount it conditionally
  visible?: boolean;
  scroll?: boolean;
}

// never open one of these over another. iOS won't present a second Modal while the first
// is on screen, and the failed one leaves an invisible scrim that swallows every touch.
// delaying the second open doesn't reliably help, so swap the sheet's content instead
export function SheetFrame({
  title,
  onClose,
  children,
  footer,
  closeLabel = "Close",
  visible = true,
  scroll = true,
}: SheetFrameProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const [rendered, setRendered] = useState(visible);
  const scrimOpacity = useSharedValue(visible ? SCRIM_OPACITY : 0);
  const contentOffset = useSharedValue(visible ? 0 : windowHeight);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      if (reduceMotion) {
        scrimOpacity.value = SCRIM_OPACITY;
        contentOffset.value = 0;
      } else {
        scrimOpacity.value = withTiming(SCRIM_OPACITY, { duration: motion.enter, easing: Easing.out(Easing.cubic) });
        // not springs.settle: over a full screen height its overshoot left a gap under the sheet
        contentOffset.value = withSpring(0, springs.sheet);
      }
      return;
    }
    if (reduceMotion) {
      scrimOpacity.value = 0;
      contentOffset.value = windowHeight;
      setRendered(false);
      return;
    }
    scrimOpacity.value = withTiming(0, { duration: motion.exit, easing: Easing.in(Easing.cubic) });
    contentOffset.value = withTiming(windowHeight, { duration: motion.exit, easing: Easing.in(Easing.cubic) });
    // keep the Modal mounted until the exit animation has finished
    const timer = setTimeout(() => setRendered(false), motion.exit);
    return () => clearTimeout(timer);
  }, [visible, reduceMotion, windowHeight, scrimOpacity, contentOffset]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));
  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateY: contentOffset.value }] }));

  const body = scroll ? (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg }}>
      {children}
    </ScrollView>
  ) : (
    <View style={{ padding: spacing.lg }}>{children}</View>
  );

  return (
    <Modal
      visible={rendered}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View className="flex-1 justify-end">
        <Animated.View className="absolute inset-0 bg-content dark:bg-surface-dark" style={scrimStyle} />
        <Pressable
          onPress={onClose}
          className="absolute inset-0"
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
        />
        <KeyboardAvoidingView behavior="padding" style={{ maxHeight: MAX_SHEET_HEIGHT }}>
          <Animated.View
            className="bg-surface-card dark:bg-surface-dark-card rounded-t-xl"
            style={[{ maxHeight: "100%" }, shadows.lg, contentStyle]}
          >
            <View className="items-center" style={{ paddingTop: spacing.sm }}>
              <View
                className="rounded-full bg-border dark:bg-border-dark"
                style={{ width: GRABBER.width, height: GRABBER.height }}
              />
            </View>
            <View
              className="flex-row items-center justify-between"
              style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}
            >
              <Text
                className="flex-1 text-subheading font-medium text-content dark:text-content-dark-primary"
                style={{ letterSpacing: typography.subheading.letterSpacing, marginRight: spacing.md }}
                accessibilityRole="header"
              >
                {title}
              </Text>
              <CircleButton icon="close-outline" onPress={onClose} accessibilityLabel={closeLabel} />
            </View>
            <View style={{ flexShrink: 1 }}>{body}</View>
            {footer && (
              <View style={{ paddingHorizontal: spacing.lg, paddingBottom: insets.bottom + spacing.base, gap: spacing.sm }}>
                {footer}
              </View>
            )}
            {!footer && <View style={{ height: insets.bottom + spacing.base }} />}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
