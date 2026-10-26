import React from "react";
import { Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { spacing, borderRadius, HAIRLINE, ICON_SIZE } from "@/utils/design-tokens";
import { PressableScale } from "./PressableScale";
import type { Glyph } from "./icons";

// 96, no token carries it
const PANEL_HEIGHT = spacing["5xl"] + spacing["2xl"];

export interface DropzoneProps {
  title: string;
  hint: string;
  icon?: Glyph;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
}

export function Dropzone({ title, hint, icon = "document-text-outline", onPress, accessibilityLabel, accessibilityHint }: DropzoneProps) {
  return (
    <PressableScale
      onPress={onPress}
      radius={borderRadius.md}
      className="items-center justify-center rounded-md border-dashed bg-dropzone dark:bg-dropzone-bright border-dropzone dark:border-dropzone-bright"
      style={{ minHeight: PANEL_HEIGHT, borderWidth: HAIRLINE, paddingHorizontal: spacing.base, paddingVertical: spacing.md }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
    >
      <Ionicons name={icon} size={ICON_SIZE.tab} className="text-selected dark:text-selected-bright" />
      <Text
        className="text-bodyMedium font-medium text-content dark:text-content-dark-primary text-center"
        style={{ marginTop: spacing.sm }}
      >
        {title}
      </Text>
      <Text
        className="text-small font-medium text-content-secondary dark:text-content-dark-secondary text-center"
        style={{ marginTop: spacing.xs }}
      >
        {hint}
      </Text>
    </PressableScale>
  );
}
