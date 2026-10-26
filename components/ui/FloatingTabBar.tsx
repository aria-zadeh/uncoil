import React, { useEffect, useRef } from "react";
import { View, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withSequence,
  Easing,
  useReducedMotion,
} from "react-native-reanimated";
import { shadows, motion, press, springs, HAIRLINE, ICON_SIZE, TAB_PILL, FAB_SIZE } from "@/utils/design-tokens";
import { FAB } from "./FAB";
import type { Glyph } from "./icons";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const ACTIVE_ICON_PEAK = 1.08;
// both crossfading layers fill the slot so they land on exactly the same spot
const STACK_FILL = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" } as const;
const SLOT_COUNT = 3;
const PILL_WIDTH = SLOT_COUNT * TAB_PILL.slot + 2 * TAB_PILL.inset;
const GROUP_WIDTH = PILL_WIDTH + TAB_PILL.gap + FAB_SIZE;

const TAB_ICONS: Record<string, { idle: Glyph; active: Glyph; label: string }> = {
  index: { idle: "home-outline", active: "home", label: "Home tab" },
  calendar: { idle: "calendar-clear-outline", active: "calendar-clear", label: "Schedule tab" },
  profile: { idle: "person-circle-outline", active: "person-circle", label: "Profile tab" },
};

export interface FloatingTabBarProps extends BottomTabBarProps {
  onAdd: () => void;
}

interface TabItemProps {
  idleIcon: Glyph;
  activeIcon: Glyph;
  focused: boolean;
  label: string;
  onPress: () => void;
  onLongPress: () => void;
}

// the active disc jumps, only the glyph animates. the crossfade is opacity only,
// so it stays on under Reduce Motion
function TabItem({ idleIcon, activeIcon, focused, label, onPress, onLongPress }: TabItemProps) {
  const reduceMotion = useReducedMotion();
  const pressScale = useSharedValue(1);
  const focusProgress = useSharedValue(focused ? 1 : 0);
  const activePop = useSharedValue(1);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    focusProgress.value = withTiming(focused ? 1 : 0, { duration: motion.enter, easing: Easing.out(Easing.cubic) });
    if (focused && !reduceMotion) {
      activePop.value = withSequence(
        withTiming(ACTIVE_ICON_PEAK, { duration: motion.press, easing: Easing.out(Easing.cubic) }),
        withSpring(1, springs.settle)
      );
    }
  }, [focused, reduceMotion, focusProgress, activePop]);

  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: pressScale.value }] }));
  const idleStyle = useAnimatedStyle(() => ({ opacity: 1 - focusProgress.value }));
  const activeStyle = useAnimatedStyle(() => ({
    opacity: focusProgress.value,
    transform: [{ scale: reduceMotion ? 1 : activePop.value }],
  }));

  return (
    <AnimatedPressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={() => {
        if (!reduceMotion) pressScale.value = withSpring(press.scale, springs.press);
      }}
      onPressOut={() => {
        if (!reduceMotion) pressScale.value = withSpring(1, springs.press);
      }}
      className={`items-center justify-center rounded-full ${focused ? "bg-surface-elevated dark:bg-surface-dark-elevated" : ""}`}
      style={[{ width: TAB_PILL.slot, height: TAB_PILL.slot }, pressStyle]}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={label}
    >
      <Animated.View style={[STACK_FILL, idleStyle]}>
        <Ionicons name={idleIcon} size={ICON_SIZE.tab} className="text-content-secondary dark:text-content-dark-secondary" />
      </Animated.View>
      <Animated.View style={[STACK_FILL, activeStyle]}>
        <Ionicons name={activeIcon} size={ICON_SIZE.tab} className="text-selected dark:text-selected-bright" />
      </Animated.View>
    </AnimatedPressable>
  );
}

// screens pad their scroll views by TAB_BAR_CLEARANCE so the last card clears the bar
export function FloatingTabBar({ state, descriptors, navigation, onAdd }: FloatingTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      pointerEvents="box-none"
      className="absolute left-0 right-0 items-center"
      style={{ bottom: insets.bottom + TAB_PILL.gap }}
    >
      <View className="flex-row items-center" style={{ width: GROUP_WIDTH, gap: TAB_PILL.gap }}>
        <View
          className="flex-row items-center rounded-full bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark"
          style={[{ height: TAB_PILL.height, width: PILL_WIDTH, padding: TAB_PILL.inset, borderWidth: HAIRLINE }, shadows.lg]}
          accessibilityRole="tablist"
        >
          {state.routes.map((route, index) => {
            const { options } = descriptors[route.key];
            // Expo Router hides a route from the bar with href: null
            if ((options as { href?: unknown }).href === null) return null;
            const glyphs = TAB_ICONS[route.name];
            if (!glyphs) return null;
            const focused = state.index === index;
            return (
              <TabItem
                key={route.key}
                idleIcon={glyphs.idle}
                activeIcon={glyphs.active}
                focused={focused}
                label={options.tabBarAccessibilityLabel ?? glyphs.label}
                onPress={() => {
                  const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                  if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
                }}
                onLongPress={() => {
                  navigation.emit({ type: "tabLongPress", target: route.key });
                }}
              />
            );
          })}
        </View>
        <FAB onPress={onAdd} />
      </View>
    </View>
  );
}
