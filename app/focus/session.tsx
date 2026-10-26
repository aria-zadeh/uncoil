import React, { useState, useEffect, useRef, useMemo } from "react";
import { View, Text, Pressable, ScrollView, useWindowDimensions } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTaskStore, useSessionStore, useSettingsStore } from "@/store/runtime";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { CircleButton } from "@/components/ui/CircleButton";
import { TimerDisplay } from "@/components/ui/TimerDisplay";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SubPanel } from "@/components/ui/SubPanel";
import { SheetFrame } from "@/components/ui/SheetFrame";
import { SubtaskRow, RESTORE_LABEL } from "@/components/ui/SubtaskRow";
import { LoadingSkeleton } from "@/components/ui/LoadingSkeleton";
import { BreakModal } from "@/components/BreakModal";
import type { Glyph } from "@/components/ui/icons";
import {
  spacing,
  typography,
  borderRadius,
  HAIRLINE,
  ICON_SIZE,
  CHIP_HEIGHT,
  TOUCH_TARGET_MIN,
} from "@/utils/design-tokens";
import { sortSubtasksForDisplay } from "@/utils/subtasks";

function ActionPill({
  icon,
  label,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  wrap = false,
}: {
  icon: Glyph;
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  disabled?: boolean;
  // large Dynamic Type: wrap to a second line instead of truncating, and height becomes a floor
  wrap?: boolean;
}) {
  const slop = (TOUCH_TARGET_MIN - CHIP_HEIGHT.select) / 2;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: slop, bottom: slop }}
      className={`flex-1 flex-row items-center justify-center rounded-full bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark active:bg-surface-elevated dark:active:bg-surface-dark-elevated ${disabled ? "opacity-50" : ""}`}
      style={{
        [wrap ? "minHeight" : "height"]: CHIP_HEIGHT.select,
        paddingHorizontal: spacing.md,
        paddingVertical: wrap ? spacing.xs : 0,
        borderWidth: HAIRLINE,
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
    >
      <Ionicons
        name={icon}
        size={ICON_SIZE.chip}
        className="text-content-secondary dark:text-content-dark-secondary"
        style={{ marginRight: spacing.xs + 2 }}
      />
      <Text
        className="text-bodyMedium font-medium text-content-secondary dark:text-content-dark-secondary"
        style={wrap ? { textAlign: "center", flexShrink: 1 } : undefined}
        numberOfLines={wrap ? 2 : 1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function FocusSessionScreen() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const insets = useSafeAreaInsets();

  const tasks = useTaskStore((s) => s.tasks);
  const task = useMemo(() => tasks.find((t) => t.id === taskId), [tasks, taskId]);
  // sortSubtasksForDisplay returns a copy, so the store's array is never sorted in place
  const subtasks = useMemo(
    () => sortSubtasksForDisplay(task?.subtasks ?? []),
    [task?.subtasks],
  );
  const toggleSubtask = useTaskStore((s) => s.toggleSubtask);
  const simplifySubtask = useTaskStore((s) => s.simplifySubtask);
  const restoreSubtask = useTaskStore((s) => s.restoreSubtask);
  const startSession = useSessionStore((s) => s.startSession);
  const endSession = useSessionStore((s) => s.endSession);
  const markSubtaskCompleted = useSessionStore((s) => s.markSubtaskCompleted);
  const breakMinutes = useSettingsStore((s) => s.breakMinutes);

  const { fontScale } = useWindowDimensions();
  // same threshold as the bottom bar on task detail
  const stackPills = fontScale >= 1.3;

  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(true);
  const [showBreak, setShowBreak] = useState(false);
  const [stuckLoading, setStuckLoading] = useState(false);
  const [stuckExplanation, setStuckExplanation] = useState<string | null>(null);
  const sessionStarted = useRef(false);

  useEffect(() => {
    if (!sessionStarted.current && taskId) {
      const nextSubtask = task?.subtasks.find((s) => !s.isComplete);
      startSession(taskId, nextSubtask?.id || null);
      sessionStarted.current = true;
    }
    return () => {
      if (sessionStarted.current) {
        endSession("interrupted");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      setSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [running]);

  if (!task) {
    return (
      <Screen
        className="justify-center items-center"
        style={{ paddingHorizontal: spacing.base, gap: spacing.md }}
      >
        <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">Task not found</Text>
        <Button title="Go back" variant="ghost" onPress={() => router.back()} accessibilityLabel="Go back" />
      </Screen>
    );
  }

  const currentSubtask = subtasks.find((s) => !s.isComplete);
  const currentIndex = currentSubtask ? subtasks.indexOf(currentSubtask) : -1;
  const completedCount = subtasks.filter((s) => s.isComplete).length;
  const allDone = subtasks.length > 0 && completedCount === subtasks.length;
  const comingUp = subtasks.filter((s) => !s.isComplete && s.id !== currentSubtask?.id);
  const focusedMinutes = Math.round(seconds / 60);

  const handleToggleSubtask = (subtaskId: string) => {
    toggleSubtask(task.id, subtaskId);
    markSubtaskCompleted(subtaskId);
  };

  // same as "Make easier" on task detail. a null result (failure or cancel) stays silent
  const handleStuck = async () => {
    if (!currentSubtask) return;
    setStuckLoading(true);
    const result = await simplifySubtask(task.id, currentSubtask.id);
    setStuckLoading(false);
    if (result) {
      setStuckExplanation(result.simplification.explanation);
    }
  };

  const handleEndSession = () => {
    endSession(allDone ? "completed" : "abandoned");
    router.back();
  };

  return (
    <Screen>
      <ScreenHeader
        left={<CircleButton icon="close-outline" onPress={handleEndSession} accessibilityLabel="End focus session" />}
        right={
          <CircleButton
            icon={running ? "pause-outline" : "play-outline"}
            onPress={() => setRunning((r) => !r)}
            accessibilityLabel={running ? "Pause timer" : "Resume timer"}
          />
        }
      />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: spacing.sm,
          paddingBottom: insets.bottom + spacing.base,
          gap: spacing.sm,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* capped at two lines once the pills stack, so the title can't grow without bound */}
        <Text
          className="text-display font-medium text-content dark:text-content-dark-primary"
          style={{
            letterSpacing: typography.display.letterSpacing,
            paddingHorizontal: spacing.sm,
            marginTop: spacing.xl,
            marginBottom: spacing.sm,
          }}
          accessibilityRole="header"
          numberOfLines={stackPills ? 2 : undefined}
        >
          {task.title}
        </Text>

        <Card
          padding="base"
          footer={
            !allDone && currentSubtask ? (
              <SubPanel label="Current step">
                {stuckLoading ? (
                  <LoadingSkeleton
                    width="100%"
                    height={typography.heading.lineHeight}
                    borderRadius={borderRadius.sm}
                  />
                ) : (
                  <Text
                    className="text-heading font-medium text-content dark:text-content-dark-primary"
                    style={{ letterSpacing: typography.heading.letterSpacing }}
                  >
                    {currentSubtask.title}
                  </Text>
                )}

                <View className="flex-row items-center justify-between" style={{ marginTop: spacing.xs }}>
                  <Text className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary">
                    {currentSubtask.estimatedMinutes}m · step {currentIndex + 1} of {subtasks.length}
                  </Text>

                  {currentSubtask.originalTitle !== undefined && (
                    <Pressable
                      onPress={() => restoreSubtask(task.id, currentSubtask.id)}
                      className="flex-row items-center"
                      style={{ minHeight: TOUCH_TARGET_MIN, paddingHorizontal: spacing.sm, marginRight: -spacing.sm }}
                      accessibilityRole="button"
                      accessibilityLabel={RESTORE_LABEL}
                      hitSlop={spacing.sm}
                    >
                      <Ionicons
                        name="arrow-undo-outline"
                        size={ICON_SIZE.chip}
                        className="text-content-secondary dark:text-content-dark-secondary"
                      />
                      <Text
                        className="text-small font-medium text-content-secondary dark:text-content-dark-secondary"
                        style={{ marginLeft: spacing.xs }}
                      >
                        {RESTORE_LABEL}
                      </Text>
                    </Pressable>
                  )}
                </View>

                <View style={{ marginTop: spacing.md }}>
                  <Button
                    title="Done with this step"
                    variant="primary"
                    onPress={() => handleToggleSubtask(currentSubtask.id)}
                    accessibilityLabel="Mark step as done"
                  />
                </View>
              </SubPanel>
            ) : undefined
          }
        >
          <TimerDisplay seconds={seconds} running={running} label="Time focused" />

          {allDone && (
            <View style={{ marginTop: spacing.base, gap: spacing.md }}>
              <Text
                className="text-subheading font-medium text-content dark:text-content-dark-primary"
                style={{ letterSpacing: typography.subheading.letterSpacing }}
              >
                Every step is done
              </Text>
              <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
                {`Focused ${focusedMinutes} ${focusedMinutes === 1 ? "minute" : "minutes"}, ${completedCount} ${completedCount === 1 ? "step" : "steps"} done.`}
              </Text>
              <Button title="Done" variant="primary" onPress={handleEndSession} accessibilityLabel="Finish session" />
            </View>
          )}

          {!allDone && !currentSubtask && (
            <Text
              className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
              style={{ marginTop: spacing.md }}
            >
              No steps on this task yet. Work on it as one piece.
            </Text>
          )}
        </Card>

        {!allDone && comingUp.length > 0 && (
          <Card padding="base">
            <Text
              className="text-subheading font-medium text-content dark:text-content-dark-primary"
              style={{ letterSpacing: typography.subheading.letterSpacing, marginBottom: spacing.xs }}
              accessibilityRole="header"
            >
              Coming up
            </Text>
            {comingUp.map((s) => (
              <SubtaskRow
                key={s.id}
                title={s.title}
                durationMinutes={s.estimatedMinutes}
                completed={false}
                onToggle={() => handleToggleSubtask(s.id)}
                originalTitle={s.originalTitle}
                onRestore={() => restoreSubtask(task.id, s.id)}
              />
            ))}
          </Card>
        )}

        {/* in the scroll content, not a fixed footer, so stacked pills stay reachable at large text sizes */}
        {!allDone && (
          <View
            style={{
              flexDirection: stackPills ? "column" : "row",
              paddingHorizontal: spacing.base - spacing.sm,
              paddingTop: spacing.sm,
              gap: spacing.sm,
            }}
          >
            <ActionPill
              icon="help-circle-outline"
              label="I'm stuck"
              onPress={handleStuck}
              disabled={!currentSubtask || stuckLoading}
              accessibilityLabel="I'm stuck"
              accessibilityHint="Rewrites the current step as something smaller"
              wrap={stackPills}
            />
            <ActionPill
              icon="cafe-outline"
              label="Take a break"
              onPress={() => setShowBreak(true)}
              accessibilityLabel="Take a break"
              wrap={stackPills}
            />
            <ActionPill
              icon="leaf-outline"
              label="Overwhelmed"
              onPress={() => setShowBreak(true)}
              accessibilityLabel="I feel overwhelmed"
              accessibilityHint="Starts a short break"
              wrap={stackPills}
            />
          </View>
        )}
      </ScrollView>

      <BreakModal visible={showBreak} onClose={() => setShowBreak(false)} defaultMinutes={breakMinutes} />

      {/* keep in sync with the "Make easier" sheet on task detail */}
      <SheetFrame
        visible={stuckExplanation !== null}
        title="What this means"
        onClose={() => setStuckExplanation(null)}
        closeLabel="Close explanation"
        footer={
          <Button
            title="Got it"
            variant="primary"
            onPress={() => setStuckExplanation(null)}
            accessibilityLabel="Close explanation"
          />
        }
      >
        <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
          {stuckExplanation}
        </Text>
      </SheetFrame>
    </Screen>
  );
}
