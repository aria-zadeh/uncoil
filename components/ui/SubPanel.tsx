import React from "react";
import { View, Text, type StyleProp, type ViewStyle } from "react-native";
import { spacing, HAIRLINE } from "@/utils/design-tokens";

export interface SubPanelProps {
  label: string;
  children: React.ReactNode;
  tone?: "default" | "accent";
  style?: StyleProp<ViewStyle>;
}

const toneClasses = {
  default: "bg-surface dark:bg-surface-dark border-border dark:border-border-dark",
  accent: "bg-accent-panel dark:bg-accent-panel-bright border-selected-light dark:border-selected-bright-light",
} as const;

export function SubPanel({ label, children, tone = "default", style }: SubPanelProps) {
  return (
    <View
      className={`rounded-md ${toneClasses[tone]}`}
      style={[
        {
          borderWidth: HAIRLINE,
          padding: spacing.md,
        },
        style,
      ]}
    >
      <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary" style={{ marginBottom: spacing.sm }}>
        {label}
      </Text>
      {children}
    </View>
  );
}
