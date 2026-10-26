import React, { useMemo } from "react";
import { Text, ScrollView, Switch } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColorScheme } from "nativewind";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { CircleButton } from "@/components/ui/CircleButton";
import { Card } from "@/components/ui/Card";
import { SettingsRow } from "@/components/ui/SettingsRow";
import { useGenerationStore, useSettingsStore } from "@/store/runtime";
import { colors, spacing, typography } from "@/utils/design-tokens";
import type { ModelStatus } from "@/types";

interface StatusCopy {
  state: string;
  heading: string;
  body: string;
  // only set when failed. plain words, never a technical reason the user did not ask for
  reasonLine: string | null;
}

function statusCopy(status: ModelStatus): StatusCopy {
  switch (status.state) {
    case "loading":
      return {
        state: "Getting ready",
        heading: "Getting ready",
        body: "Uncoil is loading the on-device model. This only takes a moment.",
        reasonLine: null,
      };
    case "ready":
      return {
        state: "Ready",
        heading: "Generated steps are working",
        body: "Uncoil is creating tailored steps for your assignments right on this device.",
        reasonLine: null,
      };
    case "failed": {
      let reasonLine: string;
      switch (status.reason) {
        case "load_error":
          reasonLine = "The on-device model could not load, so Uncoil is using general steps instead.";
          break;
        case "out_of_memory":
          reasonLine =
            "There wasn't enough room on this device to run the on-device model, so Uncoil is using general steps instead.";
          break;
        case "unsupported":
          reasonLine = "This device could not run the on-device model, so Uncoil is using general steps instead.";
          break;
        case "disabled":
          reasonLine = "Tailored steps are turned off, so Uncoil is using general steps instead.";
          break;
        default: {
          const exhaustive: never = status.reason;
          reasonLine = exhaustive;
        }
      }
      return {
        state: "General steps",
        heading: "Showing general steps for now",
        body: "Every part of Uncoil still works this way. Only the wording of the steps is different.",
        reasonLine,
      };
    }
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export default function ModelSettingsScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";

  const status = useGenerationStore((s) => s.status);
  const generationOptOut = useSettingsStore((s) => s.generationOptOut);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  // `status` still reflects the last run before the opt-out, so the setting wins
  const copy = useMemo(() => {
    if (generationOptOut) {
      return {
        state: "Turned off",
        heading: "Turned off",
        body: "Tailored steps are off. Turn them on below to use the on-device model.",
        reasonLine: null,
      };
    }
    return statusCopy(status);
  }, [status, generationOptOut]);

  return (
    <Screen>
      <ScreenHeader
        title="Model"
        left={<CircleButton icon="chevron-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
      />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: spacing.sm,
          paddingTop: spacing.xl,
          paddingBottom: insets.bottom + spacing.base,
          gap: spacing.sm,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Card padding="base">
          <Text
            className="text-subheading font-medium text-content dark:text-content-dark-primary"
            style={{ letterSpacing: typography.subheading.letterSpacing, marginBottom: spacing.xs }}
            accessibilityRole="header"
          >
            On-device model
          </Text>
          <SettingsRow icon="hardware-chip-outline" label={copy.heading} value={copy.state} />
          <Text
            className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginTop: spacing.xs }}
          >
            {copy.body}
          </Text>
          {copy.reasonLine !== null && (
            <Text
              className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
              style={{ marginTop: spacing.sm }}
            >
              {copy.reasonLine}
            </Text>
          )}
        </Card>

        <Card padding="base">
          <Text
            className="text-subheading font-medium text-content dark:text-content-dark-primary"
            style={{ letterSpacing: typography.subheading.letterSpacing, marginBottom: spacing.sm }}
            accessibilityRole="header"
          >
            Generation
          </Text>
          <SettingsRow
            icon="hardware-chip-outline"
            label="Tailored steps"
            accessory={
              <Switch
                value={!generationOptOut}
                onValueChange={(next) => updateSetting("generationOptOut", !next)}
                trackColor={{ false: colors[scheme].elevated, true: colors[scheme].accent }}
                accessibilityLabel="Tailored steps"
                accessibilityHint="Turns the on-device model on or off"
              />
            }
            accessibilityLabel="Tailored steps"
          />
          <Text
            className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginTop: spacing.xs }}
          >
            On: Uncoil writes steps for each task with the model on this device. Off: Uncoil uses general step
            patterns and never loads the model.
          </Text>
        </Card>

        <Card padding="base">
          <SettingsRow
            icon="document-text-outline"
            label="Licenses"
            onPress={() => router.push("/settings/licenses")}
            accessibilityLabel="View on-device model license"
          />
          <SettingsRow
            icon="sparkles-outline"
            label="About the AI"
            onPress={() => router.push("/settings/legal/ai")}
            accessibilityLabel="About the AI"
            accessibilityHint="Opens what the on-device AI does and its limits"
          />
        </Card>
      </ScrollView>
    </Screen>
  );
}
