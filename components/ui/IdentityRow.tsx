import React from "react";
import { View, Text } from "react-native";
import { spacing, typography, AVATAR_SIZE } from "@/utils/design-tokens";

const AVATAR = AVATAR_SIZE;

export interface IdentityRowProps {
  name: string;
  subtitle: string;
  initial?: string;
}

export function IdentityRow({ name, subtitle, initial }: IdentityRowProps) {
  const letter = (initial ?? name.trim().charAt(0) ?? "").toUpperCase();
  return (
    <View className="flex-row items-center" accessibilityLabel={`${name}. ${subtitle}`}>
      <View
        className="items-center justify-center rounded-full bg-surface-elevated dark:bg-surface-dark-elevated"
        style={{ width: AVATAR, height: AVATAR }}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        <Text className="text-heading font-medium text-content dark:text-content-dark-primary">{letter}</Text>
      </View>
      <View className="flex-1" style={{ marginLeft: spacing.base }}>
        <Text
          className="text-subheading font-medium text-content dark:text-content-dark-primary"
          style={{ letterSpacing: typography.subheading.letterSpacing }}
          numberOfLines={1}
        >
          {name}
        </Text>
        <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary" numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
    </View>
  );
}
