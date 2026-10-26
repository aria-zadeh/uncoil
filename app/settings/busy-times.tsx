import React, { useMemo, useState } from "react";
import { View, Text, ScrollView, Pressable } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { CircleButton } from "@/components/ui/CircleButton";
import { BusyBlockGrid } from "@/components/ui/BusyBlockGrid";
import { AddEventModal } from "@/components/ui/AddEventModal";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { useSettingsStore } from "@/store/runtime";
import { spacing, typography, HAIRLINE, ICON_SIZE, TOUCH_TARGET_MIN } from "@/utils/design-tokens";
import type { CalendarEvent, DayKey } from "@/types";

const TRASH_DISC = spacing.xl + spacing.xs;
const TRASH_SLOP = (TOUCH_TARGET_MIN - TRASH_DISC) / 2;

const DAY_ORDER: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_LABELS: Record<DayKey, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

function formatEventTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "pm" : "am";
  const hour12 = h % 12 || 12;
  return m === 0 ? `${hour12} ${period}` : `${hour12}:${m.toString().padStart(2, "0")} ${period}`;
}

function formatEventDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function formatRepeatDays(days: readonly DayKey[]): string {
  return DAY_ORDER.filter((d) => days.includes(d))
    .map((d) => DAY_LABELS[d])
    .join(", ");
}

function EventRow({ event, subtitle, onDelete }: { event: CalendarEvent; subtitle: string; onDelete: () => void }) {
  return (
    <View className="flex-row items-center" style={{ minHeight: TOUCH_TARGET_MIN }}>
      <Ionicons
        name="calendar-outline"
        size={ICON_SIZE.row}
        className="text-content-secondary dark:text-content-dark-secondary"
      />
      <View className="flex-1" style={{ marginLeft: spacing.md }}>
        <Text className="text-body font-sans text-content dark:text-content-dark-primary" numberOfLines={2}>
          {event.title}
        </Text>
        <Text className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary">
          {subtitle}
        </Text>
      </View>
      <Pressable
        onPress={onDelete}
        className="items-center justify-center rounded-full bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark active:bg-surface-elevated dark:active:bg-surface-dark-elevated"
        style={{ width: TRASH_DISC, height: TRASH_DISC, borderWidth: HAIRLINE, marginLeft: spacing.sm }}
        hitSlop={TRASH_SLOP}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${event.title}`}
      >
        <Ionicons name="trash-outline" size={ICON_SIZE.chip} className="text-danger-dark dark:text-danger-bright" />
      </Pressable>
    </View>
  );
}

export default function BusyTimesScreen() {
  const insets = useSafeAreaInsets();
  const busyBlocks = useSettingsStore((s) => s.busyBlocks);
  const toggleBusyBlock = useSettingsStore((s) => s.toggleBusyBlock);
  const calendarEvents = useSettingsStore((s) => s.calendarEvents);
  const addCalendarEvent = useSettingsStore((s) => s.addCalendarEvent);
  const deleteCalendarEvent = useSettingsStore((s) => s.deleteCalendarEvent);

  const [showAddModal, setShowAddModal] = useState(false);

  // a repeating event's anchor date can be long past while it still occurs, so only one-offs are filtered
  const { repeatingEvents, oneOffEvents } = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const byDateThenTime = (a: CalendarEvent, b: CalendarEvent) =>
      a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime);
    const repeating = calendarEvents.filter((e) => e.repeatDays.length > 0).sort(byDateThenTime);
    const oneOff = calendarEvents
      .filter((e) => e.repeatDays.length === 0 && e.date >= todayStr)
      .sort(byDateThenTime);
    return { repeatingEvents: repeating, oneOffEvents: oneOff };
  }, [calendarEvents]);

  const hasEvents = repeatingEvents.length > 0 || oneOffEvents.length > 0;

  return (
    <Screen>
      <ScreenHeader
        title="Busy times"
        left={<CircleButton icon="chevron-back" onPress={() => router.back()} accessibilityLabel="Go back" />}
      />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: spacing.sm,
          paddingTop: spacing.xl,
          paddingBottom: insets.bottom + spacing.base,
          gap: spacing.sm,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Card padding="base">
          <Text
            className="text-subheading font-medium text-content dark:text-content-dark-primary"
            style={{ letterSpacing: typography.subheading.letterSpacing, marginBottom: spacing.xs }}
            accessibilityRole="header"
          >
            Weekly
          </Text>
          <Text
            className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginBottom: spacing.md }}
          >
            This grid is a rough pattern, like most Tuesday afternoons are gone; an event below is an exact time.
          </Text>
          <BusyBlockGrid busyBlocks={busyBlocks} onToggle={toggleBusyBlock} />
        </Card>

        <Card padding="base">
          <Text
            className="text-subheading font-medium text-content dark:text-content-dark-primary"
            style={{ letterSpacing: typography.subheading.letterSpacing, marginBottom: spacing.xs }}
            accessibilityRole="header"
          >
            Events
          </Text>

          {!hasEvents ? (
            <Text
              className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
              style={{ marginBottom: spacing.md }}
            >
              No busy times yet.
            </Text>
          ) : (
            <>
              {repeatingEvents.length > 0 && (
                <View style={{ marginTop: spacing.sm, marginBottom: spacing.sm }}>
                  <SectionLabel style={{ marginBottom: spacing.sm }}>Repeating</SectionLabel>
                  {repeatingEvents.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      subtitle={`Every ${formatRepeatDays(event.repeatDays)}, ${formatEventTime(event.startTime)} to ${formatEventTime(event.endTime)}`}
                      onDelete={() => deleteCalendarEvent(event.id)}
                    />
                  ))}
                </View>
              )}
              {oneOffEvents.length > 0 && (
                <View style={{ marginTop: spacing.sm, marginBottom: spacing.sm }}>
                  <SectionLabel style={{ marginBottom: spacing.sm }}>One-off</SectionLabel>
                  {oneOffEvents.map((event) => (
                    <EventRow
                      key={event.id}
                      event={event}
                      subtitle={`${formatEventDate(event.date)}, ${formatEventTime(event.startTime)} to ${formatEventTime(event.endTime)}`}
                      onDelete={() => deleteCalendarEvent(event.id)}
                    />
                  ))}
                </View>
              )}
            </>
          )}

          <Button
            title="Add a busy time"
            variant="secondary"
            onPress={() => setShowAddModal(true)}
            accessibilityLabel="Add a busy time"
          />
        </Card>
      </ScrollView>

      <AddEventModal
        visible={showAddModal}
        onClose={() => setShowAddModal(false)}
        onAdd={(event) => addCalendarEvent(event)}
      />
    </Screen>
  );
}
