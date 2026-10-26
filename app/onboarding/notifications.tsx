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
import { SettingsRow } from "@/components/ui/SettingsRow";
import { Button } from "@/components/ui/Button";
import { useNotificationStore, useSettingsStore } from "@/store/runtime";
import { spacing } from "@/utils/design-tokens";

const STEPS = 4;
const STEP = 2;

const PROMISES = [
  { icon: "volume-low-outline", text: "At most one reminder an hour" },
  { icon: "moon-outline", text: "Silent during quiet hours" },
  { icon: "options-outline", text: "Change both any time in your profile" },
] as const;

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const requestPermission = useNotificationStore((s) => s.requestPermission);
  const [requesting, setRequesting] = useState(false);

  // ask only from this tap, never on mount, and store true only when the OS granted it.
  // one Continue and no Skip: App Review rejects a pre-permission screen that mimics
  // "Allow" or lets people skip the system prompt (guideline 5.1.1(iv))
  const handleContinue = async () => {
    setRequesting(true);
    const outcome = await requestPermission();
    updateSetting("notificationsEnabled", outcome === "granted");
    setRequesting(false);
    router.push("/onboarding/availability");
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
          <HeroHeadline lines={["Gentle reminders,", "never nagging."]} />
          <Text
            className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginTop: spacing.base }}
          >
            Uncoil only nudges you when a step is coming up, and never while you are asleep.
          </Text>
        </View>

        <Card padding="lg">
          {PROMISES.map((item) => (
            <SettingsRow key={item.icon} icon={item.icon} label={item.text} />
          ))}
        </Card>
      </ScrollView>

      <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm, paddingBottom: insets.bottom + spacing.base, gap: spacing.sm }}>
        <Button
          title="Continue"
          variant="primary"
          loading={requesting}
          onPress={handleContinue}
          accessibilityLabel="Continue"
          accessibilityHint="Shows the system notification prompt, then continues setup"
        />
      </View>
    </Screen>
  );
}
