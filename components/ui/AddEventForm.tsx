import React, { useEffect, useMemo, useState } from "react";
import { View, Text } from "react-native";
import { Button } from "@/components/ui/Button";
import { DateField } from "@/components/ui/DateField";
import { DateTimePickerCrossPlatform } from "@/components/ui/DateTimePickerCrossPlatform";
import { Input } from "@/components/ui/Input";
import { SelectChip, SelectChipRow } from "@/components/ui/SelectChip";
import { SubPanel } from "@/components/ui/SubPanel";
import { spacing } from "@/utils/design-tokens";
import { formatDeadline, formatHour } from "@/utils/format";
import type { DayKey } from "@/types";

// one-letter chips because "Mon" truncates at seven across. the letters repeat,
// so VoiceOver and the summary sentence use the full name
const DAYS: { key: DayKey; label: string; full: string }[] = [
  { key: "mon", label: "M", full: "Monday" },
  { key: "tue", label: "T", full: "Tuesday" },
  { key: "wed", label: "W", full: "Wednesday" },
  { key: "thu", label: "T", full: "Thursday" },
  { key: "fri", label: "F", full: "Friday" },
  { key: "sat", label: "S", full: "Saturday" },
  { key: "sun", label: "S", full: "Sunday" },
];

type OpenPanel = "none" | "date" | "start" | "end";

// the summary needs exact minutes, the pills only show the hour via formatHour
function toClockLabel(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function toMinutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function toClockValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function toDateValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function plusHour(date: Date): Date {
  return new Date(date.getTime() + 60 * 60 * 1000);
}

function nextHour(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function joinDayNames(days: readonly DayKey[]): string {
  const names = DAYS.filter((d) => days.includes(d.key)).map((d) => d.full);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function describeOneOff(date: Date, start: Date, end: Date): string {
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const monthDay = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${weekday}, ${monthDay}, ${toClockLabel(start)} to ${toClockLabel(end)}`;
}

function describeRepeating(days: readonly DayKey[], start: Date, end: Date): string {
  return `Every ${joinDayNames(days)}, ${toClockLabel(start)} to ${toClockLabel(end)}`;
}

export interface NewBusyTime {
  title: string;
  // YYYY-MM-DD
  date: string;
  // HH:MM, 24-hour
  startTime: string;
  endTime: string;
  repeatDays: DayKey[];
}

export interface AddEventFormProps {
  onSubmit: (event: NewBusyTime) => void;
  onCancel?: () => void;
  // re-read on change, since some hosts keep the form mounted between slots
  initialDate?: Date;
  initialStart?: Date;
}

// no sheet of its own: most hosts are already in a sheet and iOS can't stack a second Modal
export function AddEventForm({ onSubmit, onCancel, initialDate, initialStart }: AddEventFormProps) {
  const [title, setTitle] = useState("");
  const [date, setDate] = useState<Date>(() => initialDate ?? new Date());
  const [startTime, setStartTime] = useState<Date>(() => initialStart ?? nextHour());
  const [endTime, setEndTime] = useState<Date>(() => plusHour(initialStart ?? nextHour()));
  const [repeatDays, setRepeatDays] = useState<DayKey[]>([]);
  const [openPanel, setOpenPanel] = useState<OpenPanel>("none");

  const initialDateMs = initialDate?.getTime();
  const initialStartMs = initialStart?.getTime();
  useEffect(() => {
    if (initialDateMs !== undefined) setDate(new Date(initialDateMs));
  }, [initialDateMs]);
  useEffect(() => {
    if (initialStartMs === undefined) return;
    const start = new Date(initialStartMs);
    setStartTime(start);
    setEndTime(plusHour(start));
  }, [initialStartMs]);

  const invalid = toMinutesOfDay(endTime) <= toMinutesOfDay(startTime);
  const summary = useMemo(
    () =>
      repeatDays.length > 0
        ? describeRepeating(repeatDays, startTime, endTime)
        : describeOneOff(date, startTime, endTime),
    [repeatDays, date, startTime, endTime]
  );

  const handleSubmit = () => {
    if (invalid) return;
    onSubmit({
      title: title.trim() || "Busy",
      date: toDateValue(date),
      startTime: toClockValue(startTime),
      endTime: toClockValue(endTime),
      repeatDays,
    });
  };

  const toggleDay = (key: DayKey) => {
    setRepeatDays((prev) => (prev.includes(key) ? prev.filter((d) => d !== key) : [...prev, key]));
  };

  const togglePanel = (panel: OpenPanel) => {
    setOpenPanel((p) => (p === panel ? "none" : panel));
  };

  // push the end along so the range never goes invalid mid-pick
  const handleStartChange = (selected: Date) => {
    setStartTime(selected);
    if (toMinutesOfDay(endTime) <= toMinutesOfDay(selected)) {
      setEndTime(plusHour(selected));
    }
  };

  return (
    <View className="gap-4">
      <Input
        label="Title (optional)"
        value={title}
        onChangeText={setTitle}
        placeholder="e.g. Soccer practice"
        accessibilityLabel="Event title"
      />

      <View>
        <DateField
          label="Date"
          value={formatDeadline(date.toISOString())}
          onPress={() => togglePanel("date")}
          accessibilityLabel={`Date, ${formatDeadline(date.toISOString())}`}
          accessibilityHint="Opens the date picker"
        />
        {openPanel === "date" && (
          <View style={{ marginTop: spacing.md }}>
            <SubPanel label="Date">
              <DateTimePickerCrossPlatform
                value={date}
                mode="date"
                display="inline"
                onChange={(selected) => setDate(selected)}
                accessibilityLabel="Select date"
              />
            </SubPanel>
          </View>
        )}
      </View>

      <View>
        <View className="flex-row gap-3">
          <View className="flex-1">
            <DateField
              label="Start"
              value={formatHour(startTime.getHours())}
              onPress={() => togglePanel("start")}
              accessibilityLabel={`Start time, ${toClockLabel(startTime)}`}
              accessibilityHint="Opens the start time picker"
            />
          </View>
          <View className="flex-1">
            <DateField
              label="End"
              value={formatHour(endTime.getHours())}
              onPress={() => togglePanel("end")}
              accessibilityLabel={`End time, ${toClockLabel(endTime)}`}
              accessibilityHint="Opens the end time picker"
            />
          </View>
        </View>
        {openPanel === "start" && (
          <View style={{ marginTop: spacing.md }}>
            <SubPanel label="Start time">
              <DateTimePickerCrossPlatform
                value={startTime}
                mode="time"
                display="spinner"
                onChange={handleStartChange}
                accessibilityLabel="Select start time"
              />
            </SubPanel>
          </View>
        )}
        {openPanel === "end" && (
          <View style={{ marginTop: spacing.md }}>
            <SubPanel label="End time">
              <DateTimePickerCrossPlatform
                value={endTime}
                mode="time"
                display="spinner"
                onChange={(selected) => setEndTime(selected)}
                accessibilityLabel="Select end time"
              />
            </SubPanel>
          </View>
        )}
      </View>

      <View>
        <Text
          className="text-caption font-medium text-content-secondary dark:text-content-dark-secondary"
          style={{ marginBottom: spacing.sm }}
        >
          Repeat
        </Text>
        <SelectChipRow accessibilityLabel="Repeat on these weekdays" columns={7}>
          {DAYS.map((day) => (
            <SelectChip
              key={day.key}
              label={day.label}
              selected={repeatDays.includes(day.key)}
              onPress={() => toggleDay(day.key)}
              accessibilityLabel={`Repeat on ${day.full}`}
            />
          ))}
        </SelectChipRow>
      </View>

      <Text
        className={`text-caption font-sans ${
          invalid
            ? "text-danger-dark dark:text-danger-bright"
            : "text-content-secondary dark:text-content-dark-secondary"
        }`}
        accessibilityLiveRegion="polite"
      >
        {invalid ? "End time must be after the start time." : summary}
      </Text>

      <View className="flex-row" style={{ gap: spacing.md, marginTop: spacing.base }}>
        {onCancel ? (
          <Button
            title="Back"
            variant="secondary"
            onPress={onCancel}
            className="flex-1"
            accessibilityLabel="Back"
          />
        ) : null}
        <Button
          title="Add busy time"
          variant="primary"
          onPress={handleSubmit}
          disabled={invalid}
          className="flex-1"
          accessibilityLabel="Save busy time"
        />
      </View>
    </View>
  );
}
