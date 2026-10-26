import React, { useState } from "react";
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
import { useSettingsStore } from "@/store/runtime";
import { spacing } from "@/utils/design-tokens";

const STEPS = 4;
const STEP = 1;

export default function NameScreen() {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState("");
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const handleContinue = () => {
    if (name.trim()) {
      updateSetting("displayName", name.trim());
    }
    router.push("/onboarding/notifications");
  };

  const handleSkip = () => {
    router.push("/onboarding/notifications");
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
              accessibilityHint="Skips name entry and continues"
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
            <HeroHeadline lines={["What should", "we call you?"]} />
            <Text
              className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
              style={{ marginTop: spacing.base }}
            >
              It shows on the Home screen. Nothing is sent anywhere.
            </Text>
          </View>

          <Card padding="lg">
            <Input
              label="Your first name"
              placeholder="First name"
              value={name}
              onChangeText={setName}
              autoFocus
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={handleContinue}
              accessibilityLabel="Enter your first name"
            />
          </Card>
        </ScrollView>

        <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm, paddingBottom: insets.bottom + spacing.base, gap: spacing.sm }}>
          <Button title="Continue" variant="primary" onPress={handleContinue} accessibilityLabel="Save name and continue" />
          <Button title="Skip" variant="ghost" onPress={handleSkip} accessibilityLabel="Skip name entry and continue" />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
