import React from "react";
import { View, Text } from "react-native";
import { spacing, typography, CIRCLE_BUTTON } from "@/utils/design-tokens";

export interface ScreenHeaderProps {
  title?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
}

// opaque so content scrolling beneath it doesn't show through. the safe-area inset comes from Screen
export function ScreenHeader({ title, left, right }: ScreenHeaderProps) {
  return (
    <View
      className="flex-row items-center bg-surface dark:bg-surface-dark"
      style={{ paddingTop: spacing.sm, paddingHorizontal: spacing.base, minHeight: CIRCLE_BUTTON }}
    >
      {left ? <View style={{ marginRight: spacing.md }}>{left}</View> : null}
      {title ? (
        <Text
          className="flex-1 text-title font-medium text-content dark:text-content-dark-primary"
          style={{ letterSpacing: typography.title.letterSpacing }}
          accessibilityRole="header"
          numberOfLines={2}
        >
          {title}
        </Text>
      ) : (
        <View className="flex-1" />
      )}
      {right ? <View style={{ marginLeft: spacing.md }}>{right}</View> : null}
    </View>
  );
}
