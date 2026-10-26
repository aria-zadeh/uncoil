import React from "react";
import { View, Text, ScrollView, KeyboardAvoidingView, Platform } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { CircleButton } from "@/components/ui/CircleButton";
import { StepProgressBar } from "@/components/ui/StepProgressBar";
import { HeroHeadline } from "@/components/ui/HeroHeadline";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { BusyBlockGrid } from "@/components/ui/BusyBlockGrid";
import { useSettingsStore } from "@/store/runtime";
import { spacing } from "@/utils/design-tokens";

const STEPS = 4;
const STEP = 3;

export default function AvailabilityScreen() {
  const insets = useSafeAreaInsets();
  const busyBlocks = useSettingsStore((s) => s.busyBlocks);
  const toggleBusyBlock = useSettingsStore((s) => s.toggleBusyBlock);
  const availabilityNotes = useSettingsStore((s) => s.availabilityNotes);
  const setAvailabilityNotes = useSettingsStore((s) => s.setAvailabilityNotes);

  const handleContinue = () => {
    router.push("/onboarding/energy");
  };

  const handleSkip = () => {
    router.push("/onboarding/energy");
  };

  return (
    <Screen>
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenHeader
          left={<CircleButton icon="chevron-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
          right={
            <CircleButton
              icon="arrow-forward"
              onPress={handleSkip}
              accessibilityLabel="Skip"
              accessibilityHint="Skips availability setup and continues"
            />
          }
        />
        <View style={{ paddingHorizontal: spacing.base, marginTop: spacing.md }}>
          <StepProgressBar steps={STEPS} current={STEP} />
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: spacing.sm, paddingTop: spacing.xl, paddingBottom: spacing.base, gap: spacing.sm }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={{ paddingHorizontal: spacing.sm, marginBottom: spacing.sm }}>
            <HeroHeadline lines={["When are you", "usually busy?"]} />
            <Text
              className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
              style={{ marginTop: spacing.base }}
            >
              Reminders stay out of these times.
            </Text>
          </View>

          <Card padding="lg">
            <BusyBlockGrid busyBlocks={busyBlocks} onToggle={toggleBusyBlock} />
            <View style={{ marginTop: spacing.base }}>
              <Input
                label="Anything else?"
                value={availabilityNotes}
                onChangeText={setAvailabilityNotes}
                placeholder="Swim practice Tuesdays, 4 to 6"
                accessibilityLabel="Additional availability notes"
                multiline
              />
            </View>
          </Card>
        </ScrollView>

        <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm, paddingBottom: insets.bottom + spacing.base }}>
          <Button
            title="Continue"
            variant="primary"
            onPress={handleContinue}
            accessibilityLabel="Continue to energy peak setup"
          />
          <Button
            title="Skip"
            variant="ghost"
            onPress={handleSkip}
            accessibilityLabel="Skip availability and continue"
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
