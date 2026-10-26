import React from "react";
import { Text, ScrollView } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { CircleButton } from "@/components/ui/CircleButton";
import { Card } from "@/components/ui/Card";
import { SMOLLM2_LICENSE_TEXT, FONT_LICENSE_TEXT } from "@/assets/model/license";
import { spacing, typography } from "@/utils/design-tokens";

const LICENSES = [
  { key: "model", title: "On-device model (Apache License 2.0)", text: SMOLLM2_LICENSE_TEXT },
  { key: "font", title: "Instrument Sans (SIL Open Font License 1.1)", text: FONT_LICENSE_TEXT },
] as const;

export default function LicensesScreen() {
  const insets = useSafeAreaInsets();

  return (
    <Screen>
      <ScreenHeader
        title="Licenses"
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
        {LICENSES.map((license) => (
          <Card key={license.key} padding="base">
            <Text
              className="text-subheading font-medium text-content dark:text-content-dark-primary"
              style={{ letterSpacing: typography.subheading.letterSpacing, marginBottom: spacing.md }}
              accessibilityRole="header"
            >
              {license.title}
            </Text>
            <Text
              className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
              style={{ fontVariant: ["tabular-nums"] }}
              selectable
            >
              {license.text}
            </Text>
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}
