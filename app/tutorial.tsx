import React, { useCallback, useRef, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { StepProgressBar } from "@/components/ui/StepProgressBar";
import { Button } from "@/components/ui/Button";
import type { Glyph } from "@/components/ui/icons";
import { ICON_SIZE, borderRadius, spacing, typography } from "@/utils/design-tokens";

interface TutorialCard {
  readonly icon: Glyph;
  // full class strings so NativeWind can find them at build time
  readonly disc: string;
  readonly glyph: string;
  readonly heading: string;
  readonly body: string;
}

const CARDS: readonly TutorialCard[] = [
  {
    icon: "add-circle-outline",
    disc: "bg-selected-light dark:bg-selected-bright-light",
    glyph: "text-selected-dark dark:text-selected-bright-dark",
    heading: "Add a task",
    body: "Tap + and type what you have to do. Or paste a syllabus or a teacher's email, and Uncoil finds the tasks and due dates.",
  },
  {
    icon: "sparkles-outline",
    disc: "bg-success-light dark:bg-success-bright-light",
    glyph: "text-success-dark dark:text-success-bright-dark",
    heading: "Break it down",
    body: "Tap Break it down. An AI model on your phone suggests a few small steps, starting with one you can do right now.",
  },
  {
    icon: "shield-checkmark-outline",
    disc: "bg-warning-light dark:bg-warning-bright-light",
    glyph: "text-warning-dark dark:text-warning-bright-dark",
    heading: "You decide",
    body: "Suggestions can be wrong. Check each step against your assignment, judge whether it is safe and makes sense, and follow your teacher's instructions.",
  },
  {
    icon: "calendar-outline",
    disc: "bg-danger-light dark:bg-danger-bright-light",
    glyph: "text-danger-dark dark:text-danger-bright-dark",
    heading: "It finds the time",
    body: "Uncoil places your steps on the calendar around the busy times you set. Start a focus session when it is time.",
  },
  {
    icon: "lock-closed-outline",
    disc: "bg-selected-light dark:bg-selected-bright-light",
    glyph: "text-selected-dark dark:text-selected-bright-dark",
    heading: "Private by design",
    body: "Everything stays on this phone. No account, no internet. You can reopen this guide from the menu on the home screen.",
  },
];

const ICON_DISC = spacing["5xl"];

export default function TutorialScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const scrollRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const isLast = page === CARDS.length - 1;

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)");
  }, []);

  const handleMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (width <= 0) return;
      const next = Math.round(event.nativeEvent.contentOffset.x / width);
      setPage(Math.min(Math.max(next, 0), CARDS.length - 1));
    },
    [width],
  );

  const handleNext = useCallback(() => {
    if (page >= CARDS.length - 1) {
      leave();
      return;
    }
    const next = page + 1;
    // reduce motion jumps without a momentum phase, so onMomentumScrollEnd never fires
    scrollRef.current?.scrollTo({ x: next * width, animated: !reduceMotion });
    setPage(next);
  }, [page, width, reduceMotion, leave]);

  return (
    <Screen>
      <ScreenHeader />
      <View style={{ paddingHorizontal: spacing.base, marginTop: spacing.md }}>
        <StepProgressBar steps={CARDS.length} current={page + 1} />
      </View>

      <ScrollView
        ref={scrollRef}
        className="flex-1"
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleMomentumEnd}
      >
        {CARDS.map((card, index) => {
          const current = index === page;
          return (
            <ScrollView
              key={card.heading}
              style={{ width }}
              contentContainerStyle={{
                paddingHorizontal: spacing.xl,
                paddingTop: spacing["3xl"],
                paddingBottom: spacing.base,
              }}
              showsVerticalScrollIndicator={false}
              // only the visible card is reachable by VoiceOver
              accessibilityElementsHidden={!current}
              importantForAccessibility={current ? "auto" : "no-hide-descendants"}
            >
              <View accessible accessibilityLabel={`${card.heading}. ${card.body}`}>
                <View
                  className={`items-center justify-center ${card.disc}`}
                  style={{ width: ICON_DISC, height: ICON_DISC, borderRadius: borderRadius.full }}
                >
                  <Ionicons
                    name={card.icon}
                    size={ICON_SIZE.hero}
                    className={card.glyph}
                  />
                </View>
                <Text
                  className="text-display font-medium text-content dark:text-content-dark-primary"
                  style={{ letterSpacing: typography.display.letterSpacing, marginTop: spacing.xl }}
                >
                  {card.heading}
                </Text>
                <Text
                  className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
                  style={{ marginTop: spacing.base }}
                >
                  {card.body}
                </Text>
              </View>
            </ScrollView>
          );
        })}
      </ScrollView>

      <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm, paddingBottom: insets.bottom + spacing.base }}>
        <Button
          title={isLast ? "Get started" : "Next"}
          variant="primary"
          onPress={handleNext}
          accessibilityLabel={isLast ? "Get started" : "Next"}
          accessibilityHint={isLast ? "Closes the guide" : `Shows step ${page + 2} of ${CARDS.length}`}
        />
        <Button
          title="Skip"
          variant="ghost"
          onPress={leave}
          accessibilityLabel="Skip"
          accessibilityHint="Closes the guide"
        />
      </View>
    </Screen>
  );
}
