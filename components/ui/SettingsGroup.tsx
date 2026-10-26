import React from "react";
import { View } from "react-native";
import { spacing } from "@/utils/design-tokens";
import { Card } from "./Card";
import { SectionLabel } from "./SectionLabel";

export interface SettingsGroupProps {
  label: string;
  children: React.ReactNode;
}

export function SettingsGroup({ label, children }: SettingsGroupProps) {
  return (
    <Card padding="base" accessibilityLabel={`${label} settings`}>
      <SectionLabel style={{ marginBottom: spacing.sm }}>{label}</SectionLabel>
      <View>{children}</View>
    </Card>
  );
}
