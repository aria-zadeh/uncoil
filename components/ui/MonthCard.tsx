import React from "react";
import { View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, typography, borderRadius, ICON_SIZE, TOUCH_TARGET_MIN } from "@/utils/design-tokens";
import { Card } from "./Card";
import { PressableScale } from "./PressableScale";

export interface MonthCardProps {
  label: string;
  // showing the month grid instead of the week strip
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

export function MonthCard({ label, expanded, onToggle, children }: MonthCardProps) {
  return (
    <Card padding="base">
      <PressableScale
        onPress={onToggle}
        radius={borderRadius.sm}
        className="flex-row items-center self-start rounded-sm"
        style={{ minHeight: TOUCH_TARGET_MIN, marginTop: -spacing.sm }}
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Show week strip" : "Show month grid"}
        accessibilityState={{ expanded }}
      >
        <Text
          className="text-heading font-medium text-content dark:text-content-dark-primary"
          style={{ letterSpacing: typography.heading.letterSpacing }}
        >
          {label}
        </Text>
        <Ionicons
          name={expanded ? "chevron-up" : "chevron-down"}
          size={ICON_SIZE.inline}
          className="text-content dark:text-content-dark-primary"
          style={{ marginLeft: spacing.sm }}
        />
      </PressableScale>
      <View style={{ marginTop: spacing.md }}>{children}</View>
    </Card>
  );
}
