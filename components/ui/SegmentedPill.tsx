import React, { useEffect, useRef, useState } from "react";
import { View, Text, ScrollView, type LayoutChangeEvent } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  useReducedMotion,
} from "react-native-reanimated";
import { shadows, spacing, motion, borderRadius, HAIRLINE, SEGMENT_TRACK } from "@/utils/design-tokens";
import { PressableScale } from "./PressableScale";

// past this the pill breaks
const MAX_FONT_SCALE = 1.6;
const TRACK_HEIGHT = SEGMENT_TRACK.height;
const TRACK_INSET = SEGMENT_TRACK.inset;
// 8 so four filters fit across a 390 pt screen
const ITEM_PAD_X = spacing.sm;

export interface SegmentedPillItem {
  key: string;
  label: string;
  count?: number;
  // danger paints a non-zero count red
  tone?: "default" | "danger";
}

export interface SegmentedPillProps {
  items: readonly SegmentedPillItem[];
  value: string;
  onChange: (key: string) => void;
  // natural-width items in a horizontal scroll, instead of equal widths
  scrollable?: boolean;
  accessibilityLabel: string;
}

interface ItemLayout {
  x: number;
  width: number;
}

export function SegmentedPill({ items, value, onChange, scrollable = false, accessibilityLabel }: SegmentedPillProps) {
  const reduceMotion = useReducedMotion();
  const [layouts, setLayouts] = useState<Record<string, ItemLayout>>({});
  const translateX = useSharedValue(0);
  const hasPositioned = useRef(false);

  const active = layouts[value];

  useEffect(() => {
    if (!active) return;
    if (!hasPositioned.current || reduceMotion) {
      translateX.value = active.x;
      hasPositioned.current = true;
      return;
    }
    translateX.value = withTiming(active.x, {
      duration: motion.enter,
      easing: Easing.out(Easing.cubic),
    });
  }, [active, reduceMotion, translateX]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const onItemLayout = (key: string) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout;
    setLayouts((prev) => {
      const prevLayout = prev[key];
      if (prevLayout && prevLayout.x === x && prevLayout.width === width) return prev;
      return { ...prev, [key]: { x, width } };
    });
  };

  const row = (
    <View className="flex-row" style={{ minHeight: TRACK_HEIGHT - TRACK_INSET * 2 }}>
      {active && (
        <Animated.View
          pointerEvents="none"
          className="absolute top-0 bottom-0 left-0 rounded-full bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark"
          style={[{ width: active.width, borderWidth: HAIRLINE }, shadows.sm, indicatorStyle]}
        />
      )}
      {items.map((item) => {
        const selected = item.key === value;
        const countClass =
          item.tone === "danger" && (item.count ?? 0) > 0
            ? "text-danger-dark dark:text-danger-bright"
            : selected
              ? "text-content dark:text-content-dark-primary"
              : "text-content-secondary dark:text-content-dark-secondary";
        return (
          <PressableScale
            key={item.key}
            onPress={() => onChange(item.key)}
            onLayout={onItemLayout(item.key)}
            radius={borderRadius.full}
            className={`items-center justify-center rounded-full ${scrollable ? "" : "flex-1"}`}
            style={{ paddingHorizontal: ITEM_PAD_X }}
            hitSlop={{ top: TRACK_INSET, bottom: TRACK_INSET }}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={item.count !== undefined ? `${item.label}, ${item.count}` : item.label}
          >
            <Text
              className={
                selected
                  ? "text-bodyMedium font-medium text-content dark:text-content-dark-primary"
                  : "text-body font-sans text-content-secondary dark:text-content-dark-secondary"
              }
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              numberOfLines={1}
            >
              {item.label}
              {item.count !== undefined && <Text className={`text-bodyMedium font-medium ${countClass}`}> {item.count}</Text>}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );

  return (
    <View
      className="bg-surface-elevated dark:bg-surface-dark-elevated rounded-full"
      style={{ padding: TRACK_INSET, minHeight: TRACK_HEIGHT }}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
    >
      {scrollable ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {row}
        </ScrollView>
      ) : (
        row
      )}
    </View>
  );
}
