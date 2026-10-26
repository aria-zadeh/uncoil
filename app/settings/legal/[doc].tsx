import React from "react";
import { View, Text, ScrollView } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { CircleButton } from "@/components/ui/CircleButton";
import { Card } from "@/components/ui/Card";
import { LEGAL_DOCS, type LegalDocId } from "@/utils/legalText";
import { spacing, typography } from "@/utils/design-tokens";

const BULLET_PREFIX = "• ";

function isLegalDocId(value: string | undefined): value is LegalDocId {
  return value !== undefined && Object.prototype.hasOwnProperty.call(LEGAL_DOCS, value);
}

export default function LegalDocScreen() {
  const insets = useSafeAreaInsets();
  const { doc: param } = useLocalSearchParams<{ doc?: string | string[] }>();
  const rawId = Array.isArray(param) ? param[0] : param;
  const doc = LEGAL_DOCS[isLegalDocId(rawId) ? rawId : "terms"];

  return (
    <Screen>
      <ScreenHeader
        title={doc.title}
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
        <View style={{ paddingHorizontal: spacing.sm, marginBottom: spacing.sm }}>
          <Text className="text-body font-sans text-content dark:text-content-dark-primary" selectable>
            {doc.intro}
          </Text>
          <Text
            className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginTop: spacing.sm }}
          >
            {`Last updated ${doc.updated}`}
          </Text>
        </View>

        {doc.sections.map((section) => (
          <Card key={section.heading} padding="base">
            <Text
              className="text-subheading font-medium text-content dark:text-content-dark-primary"
              style={{ letterSpacing: typography.subheading.letterSpacing, marginBottom: spacing.md }}
              accessibilityRole="header"
            >
              {section.heading}
            </Text>
            <View style={{ gap: spacing.sm }}>
              {section.body.map((paragraph) =>
                paragraph.startsWith(BULLET_PREFIX) ? (
                  <View key={paragraph} className="flex-row">
                    <Text
                      className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
                      style={{ marginRight: spacing.sm }}
                      importantForAccessibility="no"
                      accessibilityElementsHidden
                    >
                      {"•"}
                    </Text>
                    <Text
                      className="flex-1 text-body font-sans text-content-secondary dark:text-content-dark-secondary"
                      selectable
                    >
                      {paragraph.slice(BULLET_PREFIX.length)}
                    </Text>
                  </View>
                ) : (
                  <Text
                    key={paragraph}
                    className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
                    selectable
                  >
                    {paragraph}
                  </Text>
                ),
              )}
            </View>
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}
