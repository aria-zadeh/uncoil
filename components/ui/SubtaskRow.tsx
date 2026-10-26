import React from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useColorScheme } from "nativewind";
import { colors, spacing, borderRadius, ICON_SIZE, HAIRLINE, TOUCH_TARGET_MIN } from "@/utils/design-tokens";
import { ChecklistRow } from "./ChecklistRow";
import { PressableScale } from "./PressableScale";

// app/focus/session.tsx draws its own step card and imports this so the wording matches
export const RESTORE_LABEL = "Restore original";

const EASIER_DISC = spacing.xl + spacing.xs;

interface SubtaskRowProps {
  title: string;
  durationMinutes: number;
  completed: boolean;
  onToggle: () => void;
  onMakeEasier?: () => void;
  isMakingEasier?: boolean;
  // set once the step has been simplified. its presence shows the restore control
  originalTitle?: string;
  onRestore?: () => void;
}

export function SubtaskRow({
  title,
  durationMinutes,
  completed,
  onToggle,
  onMakeEasier,
  isMakingEasier = false,
  originalTitle,
  onRestore,
}: SubtaskRowProps) {
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const slop = (TOUCH_TARGET_MIN - EASIER_DISC) / 2;

  return (
    <View style={{ paddingVertical: spacing.xs }}>
      <View className="flex-row items-center">
        <View className="flex-1">
          <ChecklistRow
            title={title}
            checked={completed}
            onToggle={onToggle}
            minutes={durationMinutes}
            accessibilityLabel={`${title}, ${durationMinutes} minutes${completed ? ", completed" : ""}`}
          />
        </View>

        {onMakeEasier && !completed && (
          <PressableScale
            onPress={onMakeEasier}
            disabled={isMakingEasier}
            radius={borderRadius.full}
            className="items-center justify-center rounded-full bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark"
            style={{ width: EASIER_DISC, height: EASIER_DISC, borderWidth: HAIRLINE, marginLeft: spacing.sm }}
            hitSlop={slop}
            accessibilityRole="button"
            accessibilityLabel={isMakingEasier ? "Making this step easier…" : "Make this step easier"}
            accessibilityHint="AI will suggest a simpler version of this step"
            accessibilityState={{ busy: isMakingEasier }}
          >
            {isMakingEasier ? (
              <ActivityIndicator size="small" color={colors[scheme].text} accessibilityLabel="Simplifying step" />
            ) : (
              <Ionicons name="text-outline" size={ICON_SIZE.chip} className="text-content dark:text-content-dark-primary" />
            )}
          </PressableScale>
        )}
      </View>

      {/* shown even on a completed step, unlike make easier */}
      {originalTitle !== undefined && onRestore && (
        <PressableScale
          onPress={onRestore}
          radius={borderRadius.sm}
          className="flex-row items-center self-start"
          style={{ minHeight: TOUCH_TARGET_MIN, paddingLeft: spacing.xl + 2 }}
          accessibilityRole="button"
          accessibilityLabel={RESTORE_LABEL}
          hitSlop={spacing.sm}
        >
          <Ionicons
            name="arrow-undo-outline"
            size={ICON_SIZE.chip}
            className="text-content-secondary dark:text-content-dark-secondary"
          />
          <Text className="text-small font-medium text-content-secondary dark:text-content-dark-secondary" style={{ marginLeft: spacing.xs }}>
            {RESTORE_LABEL}
          </Text>
        </PressableScale>
      )}
    </View>
  );
}
