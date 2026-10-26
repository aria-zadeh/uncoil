import React from "react";
import { View, Text } from "react-native";
import Animated, { FadeIn, FadeOut, Easing, useReducedMotion } from "react-native-reanimated";
import type { Subtask } from "@/types";
import { motion, press, spacing, typography, CARD_CHECK_SIZE } from "@/utils/design-tokens";
import { urgencyChip } from "@/utils/urgency";
import { formatDeadline, formatDuration } from "@/utils/format";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { Checkbox } from "./Checkbox";
import { ChecklistRow } from "./ChecklistRow";
import { PlayCircle } from "./PlayCircle";
import { ProgressBar } from "./ProgressBar";
import { SubjectPill } from "./SubjectPill";
import { SubPanel } from "./SubPanel";
import { Button } from "./Button";

const ENTER_RISE = press.rise;
const NEXT_STEPS = 3;

type TaskCardVariant = "hero" | "list" | "done" | "default" | "compact";

interface TaskCardProps {
  title: string;
  dueDate: string;
  subtaskCount: number;
  completedSubtasks: number;
  subject?: string | null;
  description?: string | null;
  /** @deprecated use description */
  notes?: string | null;
  durationMinutes?: number | null;
  // scheduler found no slot before the due date
  isUnschedulable?: boolean;
  isComplete?: boolean;
  onPress: () => void;
  onStartFocus?: () => void;
  nextSubtasks?: readonly Subtask[];
  onToggleSubtask?: (id: string) => void;
  // 0 to 1
  progress?: number;
  // hero only
  starterAction?: string | null;
  // hero only, shown when there are no subtasks
  onBreakDown?: () => void;
  // default and compact are deprecated aliases of list
  variant?: TaskCardVariant;
  onToggleComplete?: () => void;
  /** @deprecated */
  onReschedule?: () => void;
  /** @deprecated extra content under the panel */
  children?: React.ReactNode;
  // position in the list, for the staggered entrance. omit for a lone card
  index?: number;
}

function descriptionLine(description: string | null | undefined): string {
  return description ? description.split("\n")[0].trim() : "";
}

// fallback so the card never has an empty line under the title
function stepsLine(subtaskCount: number, completedSubtasks: number): string {
  if (subtaskCount === 0) return "No steps yet";
  const steps = subtaskCount === 1 ? "1 step" : `${subtaskCount} steps`;
  return completedSubtasks > 0 ? `${steps} · ${completedSubtasks} done` : steps;
}

export function TaskCard({
  title,
  dueDate,
  subtaskCount,
  completedSubtasks,
  subject,
  description,
  notes,
  durationMinutes,
  isUnschedulable = false,
  isComplete = false,
  onPress,
  onStartFocus,
  nextSubtasks,
  onToggleSubtask,
  progress,
  starterAction,
  onBreakDown,
  variant = "list",
  onToggleComplete,
  onReschedule,
  children,
  index,
}: TaskCardProps) {
  const reduceMotion = useReducedMotion();
  const now = new Date();
  const isHero = variant === "hero";
  const isDone = variant === "done" || isComplete;
  const ratio = progress ?? (subtaskCount > 0 ? completedSubtasks / subtaskCount : 0);
  const urgency = isDone ? null : urgencyChip(dueDate, now);
  const hasSubject = Boolean(subject?.trim());
  const line = descriptionLine(description ?? notes) || (isDone || hasSubject ? "" : stepsLine(subtaskCount, completedSubtasks));
  const steps = (nextSubtasks ?? []).filter((s) => !s.isComplete).slice(0, NEXT_STEPS);
  const hasProgress = subtaskCount > 0 && completedSubtasks > 0;

  const staggerDelay = Math.min(Math.max(index ?? 0, 0), motion.staggerMax) * motion.stagger;
  const entering = reduceMotion
    ? undefined
    : FadeIn.duration(motion.enter)
        .delay(staggerDelay)
        .easing(Easing.out(Easing.cubic))
        .withInitialValues({ opacity: 0, transform: [{ translateY: ENTER_RISE }] });
  const exiting = reduceMotion ? undefined : FadeOut.duration(motion.exit).easing(Easing.in(Easing.cubic));

  let footer: React.ReactNode = null;
  if (isHero) {
    footer = (
      <SubPanel label="Start here" tone="accent">
        {starterAction ? (
          <Text className="text-body font-sans text-content dark:text-content-dark-primary" style={{ marginBottom: spacing.md }}>
            {starterAction}
          </Text>
        ) : null}
        {onStartFocus ? (
          <Button title="Start focus session" variant="primary" onPress={onStartFocus} accessibilityLabel={`Start focus session for ${title}`} />
        ) : null}
        {onBreakDown && subtaskCount === 0 ? (
          <View style={{ marginTop: spacing.sm }}>
            <Button title="Break it down" variant="ghost" onPress={onBreakDown} accessibilityLabel={`Break ${title} into steps`} />
          </View>
        ) : null}
        {children}
      </SubPanel>
    );
  } else if (!isDone && (hasProgress || steps.length > 0)) {
    footer = (
      <SubPanel label={hasProgress ? "Progress" : "Task Details"}>
        {hasProgress ? <ProgressBar progress={ratio} track="card" showPercent /> : null}
        {steps.length > 0 ? (
          <View style={hasProgress ? { marginTop: spacing.sm } : undefined}>
            {steps.map((step) => (
              <ChecklistRow
                key={step.id}
                title={step.title}
                checked={step.isComplete}
                onToggle={onToggleSubtask ? () => onToggleSubtask(step.id) : undefined}
              />
            ))}
          </View>
        ) : null}
        {children}
      </SubPanel>
    );
  } else if (!isDone && children) {
    footer = <View>{children}</View>;
  }

  return (
    <Animated.View entering={entering} exiting={exiting}>
      <Card
        onPress={onPress}
        padding="base"
        footer={footer}
        className={isDone ? "opacity-60" : ""}
        accessibilityLabel={`Task: ${title}. Due ${formatDeadline(dueDate)}. ${completedSubtasks} of ${subtaskCount} subtasks done.${isDone ? " Completed." : ""}`}
        accessibilityHint="Opens task details"
      >
        <View className="flex-row items-start">
          <View className="flex-1">
            <Text
              className={`text-heading font-medium ${
                isDone ? "line-through text-content-muted dark:text-content-dark-muted" : "text-content dark:text-content-dark-primary"
              }`}
              style={{ letterSpacing: typography.heading.letterSpacing }}
              numberOfLines={2}
              ellipsizeMode="tail"
            >
              {title}
            </Text>
            <SubjectPill subject={subject} style={{ marginTop: spacing.xs }} />
            {line ? (
              <Text
                className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
                style={{ marginTop: spacing.xs }}
                numberOfLines={2}
              >
                {line}
              </Text>
            ) : null}
          </View>
          {onToggleComplete ? (
            <View style={{ marginLeft: spacing.md }}>
              <Checkbox
                checked={isComplete}
                shape="round"
                size={CARD_CHECK_SIZE}
                onToggle={onToggleComplete}
                accessibilityLabel={isComplete ? "Mark task as incomplete" : "Mark task as complete"}
              />
            </View>
          ) : null}
        </View>

        <View className="flex-row items-center" style={{ marginTop: spacing.md }}>
          <View className="flex-1 flex-row flex-wrap items-center" style={{ gap: spacing.sm }}>
            {urgency ? <Chip label={urgency.label} dot={urgency.dot} tone={urgency.dot} /> : null}
            <Chip prefix="Deadline :" label={formatDeadline(dueDate)} tone={isDone ? "neutral" : "warning"} />
            {durationMinutes ? <Chip label={formatDuration(durationMinutes)} /> : null}
            {!isDone && isUnschedulable ? (
              <Chip
                label="Could not schedule"
                dot="warning"
                accessibilityLabel="Uncoil could not find a time for this task"
              />
            ) : null}
            {onReschedule ? <Chip label="Reschedule" tone="selected" onPress={onReschedule} accessibilityLabel="Reschedule task" /> : null}
          </View>
          {onStartFocus && !isDone && !isHero ? (
            <View style={{ marginLeft: spacing.sm }}>
              <PlayCircle onPress={onStartFocus} accessibilityLabel={`Start focus session for ${title}`} />
            </View>
          ) : null}
        </View>
      </Card>
    </Animated.View>
  );
}
