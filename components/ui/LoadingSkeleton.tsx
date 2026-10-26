import React, { useEffect, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
  cancelAnimation,
  useReducedMotion,
} from "react-native-reanimated";
import { motion, borderRadius } from "@/utils/design-tokens";

const STATIC_OPACITY = 0.7;
const BAND_WIDTH_RATIO = 0.5;

interface LoadingSkeletonProps {
  width: number | `${number}%`;
  height: number;
  borderRadius?: number;
}

// the sweep is linear because a looped ease shows a seam. the band is stacked
// translucent Views so there's no gradient dependency
export function LoadingSkeleton({
  width,
  height,
  borderRadius: radius = borderRadius.lg,
}: LoadingSkeletonProps) {
  const reduceMotion = useReducedMotion();
  const [blockWidth, setBlockWidth] = useState(0);
  const sweep = useSharedValue(0);
  const bandWidth = blockWidth * BAND_WIDTH_RATIO;

  useEffect(() => {
    if (reduceMotion || blockWidth === 0) {
      cancelAnimation(sweep);
      sweep.value = -bandWidth;
      return;
    }
    sweep.value = withRepeat(
      withSequence(
        withTiming(-bandWidth, { duration: 0 }),
        withTiming(blockWidth, { duration: motion.shimmer, easing: Easing.linear })
      ),
      -1,
      false
    );
    return () => cancelAnimation(sweep);
  }, [reduceMotion, blockWidth, bandWidth, sweep]);

  const bandStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: sweep.value }],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setBlockWidth((prev) => (prev === w ? prev : w));
  };

  return (
    <View
      className="bg-surface-elevated dark:bg-surface-dark-elevated overflow-hidden"
      style={{ width, height, borderRadius: radius, opacity: reduceMotion ? STATIC_OPACITY : 1 }}
      onLayout={onLayout}
      accessibilityLabel="Loading content"
    >
      {!reduceMotion && blockWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", top: 0, bottom: 0, width: bandWidth }, bandStyle]}
        >
          <View className="absolute inset-0 bg-surface-card dark:bg-surface-dark-card" style={{ opacity: 0.35 }} />
          <View
            className="absolute bg-surface-card dark:bg-surface-dark-card"
            style={{ opacity: 0.25, left: "15%", right: "15%", top: 0, bottom: 0 }}
          />
          <View
            className="absolute bg-surface-card dark:bg-surface-dark-card"
            style={{ opacity: 0.4, left: "35%", right: "35%", top: 0, bottom: 0 }}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}
