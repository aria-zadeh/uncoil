import React from "react";
import { View, Text } from "react-native";
import Animated, { FadeIn, Easing, useReducedMotion } from "react-native-reanimated";
import { motion, spacing, typography } from "@/utils/design-tokens";
import { formatDuration } from "@/utils/format";
import { Card } from "./Card";
import { SubPanel } from "./SubPanel";
import { SelectChip, SelectChipRow } from "./SelectChip";
import { Button } from "./Button";

// what services/rightNow.ts picked. components can't import services, so the screen passes it down
export interface RightNowPickView {
  // a subtask's title, or the task's own when it has none
  title: string;
  taskTitle: string;
  // already padded by the learned multiplier
  fitMinutes: number;
}

export interface RightNowCardProps {
  // minutes
  options: readonly number[];
  selected: number | null;
  onSelect: (minutes: number) => void;
  // null when nothing fits
  pick: RightNowPickView | null;
  onStart: () => void;
  calibrationNote?: string | null;
}

// the calibration line is the same multiplier that padded the fit, which is why it
// sits on this card and not only on Profile
export function RightNowCard({ options, selected, onSelect, pick, onStart, calibrationNote }: RightNowCardProps) {
  const reduceMotion = useReducedMotion();
  const entering = reduceMotion
    ? undefined
    : FadeIn.duration(motion.enter).easing(Easing.out(Easing.cubic));

  return (
    <Card padding="base" accessibilityLabel="How much time do you have right now">
      <Text
        className="text-subheading font-medium text-content dark:text-content-dark-primary"
        style={{ letterSpacing: typography.subheading.letterSpacing }}
        accessibilityRole="header"
      >
        Right now
      </Text>
      <Text
        className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
        style={{ marginTop: spacing.xs }}
      >
        How long do you actually have?
      </Text>

      <View style={{ marginTop: spacing.md }}>
        <SelectChipRow accessibilityLabel="How much time do you have right now">
          {options.map((minutes) => (
            <SelectChip
              key={minutes}
              label={formatDuration(minutes)}
              selected={selected === minutes}
              onPress={() => onSelect(minutes)}
              accessibilityLabel={`I have ${minutes} minutes`}
            />
          ))}
        </SelectChipRow>
      </View>

      {selected !== null ? (
        <Animated.View key={`${selected}:${pick?.title ?? "none"}`} entering={entering} style={{ marginTop: spacing.md }}>
          {pick !== null ? (
            <SubPanel label={`Fits in ${formatDuration(selected)}`}>
              <Text className="text-body font-sans text-content dark:text-content-dark-primary">{pick.title}</Text>
              <Text
                className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
                style={{ marginTop: spacing.xs, marginBottom: spacing.md }}
                numberOfLines={1}
              >
                {pick.taskTitle} · about {formatDuration(pick.fitMinutes)}
              </Text>
              <Button
                title="Start focus session"
                variant="primary"
                onPress={onStart}
                accessibilityLabel={`Start focus session for ${pick.title}`}
              />
            </SubPanel>
          ) : (
            <SubPanel label={`Fits in ${formatDuration(selected)}`}>
              <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
                Nothing is small enough for that. Try a longer stretch, or break a task into steps.
              </Text>
            </SubPanel>
          )}
        </Animated.View>
      ) : null}

      {calibrationNote ? (
        <Text
          className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
          style={{ marginTop: spacing.md }}
        >
          {calibrationNote}
        </Text>
      ) : null}
    </Card>
  );
}
