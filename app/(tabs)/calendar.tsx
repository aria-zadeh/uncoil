import React, { useMemo, useCallback, useState } from "react";
import { View, Text, Pressable, useWindowDimensions } from "react-native";
import { useColorScheme } from "nativewind";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Calendar as RNCalendar } from "react-native-calendars";
import { Ionicons } from "@expo/vector-icons";
import { Button } from "@/components/ui/Button";
import { ChecklistRow } from "@/components/ui/ChecklistRow";
import { Chip } from "@/components/ui/Chip";
import { CircleButton } from "@/components/ui/CircleButton";
import { CircleButtonPair } from "@/components/ui/CircleButtonPair";
import { Input } from "@/components/ui/Input";
import { MonthCard } from "@/components/ui/MonthCard";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { SegmentedPill, type SegmentedPillItem } from "@/components/ui/SegmentedPill";
import { SheetFrame } from "@/components/ui/SheetFrame";
import { AddEventForm } from "@/components/ui/AddEventForm";
import { TimeGutter, getGutterWidth } from "@/components/ui/TimeGutter";
import { WeekStrip, type WeekStripDay } from "@/components/ui/WeekStrip";
import {
  colors,
  fontFamily,
  motion,
  shadows,
  spacing,
  springs,
  typography,
  HAIRLINE,
  ICON_SIZE,
  TAB_BAR_CLEARANCE,
  TOUCH_TARGET_MIN,
} from "@/utils/design-tokens";
import { useTaskStore, useSettingsStore } from "@/store/runtime";
import type { DayKey, PeriodKey, Subtask } from "@/types";
import {
  GestureDetector,
  Gesture,
  GestureHandlerRootView,
  ScrollView,
  State,
  type PanGesture,
} from "react-native-gesture-handler";
import Reanimated, {
  Easing,
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  useReducedMotion,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

// 96 pt per hour, so a 45-minute block is 72 pt and a 15-minute drag snap is 24 pt
const HOUR_HEIGHT = 96;
const START_HOUR = 7;
const END_HOUR = 23;
const TOTAL_HOURS = END_HOUR - START_HOUR;
const GRID_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT;
const SNAP_INCREMENT = HOUR_HEIGHT / 4;
const DAYS_PER_WEEK = 7;
// the hour rule sits level with the middle of the gutter label's first line
const RULE_OFFSET = typography.caption.lineHeight / 2;
const LAST_LABEL_HEIGHT = typography.caption.lineHeight * 2;
// 30 minutes, enough for one title line
const MIN_BLOCK_HEIGHT = HOUR_HEIGHT / 2;
const MIN_HEIGHT_FOR_TIME = typography.bodyMedium.lineHeight + typography.caption.lineHeight + spacing.md * 2;
const CHECKLIST_ROWS = 3;
// mirrored from ChecklistRow so a block can count how many rows it holds
const CHECKLIST_ROW_HEIGHT = 30;
const CHECKLIST_HEADER_HEIGHT =
  spacing.md * 2 + typography.body.lineHeight + typography.caption.lineHeight + spacing.sm;

// a block's height is its duration and can't grow, so it lists only the rows that fit whole.
// exact only because BlockCard clamps the title and every row to one line
function checklistRowsThatFit(height: number): number {
  const available = height - BLOCK_GAP - CHECKLIST_HEADER_HEIGHT;
  return Math.max(0, Math.min(CHECKLIST_ROWS, Math.floor(available / CHECKLIST_ROW_HEIGHT)));
}
const PLAY_SIZE = 28;
// top-right corner a tap reads as the play control
const PLAY_HIT = TOUCH_TARGET_MIN;
// so blocks that touch in time read as separate
const BLOCK_GAP = spacing.xs;
const DRAG_SCALE = 1.04;
// moving further than this before the long press fires means scrolling or swiping,
// so the touch falls through to the ScrollView or the day swipe
const DRAG_CANCEL_DISTANCE = 10;
const NO_AGENDA_HEIGHT = TOUCH_TARGET_MIN;
const SWIPE_ACTIVATE = spacing.md;
const SWIPE_FAIL_Y = spacing.md;
// fraction of the track width, or velocity in pt/s
const SWIPE_COMMIT_FRACTION = 0.3;
const SWIPE_COMMIT_VELOCITY = 500;
const SWIPE_FOLLOW_FRACTION = 0.22;
// larger than the follow so the day reads as leaving, not nudged
const SWIPE_EXIT_FRACTION = 0.35;

// rubber band: 1:1 at first, easing toward `max` and never past it.
// a flat fraction of the finger's travel read as an unresponsive screen
function followX(translation: number, max: number): number {
  "worklet";
  const distance = Math.abs(translation);
  const eased = max * (1 - max / (distance + max));
  return translation < 0 ? -eased : eased;
}
// Sunday first, matching Date.getDay(). app/ can't import services/periods.ts
const WEEKDAY_KEYS: readonly DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const RANGE_PILL_WIDTH = TOUCH_TARGET_MIN * 4;
const UPPERCASE_TRACKING = 0.4;

type ViewMode = "week" | "month";
type RangeMode = "day" | "week";

const RANGE_ITEMS: readonly SegmentedPillItem[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
];

interface TimedBlock {
  id: string;
  taskId: string;
  day: number; // 0 = Monday, 6 = Sunday
  startHour: number;
  startMinute: number;
  durationMinutes: number;
  title: string;
  // a timed task with a start time and no steps
  isTypeA?: boolean;
  // proposed by the scheduler, drawn dashed until confirmed
  isProposed?: boolean;
  // a one-off busy event
  isCalendarEvent?: boolean;
  // set when this block is one step of a broken-down task
  parentId?: string;
  parentTitle?: string;
  subtaskIndex?: number;
  isComplete?: boolean;
  // step count when this block stands for a collapsed parent
  subtaskCount?: number;
  subtasks?: readonly Subtask[];
}

interface AllDayBlock {
  id: string;
  taskId: string;
  day: number;
  title: string;
}

interface BusyBlock {
  id: string;
  day: number;
  startHour: number;
  startMinute: number;
  durationMinutes: number;
}

interface DayModel {
  index: number;
  date: Date;
  label: string;
  dateNum: number;
  isToday: boolean;
  isPast: boolean;
}

interface AgendaDay {
  day: DayModel;
  timed: TimedBlock[];
  allDay: AllDayBlock[];
  busy: BusyBlock[];
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

// Sunday belongs to the week before it
function getMondayContaining(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// local "YYYY-MM-DD", the key react-native-calendars uses
function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// "9am", "2:30pm"
function formatTime(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "pm" : "am";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const m = minute === 0 ? "" : `:${minute.toString().padStart(2, "0")}`;
  return `${h}${m}${suffix}`;
}

// "09:15 AM"
function formatClock(hour: number, minute: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${period}`;
}

function formatRange(startHour: number, startMinute: number, durationMinutes: number): string {
  const endTotal = startHour * 60 + startMinute + durationMinutes;
  const endHour = Math.floor(endTotal / 60);
  const endMinute = endTotal % 60;
  return `${formatClock(startHour, startMinute)} - ${formatClock(endHour, endMinute)}`;
}

function topForTime(hour: number, minute: number): number {
  return (hour - START_HOUR) * HOUR_HEIGHT + (minute / 60) * HOUR_HEIGHT;
}

function heightForDuration(minutes: number): number {
  return Math.max((minutes / 60) * HOUR_HEIGHT, MIN_BLOCK_HEIGHT);
}

// 0 = Monday, or -1 outside the week
function getDayIndex(date: Date, weekStart: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const ws = new Date(weekStart);
  ws.setHours(0, 0, 0, 0);
  const diff = Math.floor((d.getTime() - ws.getTime()) / (24 * 60 * 60 * 1000));
  return diff >= 0 && diff < DAYS_PER_WEEK ? diff : -1;
}

function snapToGrid(pixelY: number): number {
  // called from the drag worklets too. without the directive the worklet throws and aborts the process
  "worklet";
  return Math.round(pixelY / SNAP_INCREMENT) * SNAP_INCREMENT;
}

function clampTop(top: number, blockHeight: number): number {
  // reached from the drag worklets too
  "worklet";
  const maxTop = GRID_HEIGHT - blockHeight;
  return Math.max(0, Math.min(top, maxTop));
}

function pixelToTime(pixelY: number): { hour: number; minute: number } {
  const snapped = snapToGrid(pixelY);
  const totalMinutesFromStart = (snapped / HOUR_HEIGHT) * 60;
  const hour = Math.floor(totalMinutesFromStart / 60) + START_HOUR;
  const minute = Math.round(totalMinutesFromStart % 60);
  const clampedHour = Math.max(START_HOUR, Math.min(END_HOUR - 1, hour));
  const clampedMinute = clampedHour === END_HOUR - 1 ? 0 : minute;
  return { hour: clampedHour, minute: clampedMinute };
}

function buildStartTimeISO(dueDateISO: string, hour: number, minute: number): string {
  const d = new Date(dueDateISO);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function buildDueDateISO(weekStart: Date, dayIndex: number): string {
  const d = addDays(weekStart, dayIndex);
  d.setHours(12, 0, 0, 0); // noon keeps date-only parsing stable
  return d.toISOString();
}

// side-by-side columns for overlapping blocks, like Google Calendar
function computeColumnLayout(
  blocks: TimedBlock[]
): Map<string, { col: number; totalCols: number }> {
  const layout = new Map<string, { col: number; totalCols: number }>();
  if (blocks.length === 0) return layout;

  const getStart = (b: TimedBlock) => b.startHour * 60 + b.startMinute;
  const getEnd = (b: TimedBlock) => getStart(b) + b.durationMinutes;

  // a task's steps share one span so the whole group takes one column
  interface SpanBlock { key: string; start: number; end: number; blockIds: string[] }
  const spanMap = new Map<string, SpanBlock>();
  for (const b of blocks) {
    const groupKey = b.parentId ?? b.id;
    const existing = spanMap.get(groupKey);
    const s = getStart(b);
    const e = getEnd(b);
    if (existing) {
      existing.start = Math.min(existing.start, s);
      existing.end = Math.max(existing.end, e);
      existing.blockIds.push(b.id);
    } else {
      spanMap.set(groupKey, { key: groupKey, start: s, end: e, blockIds: [b.id] });
    }
  }
  const spans = [...spanMap.values()].sort((a, b) => a.start - b.start);

  const colEnds: number[] = [];
  const spanAssigned: { span: SpanBlock; col: number }[] = [];

  for (const span of spans) {
    let col = colEnds.findIndex((end) => end <= span.start);
    if (col === -1) col = colEnds.length;
    colEnds[col] = span.end;
    spanAssigned.push({ span, col });
  }

  // overlap is transitive, so every span in a connected group shares totalCols
  const n = spans.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (spans[j].start < spans[i].end && spans[j].end > spans[i].start) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  const visited = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const component: number[] = [i];
    visited[i] = 1;
    let head = 0;
    while (head < component.length) {
      for (const nb of adj[component[head]]) {
        if (!visited[nb]) {
          visited[nb] = 1;
          component.push(nb);
        }
      }
      head++;
    }
    let maxCol = 0;
    for (const idx of component) {
      maxCol = Math.max(maxCol, spanAssigned[idx].col);
    }
    const totalCols = maxCol + 1;
    for (const idx of component) {
      const { span, col } = spanAssigned[idx];
      for (const blockId of span.blockIds) {
        layout.set(blockId, { col, totalCols });
      }
    }
  }

  return layout;
}

// for the "next free hour" pick
function takenHours(timed: readonly TimedBlock[], busy: readonly BusyBlock[]): Set<number> {
  const taken = new Set<number>();
  const mark = (startHour: number, startMinute: number, durationMinutes: number) => {
    const end = Math.ceil((startHour * 60 + startMinute + durationMinutes) / 60);
    for (let h = startHour; h < end; h++) taken.add(h);
  };
  for (const b of timed) mark(b.startHour, b.startMinute, b.durationMinutes);
  for (const b of busy) mark(b.startHour, b.startMinute, b.durationMinutes);
  return taken;
}

export default function CalendarScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const [mode, setMode] = useState<ViewMode>("week");
  const [range, setRange] = useState<RangeMode>("day");
  const { width: screenWidth, fontScale } = useWindowDimensions();
  // getGutterWidth widens at large Dynamic Type, so the track must use the same value or they overlap
  const trackWidth = screenWidth - spacing.base * 2 - getGutterWidth(fontScale);

  const today = useMemo(() => new Date(), []);
  // moves when the month grid picks a day outside it
  const [weekStart, setWeekStart] = useState(() => getMondayContaining(new Date()));
  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(0, getDayIndex(new Date(), getMondayContaining(new Date())))
  );

  const tasks = useTaskStore((s) => s.tasks);
  const updateTask = useTaskStore((s) => s.updateTask);
  const busyBlocks = useSettingsStore((s) => s.busyBlocks);
  const calendarEvents = useSettingsStore((s) => s.calendarEvents);
  const addCalendarEvent = useSettingsStore((s) => s.addCalendarEvent);
  const energyPeakStart = useSettingsStore((s) => s.energyPeakStart);

  const days = useMemo<DayModel[]>(
    () =>
      Array.from({ length: DAYS_PER_WEEK }, (_, i) => {
        const date = addDays(weekStart, i);
        return {
          index: i,
          date,
          label: WEEKDAY_LABELS[i],
          dateNum: date.getDate(),
          isToday: sameDay(date, today),
          isPast: date.getTime() < today.getTime() && !sameDay(date, today),
        };
      }),
    [weekStart, today]
  );

  const selectedDay = days[selectedIndex] ?? days[0];

  const monthLabel = useMemo(
    () => selectedDay.date.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    [selectedDay]
  );
  const weekStripDays = useMemo<WeekStripDay[]>(
    () =>
      days.map((day) => ({
        key: String(day.index),
        weekday: day.label.charAt(0),
        dayNumber: day.dateNum,
        isToday: day.isToday,
        isSelected: day.index === selectedIndex,
        isPast: day.isPast,
      })),
    [days, selectedIndex]
  );

  const handleSelectDay = useCallback((key: string) => {
    setSelectedIndex(Math.max(0, Math.min(DAYS_PER_WEEK - 1, Number(key))));
    setRange("day");
  }, []);

  const handleAgendaSelectDay = useCallback((index: number) => {
    setSelectedIndex(Math.max(0, Math.min(DAYS_PER_WEEK - 1, index)));
    setRange("day");
  }, []);

  const handleRangeChange = useCallback((key: string) => {
    setRange(key === "week" ? "week" : "day");
  }, []);

  const handleSwipe = useCallback(
    (direction: 1 | -1) => {
      const step = range === "week" ? DAYS_PER_WEEK : 1;
      const next = addDays(selectedDay.date, direction * step);
      const start = getMondayContaining(next);
      if (start.getTime() !== weekStart.getTime()) setWeekStart(start);
      setSelectedIndex(Math.max(0, getDayIndex(next, start)));
    },
    [range, selectedDay, weekStart]
  );

  const handleToggleMonth = useCallback(() => {
    setMode((prev) => (prev === "week" ? "month" : "week"));
  }, []);

  const handleMonthDayPress = useCallback((dateString: string) => {
    const date = new Date(`${dateString}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
      setMode("week");
      return;
    }
    const start = getMondayContaining(date);
    setWeekStart(start);
    setSelectedIndex(Math.max(0, getDayIndex(date, start)));
    setMode("week");
    setRange("day");
  }, []);

  // start time, no steps  -> one timed block
  // start time, steps     -> one block for all steps at the start time
  // no start, no steps    -> all-day chip
  // no start, steps       -> one block for all steps at the energy peak
  const { timedBlocks, allDayBlocks } = useMemo(() => {
    const timed: TimedBlock[] = [];
    const allDay: AllDayBlock[] = [];

    for (const task of tasks) {
      if (task.status === "complete") continue;

      const taskDate = new Date(task.dueDate);
      const dayIndex = getDayIndex(taskDate, weekStart);
      if (dayIndex < 0 || dayIndex > 6) continue;

      const hasSubtasks = task.subtasks.length > 0;

      const effectiveTime = task.startTime ?? (task.proposedTime && task.scheduleStatus === "proposed" ? task.proposedTime : undefined);
      const isProposed = !task.startTime && !!task.proposedTime && task.scheduleStatus === "proposed";

      if (effectiveTime) {
        const st = new Date(effectiveTime);
        const anchorHour = st.getHours();
        const anchorMinute = st.getMinutes();

        // a proposed time can fall on a different day than the due date
        const effectiveDayIndex = isProposed ? getDayIndex(st, weekStart) : dayIndex;
        if (effectiveDayIndex < 0 || effectiveDayIndex > 6) continue;

        if (!hasSubtasks) {
          const defaultDurationMinutes = task.durationMinutes ?? 60;
          timed.push({
            id: task.id,
            taskId: task.id,
            day: isProposed ? effectiveDayIndex : dayIndex,
            startHour: anchorHour,
            startMinute: anchorMinute,
            durationMinutes: defaultDurationMinutes,
            title: task.title,
            isTypeA: true,
            isProposed,
            isComplete: false, // complete tasks are skipped above
          });
        } else {
          const totalDuration = task.subtasks.reduce((sum, s) => sum + (s.estimatedMinutes || 15), 0);
          const subtaskDay = isProposed ? effectiveDayIndex : dayIndex;
          timed.push({
            id: task.id,
            taskId: task.id,
            day: subtaskDay,
            startHour: anchorHour,
            startMinute: anchorMinute,
            durationMinutes: totalDuration,
            title: task.title,
            isTypeA: true,
            isProposed,
            isComplete: false,
            subtaskCount: task.subtasks.length,
            subtasks: task.subtasks,
          });
        }
      } else if (!hasSubtasks) {
        allDay.push({
          id: task.id,
          taskId: task.id,
          day: dayIndex,
          title: task.title,
        });
      } else {
        const peakStart = energyPeakStart ?? 15;
        const totalDuration = task.subtasks.reduce((sum, s) => sum + (s.estimatedMinutes || 15), 0);
        timed.push({
          id: task.id,
          taskId: task.id,
          day: dayIndex,
          startHour: peakStart,
          startMinute: 0,
          durationMinutes: totalDuration,
          title: task.title,
          isTypeA: true,
          isComplete: false,
          subtaskCount: task.subtasks.length,
          subtasks: task.subtasks,
        });
      }
    }

    // a repeating event draws on every matching weekday from its date onward, the same
    // way the scheduler and notification plan expand it, so all three agree on busy time
    for (const event of calendarEvents) {
      const [sh, sm] = event.startTime.split(":").map(Number);
      const [eh, em] = event.endTime.split(":").map(Number);
      const durationMinutes = (eh * 60 + em) - (sh * 60 + sm);
      if (durationMinutes <= 0) continue;

      const anchor = new Date(event.date + "T00:00:00");
      const dayIndices: number[] = [];
      if (event.repeatDays.length === 0) {
        const evDayIndex = getDayIndex(anchor, weekStart);
        if (evDayIndex >= 0 && evDayIndex <= 6) dayIndices.push(evDayIndex);
      } else {
        for (let i = 0; i <= 6; i++) {
          const day = addDays(weekStart, i);
          day.setHours(0, 0, 0, 0);
          if (day.getTime() < anchor.getTime()) continue;
          if (event.repeatDays.includes(WEEKDAY_KEYS[day.getDay()])) dayIndices.push(i);
        }
      }

      for (const dayIndex of dayIndices) {
        timed.push({
          // one block per matching day, so the key needs the day too
          id: `cal-event-${event.id}-${dayIndex}`,
          taskId: event.id, // not a real task, handled in press
          day: dayIndex,
          startHour: sh,
          startMinute: sm,
          durationMinutes,
          title: event.title,
          isCalendarEvent: true,
        });
      }
    }

    return { timedBlocks: timed, allDayBlocks: allDay };
  }, [tasks, weekStart, energyPeakStart, calendarEvents]);

  const busyBlocksData = useMemo(() => {
    const DAY_MAP: Record<DayKey, number> = {
      mon: 0,
      tue: 1,
      wed: 2,
      thu: 3,
      fri: 4,
      sat: 5,
      sun: 6,
    };
    const PERIOD_MAP: Record<PeriodKey, { startHour: number; durationMinutes: number }> = {
      morning: { startHour: 8, durationMinutes: 240 },   // 8am to 12pm
      afternoon: { startHour: 12, durationMinutes: 300 }, // 12pm to 5pm
      evening: { startHour: 17, durationMinutes: 240 },   // 5pm to 9pm
    };

    return busyBlocks.map((b, i): BusyBlock => ({
      id: `busy-${i}`,
      day: DAY_MAP[b.day],
      startHour: PERIOD_MAP[b.period].startHour,
      startMinute: 0,
      durationMinutes: PERIOD_MAP[b.period].durationMinutes,
    }));
  }, [busyBlocks]);

  const blocksByDay = useMemo(() => {
    const byDay: Record<number, TimedBlock[]> = {};
    for (let i = 0; i < DAYS_PER_WEEK; i++) byDay[i] = [];
    for (const b of timedBlocks) byDay[b.day].push(b);
    for (const key of Object.keys(byDay)) {
      byDay[Number(key)].sort((a, b) => {
        const aMin = a.startHour * 60 + a.startMinute;
        const bMin = b.startHour * 60 + b.startMinute;
        return aMin - bMin;
      });
    }
    return byDay;
  }, [timedBlocks]);

  const allDayByDay = useMemo(() => {
    const byDay: Record<number, AllDayBlock[]> = {};
    for (let i = 0; i < DAYS_PER_WEEK; i++) byDay[i] = [];
    for (const b of allDayBlocks) byDay[b.day].push(b);
    return byDay;
  }, [allDayBlocks]);

  const busyByDay = useMemo(() => {
    const byDay: Record<number, BusyBlock[]> = {};
    for (let i = 0; i < DAYS_PER_WEEK; i++) byDay[i] = [];
    for (const b of busyBlocksData) byDay[b.day].push(b);
    return byDay;
  }, [busyBlocksData]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const handleToggleSearch = useCallback(() => {
    if (searchOpen) setSearchQuery("");
    setSearchOpen(!searchOpen);
  }, [searchOpen]);

  const query = searchQuery.trim().toLowerCase();
  const dayTimed = useMemo(() => {
    const all = blocksByDay[selectedDay.index] ?? [];
    return query ? all.filter((b) => b.title.toLowerCase().includes(query)) : all;
  }, [blocksByDay, selectedDay, query]);
  const dayAllDay = useMemo(() => {
    const all = allDayByDay[selectedDay.index] ?? [];
    return query ? all.filter((b) => b.title.toLowerCase().includes(query)) : all;
  }, [allDayByDay, selectedDay, query]);
  const dayBusy = useMemo(() => busyByDay[selectedDay.index] ?? [], [busyByDay, selectedDay]);

  const dayCounts = useMemo(() => {
    const taskCount = dayTimed.filter((b) => !b.isCalendarEvent).length + dayAllDay.length;
    const busyCount = dayTimed.filter((b) => b.isCalendarEvent).length + dayBusy.length;
    return { tasks: taskCount, busy: busyCount };
  }, [dayTimed, dayAllDay, dayBusy]);
  const dayHeading = selectedDay.isToday
    ? "Today's to-do list"
    : `${selectedDay.date.toLocaleDateString("en-US", { weekday: "long" })}'s to-do list`;
  const dayIsEmpty = dayTimed.length === 0 && dayAllDay.length === 0 && dayBusy.length === 0;

  const agendaDays = useMemo<AgendaDay[]>(
    () =>
      days.map((day) => {
        const timed = blocksByDay[day.index] ?? [];
        const allDay = allDayByDay[day.index] ?? [];
        return {
          day,
          timed: query ? timed.filter((b) => b.title.toLowerCase().includes(query)) : timed,
          allDay: query ? allDay.filter((b) => b.title.toLowerCase().includes(query)) : allDay,
          busy: busyByDay[day.index] ?? [],
        };
      }),
    [days, blocksByDay, allDayByDay, busyByDay, query]
  );
  const weekCounts = useMemo(() => {
    let taskCount = 0;
    let busyCount = 0;
    for (const { timed, allDay, busy } of agendaDays) {
      taskCount += timed.filter((b) => !b.isCalendarEvent).length + allDay.length;
      busyCount += timed.filter((b) => b.isCalendarEvent).length + busy.length;
    }
    return { tasks: taskCount, busy: busyCount };
  }, [agendaDays]);
  const weekHeading = `Week of ${days[0].date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const heading = range === "week" ? weekHeading : dayHeading;
  const counts = range === "week" ? weekCounts : dayCounts;

  const [showSlotMenu, setShowSlotMenu] = useState(false);
  const [menuSlotDate, setMenuSlotDate] = useState<Date | null>(null);
  const [menuSlotHour, setMenuSlotHour] = useState<number>(9);
  // opened by the header's plus, so the sheet says where its hour came from
  const [menuPickedTheHour, setMenuPickedTheHour] = useState(false);
  // the busy form renders inside this sheet, not a second one: iOS won't present a Modal
  // over a Modal still on screen, and the attempt leaves an invisible sheet that swallows touches
  const [showBusyForm, setShowBusyForm] = useState(false);

  const handleBlockPress = useCallback((block: TimedBlock) => {
    if (block.isCalendarEvent) return;
    router.push(`/task/${block.taskId}`);
  }, []);

  const handleStartFocus = useCallback((block: TimedBlock) => {
    if (block.isCalendarEvent) return;
    router.push({ pathname: "/focus/session", params: { taskId: block.taskId } });
  }, []);

  const handleAllDayPress = useCallback((pill: AllDayBlock) => {
    router.push(`/task/${pill.taskId}`);
  }, []);

  const handleLongPressSlot = useCallback(
    (dayIndex: number, hour: number) => {
      const date = addDays(weekStart, dayIndex);
      date.setHours(hour, 0, 0, 0);
      setMenuSlotDate(date);
      setMenuSlotHour(hour);
      setMenuPickedTheHour(false);
      setShowBusyForm(false);
      setShowSlotMenu(true);
    },
    [weekStart]
  );

  // same sheet as a long press, on the next free hour. the sheet says the hour was the
  // next free one so it doesn't read as a time picked at random
  const handleAddForSelectedDay = useCallback(() => {
    const taken = takenHours(blocksByDay[selectedDay.index] ?? [], dayBusy);
    const from = selectedDay.isToday
      ? Math.min(END_HOUR - 1, Math.max(START_HOUR, new Date().getHours() + 1))
      : START_HOUR;
    let hour = from;
    for (let h = from; h < END_HOUR; h++) {
      if (!taken.has(h)) {
        hour = h;
        break;
      }
    }
    const date = addDays(weekStart, selectedDay.index);
    date.setHours(hour, 0, 0, 0);
    setMenuSlotDate(date);
    setMenuSlotHour(hour);
    setMenuPickedTheHour(true);
    setShowBusyForm(false);
    setShowSlotMenu(true);
  }, [blocksByDay, dayBusy, selectedDay, weekStart]);

  const handleSlotAddTask = useCallback(() => {
    if (!menuSlotDate) return;
    setShowSlotMenu(false);
    router.push({
      pathname: "/task/new",
      params: { prefillStart: menuSlotDate.toISOString() },
    });
  }, [menuSlotDate]);

  const handleSaveBusy = useCallback(
    (event: Parameters<typeof addCalendarEvent>[0]) => {
      addCalendarEvent(event);
      setShowBusyForm(false);
      setShowSlotMenu(false);
    },
    [addCalendarEvent]
  );

  // dragging pins the block, so the scheduler never moves it again
  const handleTimedBlockDrop = useCallback(
    (block: TimedBlock, newPixelY: number) => {
      // a per-step block shares its parent's start time, and dragging it would move every sibling
      if (!block.isTypeA) return;
      const { hour, minute } = pixelToTime(newPixelY);
      const parentTask = tasks.find((t) => t.id === block.taskId);
      if (!parentTask) return;
      const newStartTime = buildStartTimeISO(parentTask.dueDate, hour, minute);
      updateTask(block.taskId, { startTime: newStartTime, scheduleStatus: "pinned" });
    },
    [tasks, updateTask]
  );

  const handleAllDayBlockDrop = useCallback(
    (block: AllDayBlock, newDayIndex: number) => {
      const clampedDay = Math.max(0, Math.min(6, newDayIndex));
      const newDueDate = buildDueDateISO(weekStart, clampedDay);
      updateTask(block.taskId, { dueDate: newDueDate });
    },
    [weekStart, updateTask]
  );

  const markedDates = useMemo(() => {
    const c = colors[scheme];
    const marks: Record<
      string,
      { marked?: boolean; dotColor?: string; selected?: boolean; selectedColor?: string; selectedTextColor?: string }
    > = {};
    for (const task of tasks) {
      if (task.status === "complete") continue;
      // local day, not UTC, so a task due 11:59 pm marks the day the user sees
      const dateKey = toDateKey(new Date(task.dueDate));
      marks[dateKey] = { marked: true, dotColor: c.accent };
    }
    const selectedKey = toDateKey(selectedDay.date);
    marks[selectedKey] = {
      ...(marks[selectedKey] ?? {}),
      selected: true,
      selectedColor: c.selectedLight,
      selectedTextColor: c.selectedDark,
    };
    return marks;
  }, [tasks, scheme, selectedDay]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Screen>
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <ScreenHeader
            title="Schedule"
            right={
              <CircleButtonPair>
                <CircleButton
                  icon="add"
                  onPress={handleAddForSelectedDay}
                  accessibilityLabel="Add to this day"
                  accessibilityHint="Opens add task or mark as busy at the next free hour"
                />
                <CircleButton
                  icon={searchOpen ? "close-outline" : "search-outline"}
                  onPress={handleToggleSearch}
                  accessibilityLabel={searchOpen ? "Hide search" : range === "week" ? "Search this week" : "Search this day"}
                  accessibilityHint={range === "week" ? "Filters the week by title" : "Filters the day by title"}
                />
              </CircleButtonPair>
            }
          />

          <View style={{ paddingHorizontal: spacing.sm, marginTop: spacing.lg }}>
            <MonthCard label={monthLabel} expanded={mode === "month"} onToggle={handleToggleMonth}>
              {mode === "week" ? (
                <WeekStrip days={weekStripDays} onSelect={handleSelectDay} />
              ) : (
                <MonthGrid
                  markedDates={markedDates}
                  scheme={scheme}
                  initialDate={toDateKey(selectedDay.date)}
                  onDayPress={handleMonthDayPress}
                />
              )}
            </MonthCard>
          </View>

          {searchOpen && (
            <View style={{ paddingHorizontal: spacing.base, marginTop: spacing.base }}>
              <Input
                label="Search"
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Filter by title"
                autoFocus
                accessibilityLabel={range === "week" ? "Filter the week by title" : "Filter the day by title"}
              />
            </View>
          )}

          <View style={{ paddingHorizontal: spacing.base, marginTop: spacing.xl }}>
            <View className="flex-row items-center" style={{ gap: spacing.md }}>
              <Text
                className="flex-1 text-subheading font-medium text-content dark:text-content-dark-primary"
                style={{ letterSpacing: typography.subheading.letterSpacing }}
                accessibilityRole="header"
              >
                {heading}
              </Text>
              <View style={{ width: RANGE_PILL_WIDTH }}>
                <SegmentedPill
                  items={RANGE_ITEMS}
                  value={range}
                  onChange={handleRangeChange}
                  accessibilityLabel="Schedule range: one day or the whole week"
                />
              </View>
            </View>
            <View className="flex-row" style={{ gap: spacing.sm, marginTop: spacing.md }}>
              <Chip size="md" label={`${counts.tasks} ${counts.tasks === 1 ? "Task" : "Tasks"}`} />
              <Chip size="md" label={`${counts.busy} Busy`} />
            </View>
          </View>

          <DaySwipe onSwipe={handleSwipe} unit={range === "week" ? "week" : "day"}>
            {(daySwipeGesture) =>
              range === "week" ? (
                <WeekAgenda
                  days={agendaDays}
                  onSelectDay={handleAgendaSelectDay}
                  onBlockPress={handleBlockPress}
                  onStartFocus={handleStartFocus}
                  onAllDayPress={handleAllDayPress}
                />
              ) : (
                <DayTrack
                  day={selectedDay}
                  trackWidth={trackWidth}
                  timedBlocks={dayTimed}
                  allDayBlocks={dayAllDay}
                  busyBlocks={dayBusy}
                  isEmpty={dayIsEmpty}
                  daySwipeGesture={daySwipeGesture}
                  onBlockPress={handleBlockPress}
                  onStartFocus={handleStartFocus}
                  onAllDayPress={handleAllDayPress}
                  onLongPressSlot={handleLongPressSlot}
                  onTimedBlockDrop={handleTimedBlockDrop}
                  onAllDayBlockDrop={handleAllDayBlockDrop}
                />
              )
            }
          </DaySwipe>
        </ScrollView>

        <SheetFrame
          visible={showSlotMenu}
          title={
            showBusyForm
              ? "Add busy time"
              : menuSlotDate
                ? `${menuSlotDate.toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })} at ${formatTime(menuSlotHour, 0)}`
                : ""
          }
          onClose={() => setShowSlotMenu(false)}
          closeLabel="Close"
          scroll={showBusyForm}
        >
          {showBusyForm ? (
            <AddEventForm
              onSubmit={handleSaveBusy}
              onCancel={() => setShowBusyForm(false)}
              initialDate={menuSlotDate ?? undefined}
              initialStart={menuSlotDate ?? undefined}
            />
          ) : (
            <View style={{ gap: spacing.sm }}>
              {menuPickedTheHour ? (
                <Text
                  className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
                  style={{ marginBottom: spacing.xs }}
                >
                  The next free hour on this day. You can change it on the next screen.
                </Text>
              ) : null}
              <Button
                title="Add task"
                variant="primary"
                onPress={handleSlotAddTask}
                accessibilityLabel="Add a task at this time"
              />
              <Button
                title="Mark as busy"
                variant="secondary"
                onPress={() => setShowBusyForm(true)}
                accessibilityLabel="Mark this time as busy"
              />
            </View>
          )}
        </SheetFrame>
      </Screen>
    </GestureHandlerRootView>
  );
}

interface DaySwipeProps {
  // left swipe is +1 (forward)
  onSwipe: (direction: 1 | -1) => void;
  unit: "day" | "week";
  // a render prop so block drag gestures can be simultaneousWithExternalGesture with this pan.
  // otherwise the pan reaches `began` on touch-down and finger jitter fails the long press
  children: (daySwipeGesture: PanGesture) => React.ReactNode;
}

// activates on horizontal travel and fails on vertical, so the ScrollView keeps vertical
// scrolling. under reduce motion the day changes in place with no follow or slide
function DaySwipe({ onSwipe, unit, children }: DaySwipeProps) {
  const reduceMotion = useReducedMotion();
  const { width } = useWindowDimensions();
  const translateX = useSharedValue(0);
  const opacity = useSharedValue(1);

  const commit = useCallback(
    (direction: 1 | -1) => {
      Haptics.selectionAsync().catch(() => {});
      onSwipe(direction);
    },
    [onSwipe]
  );

  const swipe = Gesture.Pan()
    .activeOffsetX([-SWIPE_ACTIVATE, SWIPE_ACTIVATE])
    .failOffsetY([-SWIPE_FAIL_Y, SWIPE_FAIL_Y])
    .onUpdate((e) => {
      "worklet";
      if (reduceMotion) return;
      translateX.value = followX(e.translationX, width * SWIPE_FOLLOW_FRACTION);
    })
    .onEnd((e) => {
      "worklet";
      const past =
        Math.abs(e.translationX) >= width * SWIPE_COMMIT_FRACTION ||
        Math.abs(e.velocityX) >= SWIPE_COMMIT_VELOCITY;
      if (!past) {
        translateX.value = reduceMotion ? 0 : withSpring(0, springs.settle);
        return;
      }
      const direction: 1 | -1 = e.translationX < 0 ? 1 : -1;
      if (reduceMotion) {
        runOnJS(commit)(direction);
        return;
      }
      // leaving accelerates and arriving decelerates, like every sheet. decelerating both
      // made the outgoing day look set down rather than thrown
      const leaving = Easing.in(Easing.cubic);
      const arriving = Easing.out(Easing.cubic);
      const exit = width * SWIPE_EXIT_FRACTION;
      opacity.value = withTiming(0, { duration: motion.exit, easing: leaving });
      translateX.value = withTiming(-direction * exit, { duration: motion.exit, easing: leaving }, (finished) => {
        if (!finished) return;
        runOnJS(commit)(direction);
        translateX.value = direction * exit;
        translateX.value = withTiming(0, { duration: motion.enter, easing: arriving });
        opacity.value = withTiming(1, { duration: motion.enter, easing: arriving });
      });
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    opacity: opacity.value,
  }));

  return (
    <GestureDetector gesture={swipe}>
      <Reanimated.View
        style={animatedStyle}
        accessibilityHint={`Swipe left for the next ${unit}, right for the previous ${unit}. The week strip above does the same.`}
      >
        {children(swipe)}
      </Reanimated.View>
    </GestureDetector>
  );
}

function NoAgendaRow({ style }: { style?: object }) {
  return (
    <View
      className="justify-center rounded-lg bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark"
      style={[{ height: NO_AGENDA_HEIGHT, borderWidth: HAIRLINE, paddingHorizontal: spacing.md }, style]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary" numberOfLines={1}>
        No agenda
      </Text>
    </View>
  );
}

function BusyCardBody({ block, style }: { block: BusyBlock; style?: object }) {
  return (
    <View
      className="rounded-lg overflow-hidden bg-surface-elevated dark:bg-surface-dark-elevated"
      style={[{ padding: spacing.md }, style]}
    >
      <Text className="text-small font-medium text-content-secondary dark:text-content-dark-secondary">Busy</Text>
      <Text
        className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
        style={{ fontVariant: ["tabular-nums"] }}
        numberOfLines={1}
      >
        {formatRange(block.startHour, block.startMinute, block.durationMinutes)}
      </Text>
    </View>
  );
}

interface BlockCardProps {
  block: TimedBlock;
  showTime: boolean;
  // already sliced by the caller
  steps: readonly Subtask[];
  hasPlay: boolean;
  // set in the week agenda, where the disc is its own button. the track reads the corner tap instead
  onPlayPress?: () => void;
  // one line for the title and every row on the tracks, where height is the duration and can't grow
  clampRows?: boolean;
  style?: object;
}

function BlockCard({ block, showTime, steps, hasPlay, onPlayPress, clampRows = false, style }: BlockCardProps) {
  const isProposed = !!block.isProposed;
  const isCalendarEvent = !!block.isCalendarEvent;

  // proposed is dashed and tinted, never colour alone
  const blockColorClass = isCalendarEvent
    ? "bg-surface-elevated dark:bg-surface-dark-elevated"
    : isProposed
    ? "bg-accent-light dark:bg-accent-bright-light border-dashed border-accent dark:border-accent-bright"
    : "bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark";
  const blockBorderWidth = isCalendarEvent ? 0 : HAIRLINE;

  const titleColorClass = isProposed
    ? "text-accent-dark dark:text-accent-bright-dark"
    : "text-content dark:text-content-dark-primary";
  const metaColorClass = isProposed
    ? "text-accent-dark dark:text-accent-bright-dark"
    : "text-content-secondary dark:text-content-dark-secondary";
  const range = formatRange(block.startHour, block.startMinute, block.durationMinutes);
  const playSlop = Math.max(0, (TOUCH_TARGET_MIN - PLAY_SIZE) / 2);

  return (
    <View
      className={`flex-1 rounded-lg overflow-hidden ${blockColorClass}`}
      style={[{ borderWidth: blockBorderWidth, padding: spacing.md }, style]}
    >
      <View className="flex-row items-start">
        <View className="flex-1">
          {isCalendarEvent && (
            <Text className="text-small font-medium text-content-secondary dark:text-content-dark-secondary" numberOfLines={1}>
              Busy
            </Text>
          )}
          {isProposed && (
            <Text className={`text-small font-medium ${metaColorClass}`} numberOfLines={1}>
              Suggested
            </Text>
          )}
          <Text
            numberOfLines={clampRows ? 1 : 2}
            className={`text-body font-medium ${titleColorClass}`}
            style={block.isComplete ? { textDecorationLine: "line-through" } : undefined}
          >
            {block.title}
          </Text>
          {showTime && (
            <Text
              numberOfLines={1}
              className={`text-caption font-sans ${metaColorClass}`}
              style={{ fontVariant: ["tabular-nums"] }}
            >
              {range}
              {block.subtaskCount && block.subtaskCount > 0 ? ` · ${block.subtaskCount} steps` : ""}
            </Text>
          )}
        </View>
        {hasPlay && onPlayPress && (
          <Pressable
            onPress={onPlayPress}
            hitSlop={playSlop}
            className="items-center justify-center rounded-full bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark active:bg-surface-elevated dark:active:bg-surface-dark-elevated"
            style={{ width: PLAY_SIZE, height: PLAY_SIZE, borderWidth: HAIRLINE, marginLeft: spacing.sm }}
            accessibilityRole="button"
            accessibilityLabel={`Start focus session for ${block.title}`}
          >
            <Ionicons name="play" size={ICON_SIZE.chip} className="text-content dark:text-content-dark-primary" />
          </Pressable>
        )}
        {hasPlay && !onPlayPress && (
          <View
            className="items-center justify-center rounded-full bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark"
            style={{ width: PLAY_SIZE, height: PLAY_SIZE, borderWidth: HAIRLINE, marginLeft: spacing.sm }}
            accessible={false}
            importantForAccessibility="no-hide-descendants"
          >
            <Ionicons name="play" size={ICON_SIZE.chip} className="text-content dark:text-content-dark-primary" />
          </View>
        )}
      </View>
      {steps.length > 0 && (
        <View style={{ marginTop: spacing.sm }}>
          {steps.map((step) => (
            <ChecklistRow
              key={step.id}
              title={step.title}
              checked={step.isComplete}
              titleLines={clampRows ? 1 : undefined}
            />
          ))}
        </View>
      )}
    </View>
  );
}

interface WeekAgendaProps {
  days: readonly AgendaDay[];
  onSelectDay: (index: number) => void;
  onBlockPress: (b: TimedBlock) => void;
  onStartFocus: (b: TimedBlock) => void;
  onAllDayPress: (pill: AllDayBlock) => void;
}

type AgendaItem = { kind: "busy"; block: BusyBlock } | { kind: "timed"; block: TimedBlock };

function agendaItems(timed: readonly TimedBlock[], busy: readonly BusyBlock[]): AgendaItem[] {
  const items: AgendaItem[] = [
    ...busy.map((block): AgendaItem => ({ kind: "busy", block })),
    ...timed.map((block): AgendaItem => ({ kind: "timed", block })),
  ];
  return items.sort(
    (a, b) => a.block.startHour * 60 + a.block.startMinute - (b.block.startHour * 60 + b.block.startMinute)
  );
}

function WeekAgenda({ days, onSelectDay, onBlockPress, onStartFocus, onAllDayPress }: WeekAgendaProps) {
  return (
    <View style={{ paddingHorizontal: spacing.base, marginTop: spacing.sm, gap: spacing.md }}>
      {days.map(({ day, timed, allDay, busy }) => {
        const items = agendaItems(timed, busy);
        const longDate = day.date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
        return (
          <View key={day.index}>
            <Pressable
              onPress={() => onSelectDay(day.index)}
              className="flex-row items-center justify-between rounded-sm"
              style={{ minHeight: TOUCH_TARGET_MIN }}
              accessibilityRole="button"
              accessibilityLabel={`${longDate}${day.isToday ? ", today" : ""}`}
              accessibilityHint="Shows this day as a timeline"
            >
              <Text
                className="text-small font-medium uppercase text-content-secondary dark:text-content-dark-secondary"
                style={{ letterSpacing: UPPERCASE_TRACKING }}
              >
                {longDate}
                {day.isToday ? " · Today" : ""}
              </Text>
              <Ionicons
                name="chevron-forward"
                size={ICON_SIZE.inline}
                className="text-content-secondary dark:text-content-dark-secondary"
              />
            </Pressable>
            <View style={{ gap: spacing.sm }}>
              {allDay.length > 0 && (
                <View className="flex-row flex-wrap" style={{ gap: spacing.sm }}>
                  {allDay.map((pill) => (
                    <Chip
                      key={pill.id}
                      size="md"
                      label={pill.title}
                      onPress={() => onAllDayPress(pill)}
                      accessibilityLabel={`${pill.title}, all day task`}
                      accessibilityHint="Opens task details"
                    />
                  ))}
                </View>
              )}
              {items.length === 0 && allDay.length === 0 && <NoAgendaRow />}
              {items.map((item) =>
                item.kind === "busy" ? (
                  <View
                    key={item.block.id}
                    accessibilityLabel={`Busy, ${formatRange(item.block.startHour, item.block.startMinute, item.block.durationMinutes)}`}
                  >
                    <BusyCardBody block={item.block} />
                  </View>
                ) : (
                  <AgendaBlock
                    key={item.block.id}
                    block={item.block}
                    onPress={() => onBlockPress(item.block)}
                    onStartFocus={item.block.isCalendarEvent ? undefined : () => onStartFocus(item.block)}
                  />
                )
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

interface AgendaBlockProps {
  block: TimedBlock;
  onPress: () => void;
  onStartFocus?: () => void;
}

function AgendaBlock({ block, onPress, onStartFocus }: AgendaBlockProps) {
  const isCalendarEvent = !!block.isCalendarEvent;
  const hasPlay = Boolean(onStartFocus) && !isCalendarEvent;
  const range = formatRange(block.startHour, block.startMinute, block.durationMinutes);
  const steps = (block.subtasks ?? []).slice(0, CHECKLIST_ROWS);
  return (
    <Pressable
      onPress={onPress}
      disabled={isCalendarEvent}
      style={[{ minHeight: TOUCH_TARGET_MIN }, isCalendarEvent ? undefined : shadows.sm]}
      accessibilityRole={isCalendarEvent ? undefined : "button"}
      accessibilityLabel={`${block.title}, ${range}${isCalendarEvent ? ", busy" : ""}${
        block.isProposed ? ", suggested time" : ""
      }${block.isComplete ? ", completed" : ""}`}
      accessibilityHint={isCalendarEvent ? undefined : "Opens task details"}
    >
      <BlockCard block={block} showTime steps={steps} hasPlay={hasPlay} onPlayPress={onStartFocus} />
    </Pressable>
  );
}

interface DayTrackProps {
  day: DayModel;
  trackWidth: number;
  timedBlocks: TimedBlock[];
  allDayBlocks: AllDayBlock[];
  busyBlocks: BusyBlock[];
  isEmpty: boolean;
  // block drag gestures must be simultaneous with this pan, see DaySwipe
  daySwipeGesture: PanGesture;
  onBlockPress: (b: TimedBlock) => void;
  onStartFocus: (b: TimedBlock) => void;
  onAllDayPress: (pill: AllDayBlock) => void;
  onLongPressSlot: (dayIndex: number, hour: number) => void;
  onTimedBlockDrop: (block: TimedBlock, newPixelY: number) => void;
  onAllDayBlockDrop: (block: AllDayBlock, newDayIndex: number) => void;
}

function DayTrack({
  day,
  trackWidth,
  timedBlocks,
  allDayBlocks,
  busyBlocks,
  isEmpty,
  daySwipeGesture,
  onBlockPress,
  onStartFocus,
  onAllDayPress,
  onLongPressSlot,
  onTimedBlockDrop,
  onAllDayBlockDrop,
}: DayTrackProps) {
  const columnLayout = useMemo(() => computeColumnLayout(timedBlocks), [timedBlocks]);
  // one day on screen, so an all-day drag moves a day per strip disc pitch
  const allDayPitch = trackWidth / DAYS_PER_WEEK;
  // same widened gutter as TimeGutter at large Dynamic Type
  const { fontScale } = useWindowDimensions();
  const gutterWidth = getGutterWidth(fontScale);

  return (
    <View style={{ paddingHorizontal: spacing.base, marginTop: spacing.lg }}>
      {allDayBlocks.length > 0 && (
        <View className="flex-row items-start" style={{ marginBottom: spacing.md }}>
          <View style={{ width: gutterWidth, paddingRight: spacing.sm }}>
            <Text className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary text-right">
              All day
            </Text>
          </View>
          <View className="flex-1 flex-row flex-wrap" style={{ gap: spacing.sm }}>
            {allDayBlocks.map((pill) => (
              <DraggableAllDayPill
                key={pill.id}
                pill={pill}
                dayPitch={allDayPitch}
                daySwipeGesture={daySwipeGesture}
                onPress={() => onAllDayPress(pill)}
                onDrop={(newDayIndex) => onAllDayBlockDrop(pill, newDayIndex)}
              />
            ))}
          </View>
        </View>
      )}

      <View style={{ height: GRID_HEIGHT + LAST_LABEL_HEIGHT }}>
        {Array.from({ length: TOTAL_HOURS + 1 }, (_, i) => (
          <View
            key={`gutter-${i}`}
            pointerEvents="none"
            style={{ position: "absolute", top: i * HOUR_HEIGHT, left: 0, right: 0 }}
          >
            <TimeGutter hour={START_HOUR + i} />
          </View>
        ))}

        {Array.from({ length: TOTAL_HOURS }, (_, i) => {
          const hour = START_HOUR + i;
          return (
            <Pressable
              key={`slot-${hour}`}
              onLongPress={() => onLongPressSlot(day.index, hour)}
              style={{
                position: "absolute",
                top: i * HOUR_HEIGHT + RULE_OFFSET,
                left: gutterWidth,
                right: 0,
                height: HOUR_HEIGHT,
              }}
              accessibilityRole="button"
              accessibilityLabel={`Add task at ${formatTime(hour, 0)}`}
              accessibilityHint="Long press to create a task at this time"
            />
          );
        })}

        {isEmpty && (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: gutterWidth,
              right: 0,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text
              className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
              accessibilityLabel="Nothing scheduled. Add a task and Uncoil will suggest a time."
            >
              Nothing scheduled
            </Text>
          </View>
        )}

        {busyBlocks.map((b) => {
          const top = topForTime(b.startHour, b.startMinute) + RULE_OFFSET;
          const height = heightForDuration(b.durationMinutes);
          return (
            <View
              key={b.id}
              style={{ position: "absolute", top, left: gutterWidth, right: 0, height, zIndex: 1 }}
              accessibilityLabel={`Busy, ${formatRange(b.startHour, b.startMinute, b.durationMinutes)}`}
            >
              <BusyCardBody block={b} style={{ flex: 1, marginBottom: BLOCK_GAP }} />
            </View>
          );
        })}

        {timedBlocks.map((b) => {
          const top = topForTime(b.startHour, b.startMinute);
          const height = heightForDuration(b.durationMinutes);
          const colInfo = columnLayout.get(b.id) ?? { col: 0, totalCols: 1 };
          const colWidth = trackWidth / colInfo.totalCols;
          const blockLeft = gutterWidth + Math.round(colInfo.col * colWidth);
          const blockRight = Math.round(trackWidth - (colInfo.col + 1) * colWidth) + (colInfo.totalCols > 1 ? BLOCK_GAP : 0);
          return (
            <DraggableTimedBlock
              key={b.id}
              block={b}
              top={top}
              height={height}
              blockLeft={blockLeft}
              blockRight={blockRight}
              daySwipeGesture={daySwipeGesture}
              onPress={() => onBlockPress(b)}
              onStartFocus={b.isCalendarEvent ? undefined : () => onStartFocus(b)}
              onDrop={(newPixelY) => onTimedBlockDrop(b, newPixelY)}
            />
          );
        })}
      </View>
    </View>
  );
}

interface DraggableAllDayPillProps {
  pill: AllDayBlock;
  dayPitch: number;
  daySwipeGesture: PanGesture;
  onPress: () => void;
  onDrop: (newDayIndex: number) => void;
}

function DraggableAllDayPill({ pill, dayPitch, daySwipeGesture, onPress, onDrop }: DraggableAllDayPillProps) {
  const reduceMotion = useReducedMotion();
  const isDragging = useSharedValue(false);
  const translateX = useSharedValue(0);
  const offsetXAtStart = useSharedValue(0);
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);

  const triggerHapticPickup = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  }, []);

  const triggerHapticDrop = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  const commitDrop = useCallback(
    (totalX: number) => {
      const targetDayDelta = Math.round(totalX / dayPitch);
      const newDayIndex = pill.day + targetDayDelta;
      onDrop(newDayIndex);
      triggerHapticDrop();
    },
    [pill.day, dayPitch, onDrop, triggerHapticDrop]
  );

  const longPress = Gesture.LongPress()
    .minDuration(500)
    .maxDistance(DRAG_CANCEL_DISTANCE)
    .simultaneousWithExternalGesture(daySwipeGesture)
    .onStart(() => {
      "worklet";
      isDragging.value = true;
      offsetXAtStart.value = translateX.value;
      runOnJS(triggerHapticPickup)();
    });

  // activated by hand once the long press picks the chip up. before that, moving past
  // DRAG_CANCEL_DISTANCE fails it, so a scroll or day swipe starting here goes to its owner
  const pan = Gesture.Pan()
    .manualActivation(true)
    .simultaneousWithExternalGesture(daySwipeGesture)
    .onTouchesDown((e) => {
      "worklet";
      const t = e.allTouches[0];
      if (!t) return;
      touchStartX.value = t.absoluteX;
      touchStartY.value = t.absoluteY;
    })
    .onTouchesMove((e, state) => {
      "worklet";
      if (isDragging.value) {
        if (e.state !== State.ACTIVE) state.activate();
        return;
      }
      const t = e.allTouches[0];
      if (!t) return;
      const dx = t.absoluteX - touchStartX.value;
      const dy = t.absoluteY - touchStartY.value;
      if (dx * dx + dy * dy > DRAG_CANCEL_DISTANCE * DRAG_CANCEL_DISTANCE) state.fail();
    })
    .onUpdate((e) => {
      "worklet";
      if (!isDragging.value) return;
      translateX.value = offsetXAtStart.value + e.translationX;
    })
    .onEnd((e) => {
      "worklet";
      if (!isDragging.value) {
        return;
      }
      isDragging.value = false;
      const totalX = offsetXAtStart.value + e.translationX;
      translateX.value = reduceMotion ? 0 : withSpring(0, springs.settle);
      runOnJS(commitDrop)(totalX);
    });

  const tap = Gesture.Tap()
    .simultaneousWithExternalGesture(daySwipeGesture)
    .onEnd(() => {
      "worklet";
      if (!isDragging.value) {
        runOnJS(onPress)();
      }
    });

  // Gesture.Sequence isn't in this gesture-handler version, so the pan is gated on isDragging.
  // Simultaneous only relates the handlers inside it, hence simultaneousWithExternalGesture on each
  const composed = Gesture.Simultaneous(longPress, pan, tap);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    opacity: isDragging.value ? 0.8 : 1,
    zIndex: isDragging.value ? 100 : 1,
  }));

  return (
    <GestureDetector gesture={composed}>
      <Reanimated.View
        style={animatedStyle}
        accessible={true}
        accessibilityRole="button"
        accessibilityLabel={`${pill.title}, all day task`}
        accessibilityHint="Opens task details. Long press to drag to a different day"
      >
        <Chip size="md" label={pill.title} />
      </Reanimated.View>
    </GestureDetector>
  );
}

interface DraggableTimedBlockProps {
  block: TimedBlock;
  // before the rule offset
  top: number;
  height: number;
  blockLeft: number;
  blockRight: number;
  daySwipeGesture: PanGesture;
  onPress: () => void;
  onStartFocus?: () => void;
  onDrop: (newPixelY: number) => void;
}

// a tap in the top-right corner starts focus instead of opening the task. both are also accessibility actions
function DraggableTimedBlock({
  block,
  top,
  height,
  blockLeft,
  blockRight,
  daySwipeGesture,
  onPress,
  onStartFocus,
  onDrop,
}: DraggableTimedBlockProps) {
  const reduceMotion = useReducedMotion();
  const isDragging = useSharedValue(false);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const offsetYAtStart = useSharedValue(0);
  const blockWidth = useSharedValue(0);
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);

  const isProposed = !!block.isProposed;
  const isCalendarEvent = !!block.isCalendarEvent;
  const hasPlay = Boolean(onStartFocus) && !isCalendarEvent;

  const triggerHapticPickup = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  }, []);

  const triggerHapticDrop = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  const commitDrop = useCallback(
    (rawTranslateY: number) => {
      const snappedOffset = snapToGrid(rawTranslateY);
      const newPixelY = clampTop(top + snappedOffset, height);
      onDrop(newPixelY);
      triggerHapticDrop();
    },
    [top, height, onDrop, triggerHapticDrop]
  );

  const handleTap = useCallback(
    (inPlayCorner: boolean) => {
      if (inPlayCorner && onStartFocus) {
        onStartFocus();
      } else {
        onPress();
      }
    },
    [onPress, onStartFocus]
  );

  const longPress = Gesture.LongPress()
    .minDuration(500)
    .maxDistance(DRAG_CANCEL_DISTANCE)
    .simultaneousWithExternalGesture(daySwipeGesture)
    .onStart(() => {
      "worklet";
      isDragging.value = true;
      offsetYAtStart.value = translateY.value;
      if (!reduceMotion) scale.value = withSpring(DRAG_SCALE, springs.press);
      runOnJS(triggerHapticPickup)();
    });

  // gated the same way as DraggableAllDayPill's pan
  const pan = Gesture.Pan()
    .manualActivation(true)
    .simultaneousWithExternalGesture(daySwipeGesture)
    .onTouchesDown((e) => {
      "worklet";
      const t = e.allTouches[0];
      if (!t) return;
      touchStartX.value = t.absoluteX;
      touchStartY.value = t.absoluteY;
    })
    .onTouchesMove((e, state) => {
      "worklet";
      if (isDragging.value) {
        if (e.state !== State.ACTIVE) state.activate();
        return;
      }
      const t = e.allTouches[0];
      if (!t) return;
      const dx = t.absoluteX - touchStartX.value;
      const dy = t.absoluteY - touchStartY.value;
      if (dx * dx + dy * dy > DRAG_CANCEL_DISTANCE * DRAG_CANCEL_DISTANCE) state.fail();
    })
    .onUpdate((e) => {
      "worklet";
      if (!isDragging.value) return;
      const raw = offsetYAtStart.value + e.translationY;
      const snapped = snapToGrid(raw);
      const clamped = clampTop(top + snapped, height) - top;
      translateY.value = clamped;
    })
    .onEnd(() => {
      "worklet";
      if (!isDragging.value) return;
      isDragging.value = false;
      const finalTranslate = translateY.value;
      // the store update re-lays the block at its new time, so the offset just returns to zero
      scale.value = reduceMotion ? 1 : withSpring(1, springs.press);
      translateY.value = reduceMotion ? 0 : withTiming(0, { duration: motion.exit });
      runOnJS(commitDrop)(finalTranslate);
    });

  const tap = Gesture.Tap()
    .simultaneousWithExternalGesture(daySwipeGesture)
    .onEnd((e) => {
      "worklet";
      if (isDragging.value) return;
      const inPlayCorner = hasPlay && e.x >= blockWidth.value - PLAY_HIT && e.y <= PLAY_HIT;
      runOnJS(handleTap)(inPlayCorner);
    });

  // composed like DraggableAllDayPill. without the external relation the day swipe failed
  // the long press on device and drag did nothing
  const composed = Gesture.Simultaneous(longPress, pan, tap);

  const restingShadow = isCalendarEvent ? 0 : shadows.sm.shadowOpacity;
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: translateY.value },
      { scale: scale.value },
    ],
    opacity: isDragging.value ? 0.8 : block.isComplete ? 0.5 : 1,
    zIndex: isDragging.value ? 50 : 2,
    shadowOpacity: isDragging.value ? shadows.lg.shadowOpacity : restingShadow,
    shadowRadius: isDragging.value ? shadows.lg.shadowRadius : shadows.sm.shadowRadius,
    elevation: isDragging.value ? shadows.lg.elevation : isCalendarEvent ? 0 : shadows.sm.elevation,
  }));

  const showTime = height >= MIN_HEIGHT_FOR_TIME;
  const steps = showTime ? (block.subtasks ?? []).slice(0, checklistRowsThatFit(height)) : [];
  const range = formatRange(block.startHour, block.startMinute, block.durationMinutes);

  const accessibilityActions = hasPlay
    ? [
        { name: "activate", label: "Open task" },
        { name: "startFocus", label: "Start focus session" },
      ]
    : undefined;

  return (
    <GestureDetector gesture={composed}>
      <Reanimated.View
        style={[
          {
            position: "absolute",
            shadowColor: shadows.sm.shadowColor,
            shadowOffset: shadows.sm.shadowOffset,
            top: top + RULE_OFFSET,
            height,
            left: blockLeft,
            right: blockRight,
          },
          animatedStyle,
        ]}
        onLayout={(e) => {
          blockWidth.value = e.nativeEvent.layout.width;
        }}
        accessibilityRole="button"
        accessibilityLabel={`${block.title}, ${range}${isCalendarEvent ? ", busy" : ""}${
          isProposed ? ", suggested time" : ""
        }${block.isComplete ? ", completed" : ""}. Long press to drag and reschedule.`}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "startFocus") {
            onStartFocus?.();
          } else {
            onPress();
          }
        }}
      >
        <BlockCard block={block} showTime={showTime} steps={steps} hasPlay={hasPlay} clampRows style={{ marginBottom: BLOCK_GAP }} />
      </Reanimated.View>
    </GestureDetector>
  );
}

interface MonthGridProps {
  markedDates: Record<
    string,
    { marked?: boolean; dotColor?: string; selected?: boolean; selectedColor?: string; selectedTextColor?: string }
  >;
  scheme: "light" | "dark";
  initialDate: string;
  onDayPress: (dateString: string) => void;
}

function MonthGrid({ markedDates, scheme, initialDate, onDayPress }: MonthGridProps) {
  const theme = useMemo(() => {
    const c = colors[scheme];
    return {
      backgroundColor: "transparent",
      calendarBackground: "transparent",
      textSectionTitleColor: c.textSecondary,
      dayTextColor: c.text,
      todayTextColor: c.selectedDark,
      monthTextColor: c.text,
      selectedDayBackgroundColor: c.selectedLight,
      selectedDayTextColor: c.selectedDark,
      arrowColor: c.text,
      textDisabledColor: c.textMuted,
      dotColor: c.accent,
      selectedDotColor: c.accent,
      textDayFontFamily: fontFamily.regular,
      textMonthFontFamily: typography.heading.fontFamily,
      textDayHeaderFontFamily: fontFamily.medium,
      textDayFontWeight: typography.caption.fontWeight,
      textMonthFontWeight: typography.heading.fontWeight,
      textDayHeaderFontWeight: typography.small.fontWeight,
      textDayFontSize: typography.caption.fontSize,
      textMonthFontSize: typography.subheading.fontSize,
      textDayHeaderFontSize: typography.small.fontSize,
    };
  }, [scheme]);

  return (
    <RNCalendar
      theme={theme}
      markedDates={markedDates}
      initialDate={initialDate}
      firstDay={1}
      onDayPress={(day) => onDayPress(day.dateString)}
      enableSwipeMonths
    />
  );
}
