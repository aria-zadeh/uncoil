import React from "react";
import { View, Text } from "react-native";
import { typography } from "@/utils/design-tokens";

export interface HeroHeadlineProps {
  // each line is its own Text so the break never moves
  lines: [string, string];
}

export function HeroHeadline({ lines }: HeroHeadlineProps) {
  return (
    <View accessibilityRole="header" accessibilityLabel={`${lines[0]} ${lines[1]}`}>
      {lines.map((line, index) => (
        <Text
          key={index}
          className="text-display font-medium text-content dark:text-content-dark-primary"
          style={{ letterSpacing: typography.display.letterSpacing }}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}
