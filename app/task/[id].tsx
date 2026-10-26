import React, { useState, useCallback, useEffect, useMemo } from "react";
import { View, Text, ScrollView, Pressable, Switch, useWindowDimensions } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColorScheme } from "nativewind";
import { Ionicons } from "@expo/vector-icons";
import { useTaskStore } from "@/store/runtime";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SubjectPill } from "@/components/ui/SubjectPill";
import { Checkbox } from "@/components/ui/Checkbox";
import { Chip, type ChipDot } from "@/components/ui/Chip";
import { CircleButton } from "@/components/ui/CircleButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingSkeleton } from "@/components/ui/LoadingSkeleton";
import { PlayCircle } from "@/components/ui/PlayCircle";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { SelectChip, SelectChipRow } from "@/components/ui/SelectChip";
import { SettingsRow } from "@/components/ui/SettingsRow";
import { SheetFrame } from "@/components/ui/SheetFrame";
import { UndoToast } from "@/components/ui/UndoToast";
import { Uncoil } from "@/components/ui/Uncoil";
import { SubPanel } from "@/components/ui/SubPanel";
import { SubtaskRow } from "@/components/ui/SubtaskRow";
import { DateTimePickerCrossPlatform } from "@/components/ui/DateTimePickerCrossPlatform";
import { colors, spacing, borderRadius, typography, ICON_SIZE, TOUCH_TARGET_MIN } from "@/utils/design-tokens";
import { urgencyChip } from "@/utils/urgency";
import { formatDeadline, formatDuration } from "@/utils/format";
import { DURATION_PRESETS } from "@/utils/presets";
import { sortSubtasksForDisplay } from "@/utils/subtasks";
import type { TaskStatus } from "@/types";
import { AI_STEPS_NOTICE } from "@/utils/legalText";

const DURATION_COLUMNS = 4;
// past this Dynamic Type scale the bottom buttons stack so their labels don't truncate
const LARGE_TYPE_SCALE = 1.3;
const SKELETON_LINE = spacing.lg;
// same window as the completion toast's undo on Home
const BREAKDOWN_UNDO_MS = 5000;

function formatTimeFromDate(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// "Sun, Sep 7 · 11:59 PM"
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${day} · ${formatTimeFromDate(d)}`;
}

// every state has a label so the dot never carries the meaning alone
const STATUS_CHIP: Record<TaskStatus, { dot?: ChipDot; label: string }> = {
  not_started: { label: "Not started" },
  in_progress: { dot: "warning", label: "In progress" },
  complete: { dot: "success", label: "Done" },
};

function CardTitle({ children, style }: { children: string; style?: { marginTop?: number } }) {
  return (
    <Text
      className="text-subheading font-medium text-content dark:text-content-dark-primary"
      style={[{ letterSpacing: typography.subheading.letterSpacing }, style]}
      accessibilityRole="header"
    >
      {children}
    </Text>
  );
}

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const stackBottomActions = fontScale >= LARGE_TYPE_SCALE;
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const tasks = useTaskStore((s) => s.tasks);
  const task = useMemo(() => tasks.find((t) => t.id === id), [tasks, id]);
  const toggleSubtask = useTaskStore((s) => s.toggleSubtask);
  const updateTask = useTaskStore((s) => s.updateTask);
  const setTaskStatus = useTaskStore((s) => s.setTaskStatus);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const breakdown = useTaskStore((s) => s.breakdown);
  const simplifySubtask = useTaskStore((s) => s.simplifySubtask);
  const restoreSubtask = useTaskStore((s) => s.restoreSubtask);
  const canSchedule = useTaskStore((s) => s.canSchedule);
  const releaseSchedule = useTaskStore((s) => s.releaseSchedule);
  const undoBreakdown = useTaskStore((s) => s.undoBreakdown);
  const cancelBreakdown = useTaskStore((s) => s.cancelBreakdown);
  const cancelSimplification = useTaskStore((s) => s.cancelSimplification);
  // from the store, not local state, so it survives leaving the screen and clears
  // when the breakdown is cancelled from anywhere
  const breakdownInFlight = useTaskStore((s) => s.breakdownInFlight);
  const breakdownLoading = useMemo(() => breakdownInFlight.includes(id), [breakdownInFlight, id]);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showStarter, setShowStarter] = useState(true);
  const [makeEasierLoading, setMakeEasierLoading] = useState<string | null>(null);
  const [easierExplanation, setEasierExplanation] = useState<string | null>(null);
  const [undoVisible, setUndoVisible] = useState(false);
  const [breakdownFallback, setBreakdownFallback] = useState(false);
  const [editingDuration, setEditingDuration] = useState<number | null>(null);
  const [durationInitialized, setDurationInitialized] = useState(false);
  const [showDurationRow, setShowDurationRow] = useState(false);

  // seeded once from task.startTime, which is already loaded on first render
  const [hasStartTime, setHasStartTime] = useState(() => !!task?.startTime);
  const [startTimeDate, setStartTimeDate] = useState<Date>(() => {
    if (task?.startTime) return new Date(task.startTime);
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    return d;
  });
  const [showStartPanel, setShowStartPanel] = useState(false);

  const handleSaveStartTime = useCallback((enabled: boolean, time: Date) => {
    if (!task) return;
    let startTimeISO: string | null = null;
    if (enabled) {
      const st = new Date(task.dueDate);
      st.setHours(time.getHours(), time.getMinutes(), 0, 0);
      startTimeISO = st.toISOString();
    }
    // a start time set by hand pins the block so the scheduler never moves it.
    // clearing the time isn't setting one, so scheduleStatus is left alone
    updateTask(task.id, enabled ? { startTime: startTimeISO, scheduleStatus: "pinned" } : { startTime: startTimeISO });
  }, [task, updateTask]);

  // follows the task's own record so the notice is also right when reopening a template-tier task
  useEffect(() => {
    setBreakdownFallback(task?.breakdownSource === "template");
  }, [task?.breakdownSource]);

  // leaving cancels the breakdown and any Make easier still running, so the model
  // isn't stuck on work no one is waiting for
  useEffect(() => {
    return () => {
      cancelBreakdown(id);
      cancelSimplification();
    };
  }, [id, cancelBreakdown, cancelSimplification]);

  // stays above the !task return below, hooks can't run conditionally
  useEffect(() => {
    if (!undoVisible) return;
    const timer = setTimeout(() => setUndoVisible(false), BREAKDOWN_UNDO_MS);
    return () => clearTimeout(timer);
  }, [undoVisible]);

  // sortSubtasksForDisplay copies. task.subtasks is store state and must not be sorted in place
  const sortedSubtasks = useMemo(
    () => sortSubtasksForDisplay(task?.subtasks ?? []),
    [task?.subtasks],
  );

  // `tasks` is a deliberate dependency. another task's schedule can close the last gap for
  // this one, and the store keeps this task's reference stable when a different task changes
  const isUnschedulable = useMemo(() => {
    if (!task || task.status === "complete" || task.scheduleStatus !== "unscheduled") return false;
    return !canSchedule(task.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, tasks, canSchedule]);

  if (!task) {
    return (
      <Screen className="justify-center" style={{ paddingHorizontal: spacing.sm }}>
        <EmptyState
          title="Task not found"
          subtitle="This task may have been deleted."
          actionLabel="Go back"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const completedCount = task.subtasks.filter((s) => s.isComplete).length;
  const progress = task.subtasks.length > 0 ? completedCount / task.subtasks.length : 0;
  const allDone = task.subtasks.length > 0 && completedCount === task.subtasks.length;
  const isComplete = task.status === "complete";
  const urgency = isComplete ? null : urgencyChip(task.dueDate, new Date());
  const status = STATUS_CHIP[task.status];
  const currentDuration = durationInitialized ? editingDuration : task.durationMinutes;
  const stepsTotal = task.subtasks.reduce((sum, s) => sum + s.estimatedMinutes, 0);
  const hasNotes = Boolean(task.subject) || Boolean(task.description);
  const isPinned = task.scheduleStatus === "pinned";
  const scheduledTime = task.startTime;

  const setStartTimeEnabled = (enabled: boolean) => {
    setHasStartTime(enabled);
    if (!enabled) setShowStartPanel(false);
    handleSaveStartTime(enabled, startTimeDate);
  };

  // the way to reschedule without dragging on the calendar
  const handleChangeTime = () => {
    if (!hasStartTime) {
      setHasStartTime(true);
      handleSaveStartTime(true, startTimeDate);
    }
    setShowStartPanel(true);
  };

  // through the store, since proposeSchedule alone refuses to move a pinned block
  const handleReleaseSchedule = () => {
    releaseSchedule(task.id);
  };

  const handleStarterComplete = () => {
    setShowStarter(false);
    setTaskStatus(task.id, "in_progress");
  };

  const handleMakeEasier = async (subtaskId: string) => {
    setMakeEasierLoading(subtaskId);
    const result = await simplifySubtask(task.id, subtaskId);
    setMakeEasierLoading(null);
    if (result) {
      setEasierExplanation(result.simplification.explanation);
    }
  };

  // a new breakdown replaces the old steps and can easily be worse, so the toast
  // offers them back
  const handleBreakdown = async () => {
    const hadSteps = task.subtasks.length > 0;
    const applied = await breakdown(task.id);
    if (applied && hadSteps) setUndoVisible(true);
  };

  const handleUndoBreakdown = () => {
    undoBreakdown(task.id);
    setUndoVisible(false);
  };

  const handleDelete = () => {
    setShowDeleteModal(true);
  };

  const confirmDelete = () => {
    const taskId = task.id;
    setShowDeleteModal(false);
    deleteTask(taskId);
    // replace so back doesn't lead to the deleted task
    router.replace("/(tabs)");
  };

  const handleStartFocus = () => {
    router.push({ pathname: "/focus/session", params: { taskId: task.id } });
  };

  return (
    <Screen>
      <ScreenHeader
        left={<CircleButton icon="chevron-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
        right={
          <CircleButton
            icon="time-outline"
            onPress={handleChangeTime}
            accessibilityLabel="Change time"
            accessibilityHint="Opens the start time picker"
          />
        }
      />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: spacing.xl }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.xl }}>
          <Text
            className="text-display font-medium text-content dark:text-content-dark-primary"
            style={{ letterSpacing: typography.display.letterSpacing }}
            accessibilityRole="header"
            numberOfLines={3}
            ellipsizeMode="tail"
          >
            {task.title}
          </Text>

          <View className="flex-row items-center" style={{ marginTop: spacing.base }}>
            <View className="flex-1 flex-row flex-wrap items-center" style={{ gap: spacing.sm }}>
              {urgency ? <Chip label={urgency.label} dot={urgency.dot} tone={urgency.dot} /> : null}
              <Chip prefix="Deadline :" label={formatDeadline(task.dueDate)} tone={isComplete ? "neutral" : "warning"} />
              {task.durationMinutes ? <Chip label={formatDuration(task.durationMinutes)} /> : null}
            </View>
            {!isComplete && (
              <View style={{ marginLeft: spacing.sm }}>
                <PlayCircle onPress={handleStartFocus} accessibilityLabel={`Start focus session for ${task.title}`} />
              </View>
            )}
          </View>
        </View>

        <View style={{ paddingHorizontal: spacing.sm, paddingTop: spacing.lg, gap: spacing.sm }}>
          <Card padding="base">
            <View className="flex-row items-center">
              <View className="flex-1">
                <CardTitle>About this task</CardTitle>
              </View>
              <Chip label={status.label} dot={status.dot} accessibilityLabel={`Status: ${status.label}`} />
            </View>
            <SubjectPill subject={task.subject} style={{ marginTop: spacing.sm }} />
            {task.description ? (
              <Text
                className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
                style={{ marginTop: task.subject ? spacing.xs : spacing.sm }}
              >
                {task.description}
              </Text>
            ) : null}
            {!hasNotes && (
              <Text
                className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
                style={{ marginTop: spacing.sm }}
              >
                No notes for this task.
              </Text>
            )}

            {task.subtasks.length > 0 && (
              <View style={{ marginTop: spacing.base }}>
                <CardTitle>Progress</CardTitle>
                <View style={{ marginTop: spacing.md }}>
                  <ProgressBar
                    progress={progress}
                    track="elevated"
                    showPercent
                    label={`${completedCount} of ${task.subtasks.length} steps done`}
                  />
                </View>
              </View>
            )}

            {allDone && (
              <View
                className="flex-row items-center bg-success-light dark:bg-success-bright-light rounded-md"
                style={{ marginTop: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
              >
                <Ionicons name="checkmark-circle-outline" size={ICON_SIZE.row} className="text-success-dark dark:text-success-bright-dark" />
                <Text
                  className="flex-1 text-body font-sans text-success-dark dark:text-success-bright-dark"
                  style={{ marginLeft: spacing.sm }}
                >
                  Every step is done. Nice work.
                </Text>
              </View>
            )}

          </Card>

          <Card padding="base">
            <CardTitle>Schedule</CardTitle>
            <View style={{ marginTop: spacing.xs }}>
              <SettingsRow
                icon="calendar-outline"
                label="Due"
                value={formatDateTime(task.dueDate)}
                accessibilityLabel={`Due ${formatDateTime(task.dueDate)}`}
              />
              <SettingsRow
                icon="time-outline"
                label="Start"
                value={hasStartTime ? formatTimeFromDate(startTimeDate) : "Not set"}
                onPress={() => setShowStartPanel((p) => !p)}
                accessibilityLabel={hasStartTime ? `Start time ${formatTimeFromDate(startTimeDate)}` : "Start time, not set"}
                accessibilityHint="Opens the start time controls"
              />
              {showStartPanel && (
                <View style={{ marginBottom: spacing.sm }}>
                  <SubPanel label="Start time">
                    <Pressable
                      onPress={() => setStartTimeEnabled(!hasStartTime)}
                      className="flex-row items-center"
                      style={{ minHeight: TOUCH_TARGET_MIN }}
                      accessibilityRole="switch"
                      accessibilityState={{ checked: hasStartTime }}
                      accessibilityLabel="Add start time"
                      accessibilityHint="Places this task as a block on the calendar"
                    >
                      <Text className="flex-1 text-body font-sans text-content dark:text-content-dark-primary">
                        Add start time
                        <Text className="text-content-muted dark:text-content-dark-muted"> (optional)</Text>
                      </Text>
                      <Switch
                        value={hasStartTime}
                        onValueChange={setStartTimeEnabled}
                        trackColor={{ false: colors[scheme].elevated, true: colors[scheme].accent }}
                        accessibilityLabel="Add start time"
                        accessible={false}
                        importantForAccessibility="no"
                      />
                    </Pressable>
                    {hasStartTime && (
                      <DateTimePickerCrossPlatform
                        value={startTimeDate}
                        mode="time"
                        display="spinner"
                        onChange={(selected) => {
                          setStartTimeDate(selected);
                          handleSaveStartTime(true, selected);
                        }}
                        accessibilityLabel="Select start time"
                      />
                    )}
                  </SubPanel>
                </View>
              )}
              <SettingsRow
                icon="hourglass-outline"
                label="Duration"
                value={currentDuration ? formatDuration(currentDuration) : "Not set"}
                onPress={() => setShowDurationRow((p) => !p)}
                accessibilityLabel={currentDuration ? `Duration ${formatDuration(currentDuration)}` : "Duration, not set"}
                accessibilityHint="Opens the duration presets"
              />
              {showDurationRow && (
                <View style={{ marginBottom: spacing.sm }}>
                  <SubPanel label="How long?">
                    <SelectChipRow accessibilityLabel="How long" columns={DURATION_COLUMNS}>
                      {DURATION_PRESETS.map((preset) => {
                        const isSelected = currentDuration === preset.value;
                        return (
                          <SelectChip
                            key={preset.value}
                            label={preset.label}
                            selected={isSelected}
                            onPress={() => {
                              const newVal = isSelected ? null : preset.value;
                              setEditingDuration(newVal);
                              setDurationInitialized(true);
                              updateTask(task.id, { durationMinutes: newVal });
                            }}
                            accessibilityLabel={`Duration ${preset.label}`}
                          />
                        );
                      })}
                    </SelectChipRow>
                    <Text
                      className="text-small font-medium text-content-muted dark:text-content-dark-muted"
                      style={{ marginTop: spacing.sm }}
                    >
                      {task.subtasks.length > 0
                        ? `Total from steps: ${formatDuration(stepsTotal)}. Optional, helps with scheduling.`
                        : "Optional, helps with scheduling."}
                    </Text>
                  </SubPanel>
                </View>
              )}
            </View>

            {isUnschedulable && (
              <Text
                className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
                style={{ marginTop: spacing.sm }}
              >
                Uncoil could not find a free time for this before the due date. Shorten the task, move
                the due date, or free up some time in your schedule.
              </Text>
            )}

            {!isUnschedulable && isPinned && (
              <View style={{ marginTop: spacing.sm }}>
                <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
                  You set this time. Uncoil will not move it.
                </Text>
                <View style={{ marginTop: spacing.sm }}>
                  <Button
                    title="Release time"
                    variant="ghost"
                    onPress={handleReleaseSchedule}
                    accessibilityLabel="Release the pinned time"
                    accessibilityHint="Lets the app choose a new time for this task"
                  />
                </View>
              </View>
            )}

            {!isUnschedulable && !isPinned && scheduledTime && (
              <Text
                className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
                style={{ marginTop: spacing.sm }}
              >
                This task is scheduled for {formatDateTime(scheduledTime)}.
              </Text>
            )}
          </Card>

          <Card padding="base">
            <CardTitle>Task Details</CardTitle>

            {showStarter && task.status === "not_started" && !allDone && task.starterAction && (
              <View style={{ marginTop: spacing.md }} accessibilityLabel={`First step: ${task.starterAction}`}>
                <SubPanel label="First step">
                  <View className="flex-row items-start" style={{ marginBottom: spacing.base }}>
                    <View style={{ marginTop: spacing.xs / 2, marginRight: spacing.sm }}>
                      <Checkbox checked={false} decorative />
                    </View>
                    <Text className="flex-1 text-body font-sans text-content dark:text-content-dark-primary">
                      {task.starterAction}
                    </Text>
                  </View>
                  <View className="flex-row items-center" style={{ gap: spacing.md }}>
                    <Button
                      title="Done"
                      variant="primary"
                      onPress={handleStarterComplete}
                      className="flex-1"
                      accessibilityLabel="Mark first step as done"
                      accessibilityHint="Marks this task as in progress"
                    />
                    <Button title="Skip" variant="ghost" onPress={handleStarterComplete} accessibilityLabel="Skip first step" />
                  </View>
                </SubPanel>
              </View>
            )}

            <View style={{ marginTop: spacing.sm }}>
              {breakdownLoading ? (
                <View style={{ gap: spacing.md, paddingVertical: spacing.sm }}>
                  <View style={{ marginBottom: spacing.sm }}>
                    <Uncoil play="loop" />
                  </View>
                  <LoadingSkeleton width="100%" height={SKELETON_LINE} borderRadius={borderRadius.sm} />
                  <LoadingSkeleton width="90%" height={SKELETON_LINE} borderRadius={borderRadius.sm} />
                  <LoadingSkeleton width="95%" height={SKELETON_LINE} borderRadius={borderRadius.sm} />
                  <LoadingSkeleton width="80%" height={SKELETON_LINE} borderRadius={borderRadius.sm} />
                </View>
              ) : task.subtasks.length > 0 ? (
                <>
                  {sortedSubtasks.map((subtask) => (
                    <React.Fragment key={subtask.id}>
                      {makeEasierLoading === subtask.id ? (
                        <View style={{ paddingVertical: spacing.sm }}>
                          <LoadingSkeleton width="100%" height={SKELETON_LINE} borderRadius={borderRadius.sm} />
                        </View>
                      ) : (
                        <SubtaskRow
                          title={subtask.title}
                          durationMinutes={subtask.estimatedMinutes}
                          completed={subtask.isComplete}
                          onToggle={() => toggleSubtask(task.id, subtask.id)}
                          onMakeEasier={() => handleMakeEasier(subtask.id)}
                          originalTitle={subtask.originalTitle}
                          onRestore={() => restoreSubtask(task.id, subtask.id)}
                        />
                      )}
                    </React.Fragment>
                  ))}

                  {breakdownFallback && (
                    <View
                      className="flex-row items-center bg-surface-card dark:bg-surface-dark-card rounded-md"
                      style={{ marginTop: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
                    >
                      <Ionicons name="leaf-outline" size={ICON_SIZE.chip} className="text-content-secondary dark:text-content-dark-secondary" />
                      <Text
                        className="flex-1 text-small font-medium text-content-secondary dark:text-content-dark-secondary"
                        style={{ marginLeft: spacing.sm - 2 }}
                      >
                        Showing general steps for now.
                      </Text>
                    </View>
                  )}

                  {!breakdownFallback && task.breakdownSource === "model" && (
                    <View
                      className="flex-row items-center bg-surface-card dark:bg-surface-dark-card rounded-md"
                      style={{ marginTop: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
                    >
                      <Ionicons name="sparkles-outline" size={ICON_SIZE.chip} className="text-content-secondary dark:text-content-dark-secondary" />
                      <Text
                        className="flex-1 text-small font-medium text-content-secondary dark:text-content-dark-secondary"
                        style={{ marginLeft: spacing.sm - 2 }}
                        accessibilityRole="text"
                      >
                        {AI_STEPS_NOTICE}
                      </Text>
                    </View>
                  )}
                </>
              ) : (
                <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary" style={{ marginTop: spacing.xs }}>
                  {isComplete
                    ? "This task is done."
                    : "Break it down to get a few small steps, so you know exactly where to start."}
                </Text>
              )}
            </View>

            {!isComplete && (
              <View style={{ marginTop: spacing.base }}>
                <Button
                  title={breakdownLoading ? "Breaking it down" : task.subtasks.length > 0 ? "Break it down again" : "Break it down"}
                  variant={task.subtasks.length > 0 ? "ghost" : "secondary"}
                  onPress={handleBreakdown}
                  loading={breakdownLoading}
                  icon={
                    <Ionicons name="sparkles-outline" size={ICON_SIZE.inline} className="text-content dark:text-content-dark-primary" />
                  }
                  accessibilityLabel={breakdownLoading ? "Breaking it down" : "Break this task down into small steps"}
                  accessibilityHint="Uncoil generates a few small steps for this task"
                />
              </View>
            )}
          </Card>
        </View>

        <Pressable
          onPress={handleDelete}
          className="flex-row items-center justify-center self-center rounded-full active:bg-surface-elevated dark:active:bg-surface-dark-elevated"
          style={{ minHeight: TOUCH_TARGET_MIN, paddingHorizontal: spacing.base, marginTop: spacing.sm }}
          accessibilityRole="button"
          accessibilityLabel="Delete task"
          accessibilityHint="Opens a confirmation"
        >
          <Ionicons name="trash-outline" size={ICON_SIZE.inline} className="text-danger-dark dark:text-danger-bright" />
          <Text className="text-body font-sans text-danger-dark dark:text-danger-bright" style={{ marginLeft: spacing.sm - 2 }}>
            Delete task
          </Text>
        </Pressable>
      </ScrollView>

      <View
        style={{
          flexDirection: stackBottomActions ? "column" : "row",
          alignItems: stackBottomActions ? "stretch" : "center",
          paddingHorizontal: spacing.base,
          paddingTop: spacing.sm,
          paddingBottom: insets.bottom + spacing.base,
          gap: spacing.md,
        }}
      >
        {isComplete ? (
          <Button
            title="Reopen task"
            variant="secondary"
            onPress={() => setTaskStatus(task.id, "not_started")}
            className={stackBottomActions ? undefined : "flex-1"}
            icon={<Ionicons name="refresh-outline" size={ICON_SIZE.inline} className="text-content dark:text-content-dark-primary" />}
            accessibilityLabel="Reopen task"
          />
        ) : (
          <>
            <Button
              title="Mark complete"
              variant="secondary"
              onPress={() => setTaskStatus(task.id, "complete")}
              style={stackBottomActions ? undefined : { flex: 1 }}
              accessibilityLabel="Mark task as complete"
            />
            {!allDone && (
              <Button
                title="Start focus session"
                variant="primary"
                onPress={handleStartFocus}
                style={stackBottomActions ? undefined : { flex: 1.4 }}
                icon={<Ionicons name="play" size={ICON_SIZE.inline} color={colors[scheme].primaryForeground} />}
                accessibilityLabel="Start a focus session for this task"
              />
            )}
          </>
        )}
      </View>

      <SheetFrame
        visible={showDeleteModal}
        title="Delete task"
        onClose={() => setShowDeleteModal(false)}
        closeLabel="Close delete confirmation"
        scroll={false}
        footer={
          <>
            <Button
              title="Delete"
              variant="danger"
              onPress={confirmDelete}
              accessibilityLabel="Confirm delete task"
            />
            <Button
              title="Cancel"
              variant="ghost"
              onPress={() => setShowDeleteModal(false)}
              accessibilityLabel="Cancel delete"
            />
          </>
        }
      >
        <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
          This removes the task and its steps. It cannot be undone.
        </Text>
      </SheetFrame>

      <SheetFrame
        visible={easierExplanation !== null}
        title="What this means"
        onClose={() => setEasierExplanation(null)}
        closeLabel="Close explanation"
        footer={
          <Button
            title="Got it"
            variant="primary"
            onPress={() => setEasierExplanation(null)}
            accessibilityLabel="Close explanation"
          />
        }
      >
        <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
          {easierExplanation}
        </Text>
      </SheetFrame>

      <UndoToast
        visible={undoVisible}
        message="New steps. The old ones are still here if you want them."
        onUndo={handleUndoBreakdown}
      />
    </Screen>
  );
}
