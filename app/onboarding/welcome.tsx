import React from "react";
import { View, Text, ScrollView } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { StepProgressBar } from "@/components/ui/StepProgressBar";
import { HeroHeadline } from "@/components/ui/HeroHeadline";
import { Uncoil } from "@/components/ui/Uncoil";
import { Card } from "@/components/ui/Card";
import { SettingsRow } from "@/components/ui/SettingsRow";
import { Button } from "@/components/ui/Button";
import { spacing } from "@/utils/design-tokens";
import { ONBOARDING_AI_NOTICE, ONBOARDING_CONSENT_PREFIX } from "@/utils/legalText";

// the setup screens after welcome. welcome itself sits before the first
const STEPS = 4;
const STEP = 0;

const HOW_IT_WORKS = [
  { icon: "list-outline", text: "Break a task into small steps" },
  { icon: "calendar-outline", text: "Plan them around your week" },
  { icon: "timer-outline", text: "Focus on one step at a time" },
] as const;

export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();

  return (
    <Screen>
      {/* nothing to go back to, the empty header just keeps the top spacing */}
      <ScreenHeader />
      <View style={{ paddingHorizontal: spacing.base, marginTop: spacing.md }}>
        <StepProgressBar steps={STEPS} current={STEP} />
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: spacing.sm, paddingTop: spacing.xl, paddingBottom: spacing.base, gap: spacing.sm }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingHorizontal: spacing.sm, marginBottom: spacing.sm }}>
          <View style={{ marginBottom: spacing.base }}>
            <Uncoil play="once" />
          </View>
          <HeroHeadline lines={["Welcome to Uncoil.", "One small step at a time."]} />
          <Text
            className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginTop: spacing.base }}
          >
            Big assignments get split into small steps, so you always know exactly what to do next.
          </Text>
        </View>

        <Card padding="lg">
          {HOW_IT_WORKS.map((item) => (
            <SettingsRow key={item.icon} icon={item.icon} label={item.text} />
          ))}
        </Card>
      </ScrollView>

      <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm, paddingBottom: insets.bottom + spacing.base }}>
        {/* two short lines so the buttons stay on screen on a small phone */}
        <View style={{ paddingHorizontal: spacing.sm, marginBottom: spacing.sm }}>
          <Text className="text-center text-caption font-sans text-content-secondary dark:text-content-dark-secondary">
            {ONBOARDING_AI_NOTICE}
          </Text>
          <Text
            className="text-center text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginTop: spacing.xs }}
          >
            {ONBOARDING_CONSENT_PREFIX}
            <Text
              className="underline"
              onPress={() => router.push("/settings/legal/terms")}
              accessibilityRole="link"
              accessibilityLabel="Terms of Use"
              accessibilityHint="Opens the Terms of Use"
            >
              Terms of Use
            </Text>
            {" and "}
            <Text
              className="underline"
              onPress={() => router.push("/settings/legal/privacy")}
              accessibilityRole="link"
              accessibilityLabel="Privacy Policy"
              accessibilityHint="Opens the Privacy Policy"
            >
              Privacy Policy
            </Text>
            {"."}
          </Text>
        </View>
        <Button
          title="Get started"
          variant="primary"
          onPress={() => router.push("/onboarding/name")}
          accessibilityLabel="Get started"
          accessibilityHint="Continues to name setup"
        />
        <Button
          title="Add a task first"
          variant="ghost"
          onPress={() => router.push("/task/new")}
          accessibilityLabel="Add a task first"
          accessibilityHint="Opens the add task screen; setup continues afterwards"
        />
      </View>
    </Screen>
  );
}
