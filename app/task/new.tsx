import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { View, Text, ScrollView, Pressable, Switch, KeyboardAvoidingView, Platform } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColorScheme } from "nativewind";
import { Ionicons } from "@expo/vector-icons";
import { useTaskStore } from "@/store/runtime";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { ChecklistRow } from "@/components/ui/ChecklistRow";
import { CircleButton } from "@/components/ui/CircleButton";
import { DateField } from "@/components/ui/DateField";
import { Dropzone } from "@/components/ui/Dropzone";
import { Input } from "@/components/ui/Input";
import { LoadingSkeleton } from "@/components/ui/LoadingSkeleton";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { SelectChip, SelectChipRow } from "@/components/ui/SelectChip";
import { SheetFrame } from "@/components/ui/SheetFrame";
import { SubPanel } from "@/components/ui/SubPanel";
import { DateTimePickerCrossPlatform } from "@/components/ui/DateTimePickerCrossPlatform";
import {
  colors,
  spacing,
  borderRadius,
  typography,
  HAIRLINE,
  ICON_SIZE,
  TOUCH_TARGET_MIN,
} from "@/utils/design-tokens";
import { DURATION_PRESETS } from "@/utils/presets";
import { subjectSuggestions } from "@/utils/subjects";
import { previewInputOf, previewMatches, type PreviewInput } from "@/utils/breakdownPreview";
import { AI_EXTRACTION_NOTICE, AI_STEPS_NOTICE } from "@/utils/legalText";
import { TASK_TITLE_MAX_LENGTH, type ExtractedTask, type GenerationTier } from "@/types";

const ABSTRACT_KEYWORDS = ["essay", "research", "analyze", "write", "project", "presentation", "report"];

const PASTE_MIN_HEIGHT = spacing["5xl"] * 2 + spacing["2xl"];
// long enough for a syllabus page, bounded so one paste can't queue unbounded model calls
const EXTRACT_INPUT_MAX_LENGTH = 8000;
const SKELETON_LINE = spacing.lg;

function detectAbstract(title: string): boolean {
  const lower = title.toLowerCase();
  return ABSTRACT_KEYWORDS.some((kw) => lower.includes(kw));
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatDueDate(date: Date): string {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (sameDay(date, now)) return "Today";
  if (sameDay(date, tomorrow)) return "Tomorrow";

  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// extraction returns a day offset, never a date. end of day matches the due default
function dueDateFromDueInDays(dueInDays: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + dueInDays);
  d.setHours(23, 59, 0, 0);
  return d;
}

function formatExtractedDate(dueInDays: number): string {
  return formatDueDate(dueDateFromDueInDays(dueInDays));
}

type DatePanel = "none" | "start" | "due";
type DueMode = "date" | "time";

function CardTitle({ children }: { children: string }) {
  return (
    <Text
      className="text-subheading font-medium text-content dark:text-content-dark-primary"
      style={{ letterSpacing: typography.subheading.letterSpacing }}
      accessibilityRole="header"
    >
      {children}
    </Text>
  );
}

// seven presets plus Custom fill two equal rows
const DURATION_COLUMNS = 4;
// same label gap as Input and DateField
const LABEL_GAP = spacing.xs + 2;

function FieldLabel({ children }: { children: string }) {
  return (
    <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary" style={{ marginBottom: LABEL_GAP }}>
      {children}
    </Text>
  );
}

// after a reload or deep link there may be nothing to pop, and back() would leave the screen stuck
function goBackToHome(): void {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace("/(tabs)");
  }
}

export default function NewTaskScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const addTask = useTaskStore((s) => s.addTask);
  const previewBreakdown = useTaskStore((s) => s.previewBreakdown);
  const extractTasks = useTaskStore((s) => s.extractTasks);
  const cancelPreview = useTaskStore((s) => s.cancelPreview);
  const cancelExtraction = useTaskStore((s) => s.cancelExtraction);
  const applyBreakdownPreview = useTaskStore((s) => s.applyBreakdownPreview);
  const tasks = useTaskStore((s) => s.tasks);
  const params = useLocalSearchParams<{ prefillStart?: string }>();

  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState(() => {
    if (params.prefillStart) {
      const parsed = new Date(params.prefillStart);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(23, 59, 0, 0);
    return tomorrow;
  });

  const [datePanel, setDatePanel] = useState<DatePanel>("none");
  const [dueMode, setDueMode] = useState<DueMode>("date");

  const [hasStartTime, setHasStartTime] = useState(false);
  const [startTimeDate, setStartTimeDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    return d;
  });

  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  const [durationOverridden, setDurationOverridden] = useState(false);

  const [showBreakdown, setShowBreakdown] = useState(false);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [aiResult, setAiResult] = useState<{
    starterAction: string;
    subtasks: { title: string; estimatedMinutes: number }[];
    tier: GenerationTier;
    // the form as it was when this preview was requested
    input: PreviewInput;
  } | null>(null);
  const previewInFlightRef = useRef(false);

  const [showExtractModal, setShowExtractModal] = useState(false);
  const [extractInput, setExtractInput] = useState("");
  const [extractLoading, setExtractLoading] = useState(false);
  const [extractResults, setExtractResults] = useState<ExtractedTask[] | null>(null);
  const [extractFallback, setExtractFallback] = useState(false);
  const [extractError, setExtractError] = useState(false);
  const [checkedItems, setCheckedItems] = useState<Set<number>>(new Set());
  // bumped on every extraction and close so a late result is dropped
  const extractRequestRef = useRef(0);

  // cancel running work on leave so the model isn't busy for nobody
  useEffect(() => {
    return () => {
      cancelPreview();
      cancelExtraction();
    };
  }, [cancelPreview, cancelExtraction]);

  const isAbstract = detectAbstract(title);
  const canSave = title.trim().length > 0;
  const subjectChips = useMemo(() => subjectSuggestions(tasks, subject), [tasks, subject]);
  // once the fields a preview came from change, it is neither shown nor saved
  const preview = useMemo(
    () => (aiResult && previewMatches(aiResult.input, previewInputOf(title, subject, description)) ? aiResult : null),
    [aiResult, title, subject, description],
  );

  const handleBreakdown = useCallback(async () => {
    if (previewInFlightRef.current) return;
    previewInFlightRef.current = true;
    const input = previewInputOf(title, subject, description);
    setShowBreakdown(true);
    setBreakdownLoading(true);
    try {
      const result = await previewBreakdown({
        title: input.title,
        subject: input.subject || null,
        description: input.description || null,
        dueDate: dueDate.toISOString(),
        sessionMinutes: durationMinutes ?? 30,
      });
      if (!result) return;
      setAiResult({
        starterAction: result.breakdown.starterAction,
        subtasks: result.breakdown.steps.map((step) => ({
          title: step.title,
          estimatedMinutes: step.minutes,
        })),
        tier: result.tier,
        input,
      });
    } finally {
      previewInFlightRef.current = false;
      setBreakdownLoading(false);
    }
  }, [title, subject, description, dueDate, durationMinutes, previewBreakdown]);

  const handleSave = useCallback(() => {
    if (!title.trim()) return;

    let startTimeISO: string | null = null;
    if (hasStartTime) {
      const st = new Date(dueDate);
      st.setHours(startTimeDate.getHours(), startTimeDate.getMinutes(), 0, 0);
      startTimeISO = st.toISOString();
    }

    const taskId = addTask({
      title: title.trim(),
      subject: subject.trim() || null,
      description: description.trim() || null,
      dueDate: dueDate.toISOString(),
      startTime: startTimeISO,
      durationMinutes,
    });

    if (showBreakdown && !breakdownLoading && preview) {
      applyBreakdownPreview(taskId, {
        starterAction: preview.starterAction,
        steps: preview.subtasks,
        source: preview.tier,
      });
    }

    goBackToHome();
  }, [title, subject, description, dueDate, hasStartTime, startTimeDate, durationMinutes, showBreakdown, breakdownLoading, preview, addTask, applyBreakdownPreview]);

  const handleExtract = useCallback(async () => {
    if (!extractInput.trim()) return;
    extractRequestRef.current += 1;
    const requestId = extractRequestRef.current;
    setExtractLoading(true);
    setExtractResults(null);
    setExtractFallback(false);
    setExtractError(false);
    const result = await extractTasks(extractInput);
    // closed or superseded while the model worked
    if (requestId !== extractRequestRef.current) return;
    setExtractLoading(false);
    if (!result) {
      // null only on cancel, which stays silent. real failures come back as a template result
      return;
    }
    if (result.extraction.tasks.length === 0) {
      setExtractError(true);
      return;
    }
    setExtractResults(result.extraction.tasks);
    setExtractFallback(result.tier === "template");
  }, [extractInput, extractTasks]);

  const toggleChecked = (index: number) => {
    setCheckedItems((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleAddExtracted = useCallback(() => {
    if (!extractResults) return;

    for (const [i, item] of extractResults.entries()) {
      if (!checkedItems.has(i)) continue;
      const taskDue = dueDateFromDueInDays(item.dueInDays);
      addTask({
        title: item.title,
        subject: item.subject || null,
        description: null,
        dueDate: taskDue.toISOString(),
        durationMinutes: null,
      });
    }

    setShowExtractModal(false);
    goBackToHome();
  }, [extractResults, checkedItems, addTask]);

  const closeExtractModal = () => {
    extractRequestRef.current += 1;
    cancelExtraction();
    setShowExtractModal(false);
    setExtractInput("");
    setExtractResults(null);
    setExtractLoading(false);
    setExtractError(false);
    setExtractFallback(false);
    setCheckedItems(new Set());
  };

  const toggleStartTime = (enabled: boolean) => {
    setHasStartTime(enabled);
    if (!enabled && datePanel === "start") setDatePanel("none");
  };

  const handleStartPress = () => {
    if (!hasStartTime) {
      setHasStartTime(true);
      setDatePanel("start");
      return;
    }
    setDatePanel((p) => (p === "start" ? "none" : "start"));
  };

  const handleDuePress = () => {
    setDatePanel((p) => (p === "due" ? "none" : "due"));
  };

  const checkedCount = checkedItems.size;
  const startValue = hasStartTime ? `${formatDueDate(dueDate)}, ${formatTime(startTimeDate)}` : "";
  const dueValue = `${formatDueDate(dueDate)}, ${formatTime(dueDate)}`;
  const showEstimateHint = preview !== null && !durationOverridden && durationMinutes !== null;

  return (
    <Screen>
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenHeader
          title="Add new task"
          left={<CircleButton icon="close-outline" onPress={() => goBackToHome()} accessibilityLabel="Close" />}
          right={
            <CircleButton
              icon="checkmark"
              onPress={handleSave}
              disabled={!canSave}
              accessibilityLabel="Save task"
              accessibilityHint={canSave ? undefined : "Enter a task name first"}
            />
          }
        />

        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            paddingHorizontal: spacing.sm,
            paddingTop: spacing.base,
            paddingBottom: spacing.xl,
            gap: spacing.sm,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Card padding="base">
            {/* 12 plus the label's own leading reads as 16 */}
            <View style={{ gap: spacing.md }}>
              <View>
                <Input
                  label="Task Name"
                  value={title}
                  onChangeText={setTitle}
                  placeholder="e.g. Write English essay on The Great Gatsby"
                  accessibilityLabel="Task title"
                  autoFocus
                  maxLength={TASK_TITLE_MAX_LENGTH}
                />
                {isAbstract && (
                  <View
                    className="flex-row items-center bg-accent-light dark:bg-accent-bright-light rounded-md"
                    style={{ marginTop: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
                  >
                    <Ionicons
                      name="sparkles-outline"
                      size={ICON_SIZE.chip}
                      className="text-accent-dark dark:text-accent-bright-dark"
                    />
                    <Text
                      className="flex-1 text-small font-medium text-accent-dark dark:text-accent-bright-dark"
                      style={{ marginLeft: spacing.sm - 2 }}
                    >
                      This one is big. Break it down below and start small.
                    </Text>
                  </View>
                )}
              </View>

              <View>
                <Input
                  label="Subject"
                  value={subject}
                  onChangeText={setSubject}
                  placeholder="e.g. English 2H"
                  accessibilityLabel="Subject, optional"
                />
                {subjectChips.length > 0 && (
                  <View style={{ marginTop: spacing.sm }}>
                    <SelectChipRow accessibilityLabel="Previously used subjects" scrollable>
                      {subjectChips.map((chip) => (
                        <SelectChip
                          key={chip}
                          label={chip}
                          selected={subject.trim() === chip}
                          onPress={() => setSubject(chip)}
                          accessibilityLabel={`Use subject ${chip}`}
                        />
                      ))}
                    </SelectChipRow>
                  </View>
                )}
              </View>

              <Input
                label="Description"
                value={description}
                onChangeText={setDescription}
                placeholder="Any details that might help"
                multiline
                accessibilityLabel="Task notes"
              />

              <View>
                <View className="flex-row" style={{ gap: spacing.md }}>
                  <View className="flex-1">
                    <DateField
                      label="Start Date"
                      value={startValue}
                      placeholder="Add start time"
                      onPress={handleStartPress}
                      accessibilityLabel={hasStartTime ? `Start date, ${startValue}` : "Start date, not set"}
                      accessibilityHint={hasStartTime ? "Opens the start time picker" : "Adds a start time, placing this task as a block on the calendar"}
                    />
                  </View>
                  <View className="flex-1">
                    <DateField
                      label="Due Date"
                      value={dueValue}
                      onPress={handleDuePress}
                      accessibilityLabel={`Due date, ${dueValue}`}
                      accessibilityHint="Opens the due date and time pickers"
                    />
                  </View>
                </View>

                {datePanel === "start" && (
                  <View style={{ marginTop: spacing.md }}>
                    <SubPanel label="Start time">
                      <Pressable
                        onPress={() => toggleStartTime(!hasStartTime)}
                        className="flex-row items-center"
                        style={{ minHeight: TOUCH_TARGET_MIN }}
                        accessibilityRole="switch"
                        accessibilityState={{ checked: hasStartTime }}
                        accessibilityLabel="Add start time"
                        accessibilityHint="Places this task as a block on the calendar"
                      >
                        <Ionicons
                          name="time-outline"
                          size={ICON_SIZE.row}
                          className="text-content dark:text-content-dark-primary"
                        />
                        <Text className="flex-1 text-body font-sans text-content dark:text-content-dark-primary" style={{ marginLeft: spacing.md }}>
                          Add start time
                          <Text className="text-content-muted dark:text-content-dark-muted"> (optional)</Text>
                        </Text>
                        <Switch
                          value={hasStartTime}
                          onValueChange={toggleStartTime}
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
                          onChange={(selected) => setStartTimeDate(selected)}
                          accessibilityLabel="Select start time"
                        />
                      )}
                    </SubPanel>
                  </View>
                )}

                {datePanel === "due" && (
                  <View style={{ marginTop: spacing.md }}>
                    <SubPanel label="Due">
                      <SelectChipRow accessibilityLabel="Due date or time">
                        <SelectChip
                          label="Date"
                          selected={dueMode === "date"}
                          onPress={() => setDueMode("date")}
                          accessibilityLabel="Pick the due date"
                        />
                        <SelectChip
                          label="Time"
                          selected={dueMode === "time"}
                          onPress={() => setDueMode("time")}
                          accessibilityLabel="Pick the due time"
                        />
                      </SelectChipRow>
                      <View style={{ marginTop: spacing.sm }}>
                        {dueMode === "date" ? (
                          <DateTimePickerCrossPlatform
                            value={dueDate}
                            mode="date"
                            display="inline"
                            onChange={(selected) => {
                              setDueDate((prev) => {
                                const next = new Date(selected);
                                next.setHours(prev.getHours(), prev.getMinutes(), 0, 0);
                                return next;
                              });
                            }}
                            minimumDate={new Date()}
                            accessibilityLabel="Select due date"
                          />
                        ) : (
                          <DateTimePickerCrossPlatform
                            value={dueDate}
                            mode="time"
                            display="spinner"
                            onChange={(selected) => {
                              setDueDate((prev) => {
                                const next = new Date(prev);
                                next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
                                return next;
                              });
                            }}
                            accessibilityLabel="Select due time"
                          />
                        )}
                      </View>
                    </SubPanel>
                  </View>
                )}
              </View>

              <View>
                <FieldLabel>How long?</FieldLabel>
                <SelectChipRow accessibilityLabel="How long" columns={DURATION_COLUMNS}>
                  {DURATION_PRESETS.map((preset) => {
                    const isSelected = durationMinutes === preset.value;
                    return (
                      <SelectChip
                        key={preset.value}
                        label={preset.label}
                        selected={isSelected}
                        onPress={() => {
                          setDurationOverridden(true);
                          setDurationMinutes(isSelected ? null : preset.value);
                        }}
                        accessibilityLabel={`Duration ${preset.label}`}
                      />
                    );
                  })}
                  {showEstimateHint && (
                    <SelectChip
                      label="Custom"
                      selected={false}
                      onPress={() => {
                        setDurationOverridden(true);
                        setDurationMinutes(null);
                      }}
                      icon="sparkles-outline"
                      accessibilityLabel="Override estimated duration"
                    />
                  )}
                </SelectChipRow>
                <Text
                  className="text-small font-medium text-content-muted dark:text-content-dark-muted"
                  style={{ marginTop: spacing.sm }}
                >
                  {showEstimateHint
                    ? `Estimated from steps: ${durationMinutes}m. Optional, helps with scheduling.`
                    : "Optional, helps with scheduling."}
                </Text>
              </View>
            </View>
          </Card>

          <Card padding="base">
            <CardTitle>Describe your tasks</CardTitle>
            <View style={{ marginTop: spacing.md }}>
              <Dropzone
                title="Paste a syllabus, an email, a note"
                hint="Uncoil finds the tasks and dates"
                onPress={() => setShowExtractModal(true)}
                accessibilityLabel="Describe your tasks: paste text and Uncoil will find tasks and dates"
              />
            </View>
          </Card>

          <Card padding="base">
            <CardTitle>Task Details</CardTitle>
            <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
              {breakdownLoading ? (
                <View style={{ gap: spacing.md }}>
                  <LoadingSkeleton width="100%" height={SKELETON_LINE} borderRadius={borderRadius.sm} />
                  <LoadingSkeleton width="90%" height={SKELETON_LINE} borderRadius={borderRadius.sm} />
                  <LoadingSkeleton width="95%" height={SKELETON_LINE} borderRadius={borderRadius.sm} />
                  <LoadingSkeleton width="80%" height={SKELETON_LINE} borderRadius={borderRadius.sm} />
                </View>
              ) : preview ? (
                <>
                  {preview.tier === "template" && (
                    <View
                      className="flex-row items-center bg-surface-card dark:bg-surface-dark-card rounded-md"
                      style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
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
                  {preview.subtasks.map((step, i) => (
                    <ChecklistRow
                      key={i}
                      title={step.title}
                      checked={false}
                      minutes={step.estimatedMinutes}
                    />
                  ))}
                  {/* validation rejects any step that doesn't open with a physical action, so this line is a real guarantee */}
                  <Text
                    className="text-small font-sans text-content-secondary dark:text-content-dark-secondary"
                    style={{ marginTop: spacing.xs }}
                  >
                    Every step starts with something you can physically do.
                  </Text>
                  {preview.tier === "model" && (
                    <View
                      className="flex-row items-center bg-surface-card dark:bg-surface-dark-card rounded-md"
                      style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
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
                <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
                  Break it down to get a few small steps.
                </Text>
              )}
            </View>
            <View style={{ marginTop: spacing.base }}>
              <Button
                title={breakdownLoading ? "Breaking it down" : preview ? "Break it down again" : "Break it down"}
                variant="secondary"
                onPress={handleBreakdown}
                loading={breakdownLoading}
                disabled={!canSave}
                icon={
                  <Ionicons
                    name="sparkles-outline"
                    size={ICON_SIZE.inline}
                    className="text-content dark:text-content-dark-primary"
                  />
                }
                accessibilityLabel={breakdownLoading ? "Breaking it down" : "Break this task down into small steps"}
                accessibilityHint={canSave ? "Uncoil generates a few small steps for this task" : "Enter a task name first"}
              />
            </View>
          </Card>
        </ScrollView>

        <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.sm, paddingBottom: insets.bottom + spacing.base }}>
          <Button
            title="Save task"
            variant="primary"
            onPress={handleSave}
            disabled={!canSave}
            accessibilityLabel="Save task"
          />
        </View>

        <SheetFrame
          visible={showExtractModal}
          title="Describe your tasks"
          onClose={closeExtractModal}
          closeLabel="Close"
          footer={
            extractLoading ? undefined : extractError ? (
              <Button
                title="Try again"
                variant="ghost"
                onPress={() => {
                  setExtractError(false);
                  setExtractResults(null);
                }}
                accessibilityLabel="Try again"
              />
            ) : extractResults ? (
              <Button
                title={checkedCount === 0 ? "No tasks selected" : `Add ${checkedCount} task${checkedCount === 1 ? "" : "s"}`}
                variant="primary"
                onPress={handleAddExtracted}
                disabled={checkedCount === 0}
                accessibilityLabel={`Add ${checkedCount} selected task${checkedCount === 1 ? "" : "s"}`}
              />
            ) : (
              <Button
                title="Extract tasks"
                variant="primary"
                onPress={handleExtract}
                disabled={!extractInput.trim()}
                accessibilityLabel="Extract tasks from text"
              />
            )
          }
        >
          {!extractResults && !extractLoading && !extractError && (
            <Input
              label="Your text"
              value={extractInput}
              onChangeText={setExtractInput}
              placeholder="Paste assignments, notes or reminders. Uncoil finds the tasks and dates."
              multiline
              minHeight={PASTE_MIN_HEIGHT}
              maxLength={EXTRACT_INPUT_MAX_LENGTH}
              accessibilityLabel="Paste text to extract tasks from"
            />
          )}

          {extractLoading && (
            <View style={{ gap: spacing.md }} accessibilityLabel="Finding tasks">
              <LoadingSkeleton width="100%" height={TOUCH_TARGET_MIN} borderRadius={borderRadius.md} />
              <LoadingSkeleton width="85%" height={TOUCH_TARGET_MIN} borderRadius={borderRadius.md} />
              <LoadingSkeleton width="92%" height={TOUCH_TARGET_MIN} borderRadius={borderRadius.md} />
            </View>
          )}

          {extractError && !extractLoading && (
            <View
              className="flex-row items-center bg-surface-elevated dark:bg-surface-dark-elevated rounded-md"
              style={{ minHeight: TOUCH_TARGET_MIN, paddingHorizontal: spacing.base, paddingVertical: spacing.md }}
              accessibilityLiveRegion="polite"
            >
              <Ionicons name="leaf-outline" size={ICON_SIZE.inline} className="text-content-secondary dark:text-content-dark-secondary" />
              <Text
                className="flex-1 text-body font-sans text-content-secondary dark:text-content-dark-secondary"
                style={{ marginLeft: spacing.sm }}
              >
                Could not find any tasks. You can add them one at a time.
              </Text>
            </View>
          )}

          {extractResults && !extractLoading && (
            <View>
              <View
                className="flex-row items-center bg-surface-card dark:bg-surface-dark-card rounded-md"
                style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginBottom: spacing.md }}
              >
                <Ionicons name="sparkles-outline" size={ICON_SIZE.chip} className="text-content-secondary dark:text-content-dark-secondary" />
                <Text
                  className="flex-1 text-small font-medium text-content-secondary dark:text-content-dark-secondary"
                  style={{ marginLeft: spacing.sm }}
                  accessibilityRole="text"
                >
                  {AI_EXTRACTION_NOTICE}
                </Text>
              </View>
              {extractFallback && (
                <View
                  className="flex-row items-center bg-surface-card dark:bg-surface-dark-card rounded-md"
                  style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginBottom: spacing.md }}
                >
                  <Ionicons name="leaf-outline" size={ICON_SIZE.chip} className="text-content-secondary dark:text-content-dark-secondary" />
                  <Text
                    className="flex-1 text-small font-medium text-content-secondary dark:text-content-dark-secondary"
                    style={{ marginLeft: spacing.sm }}
                  >
                    Could not read this one. Add anything it missed by hand.
                  </Text>
                </View>
              )}

              {extractResults.map((item, i) => {
                const checked = checkedItems.has(i);
                const dateLabel = formatExtractedDate(item.dueInDays);
                return (
                  <Pressable
                    key={i}
                    onPress={() => toggleChecked(i)}
                    className="flex-row items-start rounded-md active:bg-surface-elevated dark:active:bg-surface-dark-elevated border-border dark:border-border-dark"
                    style={{
                      minHeight: TOUCH_TARGET_MIN,
                      paddingVertical: spacing.sm,
                      borderBottomWidth: i === extractResults.length - 1 ? 0 : HAIRLINE,
                    }}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    accessibilityLabel={`${item.title}, due ${dateLabel}${item.subject ? `, ${item.subject}` : ""}`}
                  >
                    <View style={{ marginTop: spacing.xs / 2, marginRight: spacing.sm }}>
                      <Checkbox checked={checked} decorative />
                    </View>
                    <View className="flex-1">
                      <Text className="text-body font-sans text-content dark:text-content-dark-primary">
                        {item.title}
                      </Text>
                      <Text
                        className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
                        style={{ marginTop: spacing.xs / 2 }}
                      >
                        {item.subject ? `${dateLabel} · ${item.subject}` : dateLabel}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </SheetFrame>
      </KeyboardAvoidingView>
    </Screen>
  );
}
