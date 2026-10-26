import React from "react";
import { View, Text } from "react-native";
import { spacing, typography } from "@/utils/design-tokens";
import { Card } from "./Card";
import { Button } from "./Button";
import type { Glyph } from "./icons";

interface EmptyStateProps {
  title: string;
  subtitle: string;
  actionLabel?: string;
  onAction?: () => void;
  /** @deprecated ignored, there is no illustration any more */
  icon?: Glyph;
}

export function EmptyState({ title, subtitle, actionLabel, onAction }: EmptyStateProps) {
  return (
    <Card accessibilityLabel={`${title}. ${subtitle}`}>
      <Text
        className="text-heading font-medium text-content dark:text-content-dark-primary"
        style={{ letterSpacing: typography.heading.letterSpacing }}
      >
        {title}
      </Text>
      <Text
        className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
        style={{ marginTop: spacing.xs }}
        numberOfLines={3}
      >
        {subtitle}
      </Text>
      {actionLabel && onAction && (
        <View style={{ marginTop: spacing.base }}>
          <Button title={actionLabel} onPress={onAction} variant="primary" />
        </View>
      )}
    </Card>
  );
}
