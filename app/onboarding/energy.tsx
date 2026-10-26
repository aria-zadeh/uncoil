import React, { useState } from "react";
import { View, Text, ScrollView } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { CircleButton } from "@/components/ui/CircleButton";
import { StepProgressBar } from "@/components/ui/StepProgressBar";
import { HeroHeadline } from "@/components/ui/HeroHeadline";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { SelectChip, SelectChipRow } from "@/components/ui/SelectChip";
import { useSettingsStore } from "@/store/runtime";
import { spacing, typography } from "@/utils/design-tokens";
import { requestTutorial } from "@/utils/pendingTutorial";

const STEPS = 4;
const STEP = 4;

const TIME_SLOTS = [
  { label: "Morning", subtitle: "8 am to 12 pm", start: 8, end: 12, icon: "sunny-outline" },
  { label: "Afternoon", subtitle: "12 to 4 pm", start: 12, end: 16, icon: "partly-sunny-outline" },
  { label: "Late afternoon", subtitle: "4 to 7 pm", start: 16, end: 19, icon: "cloudy-outline" },
  { label: "Evening", subtitle: "7 to 11 pm", start: 19, end: 23, icon: "moon-outline" },
] as const;

export default function EnergyScreen() {
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState(1); // afternoon
  const setEnergyPeak = useSettingsStore((s) => s.setEnergyPeak);
  const completeOnboarding = useSettingsStore((s) => s.completeOnboarding);

  const handleFinish = () => {
    const slot = TIME_SLOTS[selected];
    setEnergyPeak(slot.start, slot.end);
    completeOnboarding();
    // Home opens the tutorial once it mounts
    requestTutorial();
    router.replace("/(tabs)");
  };

  // skipping leaves the energy window at its default, which the scheduler reads as no preference
  const handleSkip = () => {
    completeOnboarding();
    requestTutorial();
    router.replace("/(tabs)");
  };

  return (
    <Screen>
      <ScreenHeader
        left={<CircleButton icon="chevron-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
      />
      <View style={{ paddingHorizontal: spacing.base, marginTop: spacing.md }}>
        <StepProgressBar steps={STEPS} current={STEP} />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: spacing.sm, paddingTop: spacing.xl, paddingBottom: spacing.base, gap: spacing.sm }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingHorizontal: spacing.sm, marginBottom: spacing.sm }}>
          <HeroHeadline lines={["When do you", "focus best?"]} />
          <Text
            className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginTop: spacing.base }}
          >
            Reminders land in your best hours. You can change this any time.
          </Text>
        </View>

        <Card padding="lg">
          <Text
            className="text-subheading font-medium text-content dark:text-content-dark-primary"
            style={{ letterSpacing: typography.subheading.letterSpacing, marginBottom: spacing.md }}
            accessibilityRole="header"
          >
            Best time of day
          </Text>
          <SelectChipRow accessibilityLabel="Best time of day">
            {TIME_SLOTS.map((slot, i) => (
              <SelectChip
                key={slot.label}
                label={slot.label}
                icon={slot.icon}
                selected={selected === i}
                onPress={() => setSelected(i)}
                accessibilityLabel={`${slot.label}, ${slot.subtitle}`}
              />
            ))}
          </SelectChipRow>
          <Text
            className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginTop: spacing.md }}
            accessibilityLiveRegion="polite"
          >
            {TIME_SLOTS[selected].label}: {TIME_SLOTS[selected].subtitle}
          </Text>
        </Card>
      </ScrollView>

      <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm, paddingBottom: insets.bottom + spacing.base }}>
        <Button
          title="All set"
          variant="primary"
          onPress={handleFinish}
          accessibilityLabel="Complete setup and go to home screen"
        />
        <Button
          title="Skip"
          variant="ghost"
          onPress={handleSkip}
          accessibilityLabel="Skip choosing a time of day and finish setup"
        />
      </View>
    </Screen>
  );
}
