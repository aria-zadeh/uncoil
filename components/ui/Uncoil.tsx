import React, { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  interpolate,
  Extrapolation,
  Easing,
  cancelAnimation,
  useReducedMotion,
  type SharedValue,
} from "react-native-reanimated";
import { spacing, HAIRLINE } from "@/utils/design-tokens";

const RING_COUNT = 5;
const COILED_PITCH_RATIO = 0.25;
const COILED_SCALE_X = 0.55;
const GAP_RATIO = spacing.sm / spacing.base;
const STAGGER = 0.07;
const RING_SPAN = 1 - (RING_COUNT - 1) * STAGGER;

const UNCOIL_MS = 800;
const HOLD_OPEN_MS = 500;
const RECOIL_MS = 500;
const HOLD_COILED_MS = 300;

interface UncoilProps {
  play: "loop" | "once";
  size?: number;
  accessibilityLabel?: string;
}

interface RingProps {
  index: number;
  t: SharedValue<number>;
  size: number;
  stroke: number;
  coiledPitch: number;
  openPitch: number;
}

function Ring({ index, t, size, stroke, coiledPitch, openPitch }: RingProps) {
  // the far end leads, so no ring ever passes its neighbour
  const start = (RING_COUNT - 1 - index) * STAGGER;

  const ringStyle = useAnimatedStyle(() => {
    const p = interpolate(t.value, [start, start + RING_SPAN], [0, 1], Extrapolation.CLAMP);
    return {
      transform: [
        { translateX: interpolate(p, [0, 1], [index * coiledPitch, index * openPitch]) },
        { scaleX: interpolate(p, [0, 1], [COILED_SCALE_X, 1]) },
      ],
    };
  });

  return (
    <Animated.View
      className="absolute left-0 top-0 rounded-full border-primary dark:border-primary-bright"
      style={[{ width: size, height: size, borderWidth: stroke }, ringStyle]}
    />
  );
}

export function Uncoil({ play, size = spacing.base, accessibilityLabel }: UncoilProps) {
  const reduceMotion = useReducedMotion();
  const t = useSharedValue(reduceMotion ? 1 : 0);

  const gap = size * GAP_RATIO;
  const stroke = Math.max(HAIRLINE, (size * HAIRLINE) / spacing.base);
  const coiledPitch = size * COILED_PITCH_RATIO;
  const openPitch = size + gap;
  const width = RING_COUNT * size + (RING_COUNT - 1) * gap;
  const labelled = Boolean(accessibilityLabel);

  useEffect(() => {
    cancelAnimation(t);
    if (reduceMotion) {
      t.value = 1;
      return;
    }
    const uncoil = withTiming(1, { duration: UNCOIL_MS, easing: Easing.out(Easing.cubic) });
    if (play === "once") {
      t.value = uncoil;
    } else {
      // holds are timings to the value already held, so every repeat keeps them
      t.value = withRepeat(
        withSequence(
          uncoil,
          withTiming(1, { duration: HOLD_OPEN_MS }),
          withTiming(0, { duration: RECOIL_MS, easing: Easing.inOut(Easing.cubic) }),
          withTiming(0, { duration: HOLD_COILED_MS })
        ),
        -1,
        false
      );
    }
    return () => cancelAnimation(t);
  }, [play, reduceMotion, t]);

  return (
    <View
      style={{ width, height: size }}
      accessible={labelled}
      accessibilityRole={labelled ? "progressbar" : undefined}
      accessibilityLabel={labelled ? accessibilityLabel : undefined}
      accessibilityElementsHidden={!labelled}
      importantForAccessibility={labelled ? "auto" : "no-hide-descendants"}
    >
      {Array.from({ length: RING_COUNT }, (_, index) => (
        <Ring
          key={index}
          index={index}
          t={t}
          size={size}
          stroke={stroke}
          coiledPitch={coiledPitch}
          openPitch={openPitch}
        />
      ))}
    </View>
  );
}
