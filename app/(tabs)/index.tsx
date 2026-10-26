import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { View, Text, ScrollView, useWindowDimensions } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTaskStore, useSchedulingStore, useSettingsStore } from "@/store/runtime";
import { useInsights } from "@/store/insightsSelectors";
import { useRightNowPick } from "@/store/rightNowSelectors";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { CircleButton } from "@/components/ui/CircleButton";
import { CircleButtonPair } from "@/components/ui/CircleButtonPair";
import { HeroHeadline } from "@/components/ui/HeroHeadline";
import { Input } from "@/components/ui/Input";
import { SegmentedPill, type SegmentedPillItem } from "@/components/ui/SegmentedPill";
import { TaskCard } from "@/components/ui/TaskCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { SubPanel } from "@/components/ui/SubPanel";
import { SheetFrame } from "@/components/ui/SheetFrame";
import { SettingsRow } from "@/components/ui/SettingsRow";
import { SelectChip, SelectChipRow } from "@/components/ui/SelectChip";
import { AddEventForm } from "@/components/ui/AddEventForm";
import { RightNowCard } from "@/components/ui/RightNowCard";
import { UndoToast, TASK_COMPLETED_COPY } from "@/components/ui/UndoToast";
import { ICON_SIZE, TAB_BAR_CLEARANCE, motion, spacing } from "@/utils/design-tokens";
import { consumeTutorialRequest } from "@/utils/pendingTutorial";
import { formatHour } from "@/utils/format";
import { calibrationLine } from "@/utils/calibration";
import { sortSubtasksForDisplay } from "@/utils/subtasks";
import { PER_HOUR_OPTIONS, QUIET_START_OPTIONS, QUIET_END_OPTIONS } from "@/utils/presets";
import type { DayOfWeek, Task } from "@/types";

type FilterTab = "all" | "upcoming" | "overdue" | "done";

const UPCOMING_DAYS = 7;
// a confirmed slot that started this recently still asks "did you work on it?"
const REVIEW_WINDOW_MS = 4 * 60 * 60 * 1000;
// the reschedule notice, then the completion toast that offers undo
const TOAST_MS = 3000;
const UNDO_TOAST_MS = 5000;
const TUTORIAL_PUSH_SLACK_MS = 100;
// minutes. two hours is on the list because a free afternoon counts too.
// the chips wrap to a second row rather than scroll, so none are hidden
const RIGHT_NOW_OPTIONS = [15, 30, 45, 60, 120] as const;

interface ToastState {
  taskId: string;
  message: string;
  showUndo: boolean;
}

const FILTERS: readonly { key: FilterTab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "upcoming", label: "Upcoming" },
  { key: "overdue", label: "Overdue" },
  { key: "done", label: "Done" },
];

function heroLines(allDone: boolean): [string, string] {
  if (allDone) return ["Everything is done.", "Add the next one when it comes."];
  const hour = new Date().getHours();
  if (hour < 12) return ["Let's get one thing", "started today."];
  if (hour < 17) return ["One small step", "is enough for now."];
  return ["Pick the next step", "and stop there."];
}

function formatScheduledTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const byDueDate = (a: Task, b: Task) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();

// shared by the bell's sheet and the menu's notifications view so the two can't drift
function NotificationSettings({
  maxPerHour,
  quietStart,
  quietEnd,
  updateSetting,
}: {
  maxPerHour: number;
  quietStart: number;
  quietEnd: number;
  updateSetting: (key: "maxNotificationsPerHour" | "quietHoursStart" | "quietHoursEnd", value: number) => void;
}) {
  return (
    <>
        <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary" style={{ marginBottom: spacing.lg }}>
          At most {maxPerHour} {maxPerHour === 1 ? "nudge" : "nudges"} an hour, and none between{" "}
          {formatHour(quietStart)} and {formatHour(quietEnd)}.
        </Text>
        <Text className="text-caption font-medium text-content-secondary dark:text-content-dark-secondary" style={{ marginBottom: spacing.sm }}>
          Max per hour
        </Text>
        <SelectChipRow accessibilityLabel="Max notifications per hour">
          {PER_HOUR_OPTIONS.map((val) => (
            <SelectChip
              key={val}
              label={`${val}`}
              selected={maxPerHour === val}
              onPress={() => updateSetting("maxNotificationsPerHour", val)}
              accessibilityLabel={`${val} per hour`}
            />
          ))}
        </SelectChipRow>
        <Text className="text-caption font-medium text-content-secondary dark:text-content-dark-secondary" style={{ marginTop: spacing.xl, marginBottom: spacing.sm }}>
          Quiet hours start
        </Text>
        <SelectChipRow accessibilityLabel="Quiet hours start">
          {QUIET_START_OPTIONS.map((h) => (
            <SelectChip
              key={h}
              label={formatHour(h)}
              selected={quietStart === h}
              onPress={() => updateSetting("quietHoursStart", h)}
              accessibilityLabel={`Quiet hours start at ${formatHour(h)}`}
            />
          ))}
        </SelectChipRow>
        <Text className="text-caption font-medium text-content-secondary dark:text-content-dark-secondary" style={{ marginTop: spacing.md, marginBottom: spacing.sm }}>
          Quiet hours end
        </Text>
        <SelectChipRow accessibilityLabel="Quiet hours end">
          {QUIET_END_OPTIONS.map((h) => (
            <SelectChip
              key={h}
              label={formatHour(h)}
              selected={quietEnd === h}
              onPress={() => updateSetting("quietHoursEnd", h)}
              accessibilityLabel={`Quiet hours end at ${formatHour(h)}`}
            />
          ))}
        </SelectChipRow>
    </>
  );
}

// past this Dynamic Type scale the four filter labels truncate, so the row scrolls instead
const LARGE_TYPE_SCALE = 1.3;

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const tasks = useTaskStore((s) => s.tasks);
  const setTaskStatus = useTaskStore((s) => s.setTaskStatus);
  const updateTask = useTaskStore((s) => s.updateTask);
  const proposeSchedule = useTaskStore((s) => s.proposeSchedule);
  const toggleSubtask = useTaskStore((s) => s.toggleSubtask);
  const canSchedule = useTaskStore((s) => s.canSchedule);
  const addSignal = useSchedulingStore((s) => s.addSignal);
  const addCalendarEvent = useSettingsStore((s) => s.addCalendarEvent);
  const maxNotificationsPerHour = useSettingsStore((s) => s.maxNotificationsPerHour);
  const quietHoursStart = useSettingsStore((s) => s.quietHoursStart);
  const quietHoursEnd = useSettingsStore((s) => s.quietHoursEnd);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  // the card cascade plays on first paint only. a tab switch remounts every card, and
  // half a second of cards trickling in after each tap feels slow
  const staggerEntrance = useRef(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // the menu swaps its own content instead of opening a second sheet. iOS won't present a
  // Modal over one still on screen, and the attempt leaves an invisible sheet eating every touch
  const [menuView, setMenuView] = useState<"rows" | "busy" | "notifications">("rows");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setMenuView("rows");
  }, []);
  // pushing while the menu's Modal is still exiting can leave iOS with an invisible presenter
  const openTutorialFromMenu = useCallback(() => {
    closeMenu();
    setTimeout(() => router.push("/tutorial"), motion.exit + TUTORIAL_PUSH_SLACK_MS);
  }, [closeMenu]);
  useEffect(() => {
    if (consumeTutorialRequest()) router.push("/tutorial");
  }, []);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // answered this session, so a card leaves at once and a second tap can't write a second signal
  const [reviewedIds, setReviewedIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    []
  );

  const showToast = useCallback((next: ToastState, durationMs: number) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(next);
    toastTimer.current = setTimeout(() => setToast(null), durationMs);
  }, []);

  const handleToggleComplete = useCallback(
    (task: Task) => {
      if (task.status === "complete") {
        setTaskStatus(task.id, "not_started");
        return;
      }
      setTaskStatus(task.id, "complete");
      showToast({ taskId: task.id, message: TASK_COMPLETED_COPY, showUndo: true }, UNDO_TOAST_MS);
    },
    [setTaskStatus, showToast]
  );

  const undoComplete = useCallback(() => {
    if (!toast) return;
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setTaskStatus(toast.taskId, "not_started");
    setToast(null);
  }, [toast, setTaskStatus]);

  const groups = useMemo(() => {
    const now = new Date();
    const weekEnd = new Date(now);
    weekEnd.setDate(weekEnd.getDate() + UPCOMING_DAYS);

    const all: Task[] = [];
    const upcoming: Task[] = [];
    const overdue: Task[] = [];
    const done: Task[] = [];
    for (const task of tasks) {
      if (task.status === "complete") {
        done.push(task);
        continue;
      }
      all.push(task);
      const due = new Date(task.dueDate);
      if (due < now) overdue.push(task);
      else if (due <= weekEnd) upcoming.push(task);
    }
    all.sort(byDueDate);
    upcoming.sort(byDueDate);
    overdue.sort(byDueDate);
    done.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return { all, upcoming, overdue, done };
  }, [tasks]);

  const visibleTasks = useMemo(() => {
    const list = groups[activeTab];
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (t) => t.title.toLowerCase().includes(needle) || (t.subject ?? "").toLowerCase().includes(needle)
    );
  }, [groups, activeTab, query]);

  // no count and no danger tone on Overdue. a growing red tally of missed work is a shame
  // counter, the one pattern that makes a list app unusable for these students
  const filterItems = useMemo<SegmentedPillItem[]>(
    () => FILTERS.map((tab) => ({ key: tab.key, label: tab.label })),
    []
  );

  const allDone = tasks.length > 0 && groups.all.length === 0;
  // only unscheduled tasks are checked, since each check enumerates slots
  const unschedulableIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of tasks) {
      if (task.status === "complete" || task.scheduleStatus !== "unscheduled") continue;
      if (!canSchedule(task.id)) ids.add(task.id);
    }
    return ids;
  }, [tasks, canSchedule]);

  const unschedulableTasks = useMemo(
    () => tasks.filter((t) => unschedulableIds.has(t.id)),
    [tasks, unschedulableIds]
  );

  const headline = useMemo(() => heroLines(allDone), [allDone]);

  const reviewTasks = useMemo(() => {
    const now = Date.now();
    const windowStart = now - REVIEW_WINDOW_MS;
    return tasks.filter((t) => {
      if (t.status === "complete") return false;
      if (t.scheduleStatus !== "confirmed") return false;
      if (!t.startTime) return false;
      if (reviewedIds.has(t.id)) return false;
      const st = new Date(t.startTime).getTime();
      return st < now && st > windowStart;
    });
  }, [tasks, reviewedIds]);

  const markReviewed = useCallback((taskId: string) => {
    setReviewedIds((prev) => {
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
  }, []);

  const handleReviewYes = useCallback(
    (taskId: string) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task || !task.startTime) return;
      const st = new Date(task.startTime);
      addSignal({
        taskId,
        dayOfWeek: st.getDay() as DayOfWeek,
        hourOfDay: st.getHours(),
        outcome: "completed",
        actualDurationMinutes: task.durationMinutes ?? null,
        estimatedDurationMinutes: task.durationMinutes ?? null,
      });
      markReviewed(taskId);
    },
    [tasks, addSignal, markReviewed]
  );

  const handleReviewNo = useCallback(
    (taskId: string) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task || !task.startTime) return;
      const st = new Date(task.startTime);
      addSignal({
        taskId,
        dayOfWeek: st.getDay() as DayOfWeek,
        hourOfDay: st.getHours(),
        outcome: "skipped",
        actualDurationMinutes: null,
        estimatedDurationMinutes: task.durationMinutes ?? null,
      });
      updateTask(taskId, {
        startTime: null,
        proposedTime: null,
        scheduleStatus: "rescheduled",
      });
      proposeSchedule(taskId);
      markReviewed(taskId);
    },
    [tasks, addSignal, updateTask, proposeSchedule, markReviewed]
  );

  const handleReviewPartial = useCallback(
    (taskId: string) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task || !task.startTime) return;
      const st = new Date(task.startTime);
      addSignal({
        taskId,
        dayOfWeek: st.getDay() as DayOfWeek,
        hourOfDay: st.getHours(),
        outcome: "partial",
        actualDurationMinutes: task.durationMinutes ?? null,
        estimatedDurationMinutes: task.durationMinutes ?? null,
      });
      markReviewed(taskId);
    },
    [tasks, addSignal, markReviewed]
  );

  const startFocus = useCallback((taskId: string) => {
    router.push({ pathname: "/focus/session", params: { taskId } });
  }, []);

  const rescheduleToTomorrow = useCallback(
    (task: Task) => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(23, 59, 59, 999);
      updateTask(task.id, {
        dueDate: tomorrow.toISOString(),
        startTime: null,
        proposedTime: null,
        scheduleStatus: "unscheduled",
      });
      proposeSchedule(task.id);
      showToast({ taskId: task.id, message: `Rescheduled: ${task.title}`, showUndo: false }, TOAST_MS);
    },
    [updateTask, proposeSchedule, showToast]
  );

  const toggleSearch = () => {
    if (searchOpen) setQuery("");
    setSearchOpen((open) => !open);
  };

  const showsHero = activeTab === "all" || activeTab === "upcoming";
  const heroTask = showsHero ? visibleTasks[0] : undefined;
  const listTasks = heroTask ? visibleTasks.slice(1) : visibleTasks;
  // starterAction is written once at breakdown and never updated, so after any step is done it
  // would name a finished one. from then on use the next undone step, same as the focus session
  const heroSteps = heroTask ? sortSubtasksForDisplay(heroTask.subtasks) : [];
  const heroStarter = heroSteps.some((s) => s.isComplete)
    ? heroSteps.find((s) => !s.isComplete)?.title
    : heroTask?.starterAction;

  // null until a window is picked, so nothing is computed before they ask
  const [rightNowMinutes, setRightNowMinutes] = useState<number | null>(null);
  const rightNowPick = useRightNowPick(rightNowMinutes);
  const insights = useInsights();
  // the same line Profile shows. here it explains why the fit above it was padded
  const calibrationNote =
    insights.estimateCalibration !== null ? calibrationLine(insights.estimateCalibration.ratio) : null;
  const startRightNow = useCallback(() => {
    if (rightNowPick === null) return;
    const task = tasks.find((t) => t.id === rightNowPick.taskId);
    if (task === undefined) return;
    if (task.status === "not_started") setTaskStatus(task.id, "in_progress");
    startFocus(task.id);
  }, [rightNowPick, tasks, setTaskStatus, startFocus]);

  const renderEmpty = () => {
    if (tasks.length === 0) {
      return (
        <EmptyState
          title="Nothing to start yet"
          subtitle="Add one assignment. Uncoil breaks it into small steps."
          actionLabel="Add a task"
          onAction={() => router.push("/task/new")}
        />
      );
    }
    if (query.trim()) {
      return <EmptyState title="No matches" subtitle="Try another word from the title or subject." />;
    }
    switch (activeTab) {
      case "all":
        return <EmptyState title="Everything is done" subtitle="Add the next task when it comes." actionLabel="Add a task" onAction={() => router.push("/task/new")} />;
      case "upcoming":
        return <EmptyState title="Nothing due this week" subtitle="Check All for what comes later." />;
      case "overdue":
        return <EmptyState title="Nothing overdue" subtitle="Everything is still on time." />;
      case "done":
        return <EmptyState title="Nothing done yet" subtitle="Finished tasks collect here." />;
      default: {
        const never: never = activeTab;
        return never;
      }
    }
  };

  return (
    <Screen>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <ScreenHeader
          left={
            <CircleButton
              icon="reorder-three-outline"
              onPress={() => setMenuOpen(true)}
              accessibilityLabel="Menu"
              accessibilityHint="Opens busy time, review and notification options"
            />
          }
          right={
            <CircleButtonPair>
              <CircleButton
                icon="notifications-outline"
                onPress={() => setNotificationsOpen(true)}
                accessibilityLabel="Notifications"
                accessibilityHint="Opens the notification settings"
              />
              <CircleButton
                icon="search-outline"
                onPress={toggleSearch}
                accessibilityLabel={searchOpen ? "Close search" : "Search tasks"}
              />
            </CircleButtonPair>
          }
        />

        <View style={{ paddingHorizontal: spacing.base, marginTop: spacing.xl }}>
          <HeroHeadline lines={headline} />
        </View>

        {searchOpen ? (
          <View style={{ paddingHorizontal: spacing.base, marginTop: spacing.lg }}>
            <Input
              label="Search"
              value={query}
              onChangeText={setQuery}
              placeholder="Title or subject"
              autoFocus
              returnKeyType="search"
              accessibilityLabel="Search tasks by title or subject"
            />
          </View>
        ) : null}

        <View style={{ paddingHorizontal: spacing.sm, marginTop: spacing.lg }}>
          <SegmentedPill
            items={filterItems}
            value={activeTab}
            onChange={(key) => {
              staggerEntrance.current = false;
              setActiveTab(key as FilterTab);
            }}
            scrollable={fontScale >= LARGE_TYPE_SCALE}
            accessibilityLabel="Task filters"
          />
        </View>

        <View style={{ paddingHorizontal: spacing.sm, marginTop: spacing.base, gap: spacing.md }}>
          {unschedulableTasks.length > 0 && (
            <SubPanel label="Won't fit before the due date">
              <View style={{ gap: spacing.xs }}>
                {unschedulableTasks.map((task) => (
                  <Text
                    key={task.id}
                    className="text-body font-sans text-content dark:text-content-dark-primary"
                    numberOfLines={1}
                  >
                    {task.title}
                  </Text>
                ))}
              </View>
            </SubPanel>
          )}

          {reviewOpen && reviewTasks.length > 0
            ? reviewTasks.map((task) => (
                <Card
                  key={task.id}
                  accessibilityLabel={`Review: Did you work on ${task.title} at ${formatScheduledTime(task.startTime!)}`}
                  footer={
                    <SubPanel label="Did you work on it?">
                      <View className="flex-row flex-wrap items-center" style={{ gap: spacing.sm }}>
                        <Chip
                          label="Yes"
                          dot="success"
                          size="md"
                          onPress={() => handleReviewYes(task.id)}
                          accessibilityLabel={`Yes, I worked on ${task.title}`}
                        />
                        <Chip
                          label="Partially"
                          dot="warning"
                          size="md"
                          onPress={() => handleReviewPartial(task.id)}
                          accessibilityLabel={`Partially worked on ${task.title}`}
                        />
                        <Chip
                          label="No"
                          dot="danger"
                          size="md"
                          onPress={() => handleReviewNo(task.id)}
                          accessibilityLabel={`No, I did not work on ${task.title}`}
                        />
                      </View>
                    </SubPanel>
                  }
                >
                  <Text className="text-heading font-medium text-content dark:text-content-dark-primary">{task.title}</Text>
                  <View className="flex-row items-center" style={{ marginTop: spacing.xs }}>
                    <Ionicons name="time-outline" size={ICON_SIZE.inline} className="text-content-secondary dark:text-content-dark-secondary" />
                    <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary" style={{ marginLeft: spacing.xs + 2 }}>
                      Scheduled at {formatScheduledTime(task.startTime!)}
                    </Text>
                  </View>
                </Card>
              ))
            : null}

          {visibleTasks.length === 0 ? renderEmpty() : null}

          {heroTask ? (
            <TaskCard
              variant="hero"
              index={staggerEntrance.current ? 0 : undefined}
              title={heroTask.title}
              dueDate={heroTask.dueDate}
              subtaskCount={heroTask.subtasks.length}
              completedSubtasks={heroTask.subtasks.filter((s) => s.isComplete).length}
              subject={heroTask.subject}
              description={heroTask.description}
              durationMinutes={heroTask.durationMinutes}
              starterAction={heroStarter || `Open "${heroTask.title}" and look at what's needed`}
              isComplete={heroTask.status === "complete"}
              isUnschedulable={unschedulableIds.has(heroTask.id)}
              onToggleComplete={() => handleToggleComplete(heroTask)}
              onStartFocus={() => {
                if (heroTask.status === "not_started") setTaskStatus(heroTask.id, "in_progress");
                startFocus(heroTask.id);
              }}
              onBreakDown={() => router.push(`/task/${heroTask.id}`)}
              onReschedule={new Date(heroTask.dueDate) < new Date() ? () => rescheduleToTomorrow(heroTask) : undefined}
              onPress={() => router.push(`/task/${heroTask.id}`)}
            />
          ) : null}

          {showsHero && visibleTasks.length > 0 ? (
            <RightNowCard
              options={RIGHT_NOW_OPTIONS}
              selected={rightNowMinutes}
              onSelect={setRightNowMinutes}
              pick={
                rightNowPick === null
                  ? null
                  : { title: rightNowPick.title, taskTitle: rightNowPick.taskTitle, fitMinutes: rightNowPick.fitMinutes }
              }
              onStart={startRightNow}
              calibrationNote={calibrationNote}
            />
          ) : null}

          {listTasks.map((task, taskIndex) => {
            const cardIndex = staggerEntrance.current ? (heroTask ? taskIndex + 1 : taskIndex) : undefined;
            if (activeTab === "done") {
              return (
                <TaskCard
                  key={task.id}
                  variant="done"
                  index={cardIndex}
                  title={task.title}
                  dueDate={task.dueDate}
                  subtaskCount={task.subtasks.length}
                  completedSubtasks={task.subtasks.filter((s) => s.isComplete).length}
                  subject={task.subject}
                  description={task.description}
                  isComplete
                  onToggleComplete={() => handleToggleComplete(task)}
                  onPress={() => router.push(`/task/${task.id}`)}
                />
              );
            }
            const isOverdue = new Date(task.dueDate) < new Date();
            return (
              <TaskCard
                key={task.id}
                variant="list"
                index={cardIndex}
                title={task.title}
                dueDate={task.dueDate}
                subtaskCount={task.subtasks.length}
                completedSubtasks={task.subtasks.filter((s) => s.isComplete).length}
                subject={task.subject}
                description={task.description}
                durationMinutes={task.durationMinutes}
                nextSubtasks={task.subtasks}
                isComplete={task.status === "complete"}
                isUnschedulable={unschedulableIds.has(task.id)}
                onToggleComplete={() => handleToggleComplete(task)}
                onToggleSubtask={(subtaskId) => toggleSubtask(task.id, subtaskId)}
                onStartFocus={() => startFocus(task.id)}
                onReschedule={isOverdue ? () => rescheduleToTomorrow(task) : undefined}
                onPress={() => router.push(`/task/${task.id}`)}
              />
            );
          })}
        </View>
      </ScrollView>

      <SheetFrame
        visible={menuOpen}
        title={menuView === "busy" ? "Add busy time" : menuView === "notifications" ? "Notifications" : "Menu"}
        onClose={closeMenu}
        scroll={menuView !== "rows"}
      >
        {menuView === "busy" ? (
          <AddEventForm
            onSubmit={(event) => {
              addCalendarEvent(event);
              closeMenu();
            }}
            onCancel={() => setMenuView("rows")}
          />
        ) : menuView === "notifications" ? (
          <NotificationSettings
            maxPerHour={maxNotificationsPerHour}
            quietStart={quietHoursStart}
            quietEnd={quietHoursEnd}
            updateSetting={updateSetting}
          />
        ) : (
          <>
        <SettingsRow
          icon="help-circle-outline"
          label="How Uncoil works"
          onPress={openTutorialFromMenu}
          accessibilityHint="Opens the short guide to using Uncoil"
        />
        <SettingsRow
          icon="calendar-outline"
          label="Add a busy time"
          onPress={() => setMenuView("busy")}
          accessibilityLabel="Add a busy time to your calendar"
        />
        <SettingsRow
          icon="time-outline"
          label="Review yesterday"
          value={reviewTasks.length > 0 ? `${reviewTasks.length} to review` : "Nothing to review"}
          disabled={reviewTasks.length === 0}
          onPress={() => {
            closeMenu();
            setReviewOpen(true);
          }}
          accessibilityHint="Shows the scheduled tasks waiting for a yes or no"
        />
        <SettingsRow
          icon="notifications-outline"
          label="Notifications"
          value={`${maxNotificationsPerHour} per hour`}
          onPress={() => setMenuView("notifications")}
        />
          </>
        )}
      </SheetFrame>

      <SheetFrame visible={notificationsOpen} title="Notifications" onClose={() => setNotificationsOpen(false)} scroll={false}>
        <NotificationSettings
          maxPerHour={maxNotificationsPerHour}
          quietStart={quietHoursStart}
          quietEnd={quietHoursEnd}
          updateSetting={updateSetting}
        />
      </SheetFrame>


      <UndoToast visible={toast !== null} message={toast?.message ?? ""} onUndo={toast?.showUndo ? undoComplete : undefined} />
    </Screen>
  );
}
