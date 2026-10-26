import React from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";

const UPPERCASE_TRACKING = 0.4;

export interface SectionLabelProps {
  children: string;
  style?: StyleProp<TextStyle>;
}

export function SectionLabel({ children, style }: SectionLabelProps) {
  return (
    <Text
      className="text-small font-medium uppercase text-content-secondary dark:text-content-dark-secondary"
      style={[{ letterSpacing: UPPERCASE_TRACKING }, style]}
      accessibilityRole="header"
    >
      {children}
    </Text>
  );
}
