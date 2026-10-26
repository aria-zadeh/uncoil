import React, { useCallback, useMemo, useState } from "react";
import { View, Text, ScrollView, ActivityIndicator, Linking } from "react-native";
import { router, useFocusEffect } from "expo-router";
import Constants from "expo-constants";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  exportAllData,
  importAllData,
  pickBackupText,
  resetAllData,
  useGenerationStore,
  useNotificationStore,
  useSessionStore,
  useSettingsStore,
} from "@/store/runtime";
import type { BackupParseFailureReason, ModelStatus, ThemePreference } from "@/types";
import { seedDemoData } from "@/store/demoSeed";
import { useInsights } from "@/store/insightsSelectors";
import { Screen } from "@/components/ui/Screen";
import { ScreenHeader } from "@/components/ui/ScreenHeader";
import { CircleButton } from "@/components/ui/CircleButton";
import { IdentityRow } from "@/components/ui/IdentityRow";
import { AnalyticsBar, type AnalyticsSegment } from "@/components/ui/AnalyticsBar";
import { SettingsGroup } from "@/components/ui/SettingsGroup";
import { SettingsRow } from "@/components/ui/SettingsRow";
import { SelectChip, SelectChipRow } from "@/components/ui/SelectChip";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { SheetFrame } from "@/components/ui/SheetFrame";
import type { Glyph } from "@/components/ui/icons";
import { spacing, typography, ICON_SIZE, TAB_BAR_CLEARANCE, TOUCH_TARGET_MIN } from "@/utils/design-tokens";
import { calibrationLine } from "@/utils/calibration";
import { formatHour } from "@/utils/format";
import { PER_HOUR_OPTIONS, QUIET_START_OPTIONS, QUIET_END_OPTIONS } from "@/utils/presets";
import { reminderRowState, type ReminderRowAction } from "@/utils/reminderRow";

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const THEME_ORDER: readonly ThemePreference[] = ["light", "dark", "system"];
const THEME_META: Record<ThemePreference, { label: string; icon: Glyph }> = {
  light: { label: "Light", icon: "sunny-outline" },
  dark: { label: "Dark", icon: "moon-outline" },
  system: { label: "System", icon: "phone-portrait-outline" },
};

const REMINDERS_HINTS: Record<ReminderRowAction, string> = {
  turnOff: "Turns off reminders",
  turnOn: "Turns on reminders",
  requestPermission: "Asks the system for permission to send reminders",
  openSettings: "Opens iOS Settings to turn notifications back on",
};

const FOCUS_CEILING_SECONDS = 5 * 60 * 60;
const STREAK_CEILING_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const FOCUS_WINDOW_DAYS = 7;
const RECENT_SESSION_LIMIT = 10;

const IMPORT_FAILURE_MESSAGES: Record<BackupParseFailureReason, string> = {
  "not-json": "That file is not an Uncoil backup.",
  "wrong-format": "That file is not an Uncoil backup.",
  "newer-format-version": "That backup was made by a newer version of Uncoil.",
  "newer-schema-version": "That backup was made by a newer version of Uncoil.",
  "invalid-shape": "That backup file is damaged.",
  "write-failed": "Saving the imported data did not finish, so your earlier data was kept. Try importing the file again.",
};

// the file itself was fine on write-failed, so it gets its own title
const IMPORT_FAILURE_TITLES: Record<BackupParseFailureReason, string> = {
  "not-json": "Could not import",
  "wrong-format": "Could not import",
  "newer-format-version": "Could not import",
  "newer-schema-version": "Could not import",
  "invalid-shape": "Could not import",
  "write-failed": "Import didn't finish",
};

// "4 to 5 pm"
function formatHourRange(hourOfDay: number): string {
  const next = (hourOfDay + 1) % 24;
  const samePeriod = hourOfDay < 12 === next < 12;
  const start = samePeriod ? String(hourOfDay % 12 === 0 ? 12 : hourOfDay % 12) : formatHour(hourOfDay);
  return `${start} to ${formatHour(next)}`;
}

// "45m", "2h10"
function formatFocus(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}`;
}

function formatSessionDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function modelStatusValue(status: ModelStatus): string {
  switch (status.state) {
    case "loading":
      return "Getting ready";
    case "ready":
      return "Ready";
    case "failed":
      return "General steps";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function appVersionLabel(): string {
  const version = Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "";
  const buildNumber = Constants.nativeBuildVersion ?? Constants.expoConfig?.ios?.buildNumber;
  return buildNumber ? `${version} (${buildNumber})` : version;
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();

  const displayName = useSettingsStore((s) => s.displayName);
  const themePreference = useSettingsStore((s) => s.themePreference);
  const maxNotificationsPerHour = useSettingsStore((s) => s.maxNotificationsPerHour);
  const quietHoursStart = useSettingsStore((s) => s.quietHoursStart);
  const quietHoursEnd = useSettingsStore((s) => s.quietHoursEnd);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const modelStatus = useGenerationStore((s) => s.status);
  const sessions = useSessionStore((s) => s.sessions);

  const [showMaxNotifPicker, setShowMaxNotifPicker] = useState(false);
  const [showQuietHoursPicker, setShowQuietHoursPicker] = useState(false);
  const [showSessions, setShowSessions] = useState(false);

  const insights = useInsights();

  const focusSeconds7 = useMemo(() => {
    const cutoff = Date.now() - FOCUS_WINDOW_DAYS * MS_PER_DAY;
    let total = 0;
    for (const s of sessions) {
      if (s.durationSeconds === null) continue;
      if (new Date(s.startedAt).getTime() < cutoff) continue;
      total += s.durationSeconds;
    }
    return total;
  }, [sessions]);

  const recentSessions = useMemo(() => sessions.slice(-RECENT_SESSION_LIMIT).reverse(), [sessions]);

  // each segment is normalised to its own ceiling. the labels carry the numbers, so the bar is decorative
  const segments = useMemo<readonly AnalyticsSegment[]>(() => {
    const done = insights.completed7.completed;
    const total = Math.max(insights.completed7.created, done, 1);
    const rate = insights.completionRate30;
    return [
      { key: "done", value: done / total, token: "success", label: "Done this week", display: `${done}` },
      {
        key: "ontime",
        value: rate ?? 0,
        token: "barBlue",
        label: "On time",
        display: rate === null ? "Not yet" : `${Math.round(rate * 100)}%`,
      },
      {
        key: "focus",
        value: Math.min(focusSeconds7 / FOCUS_CEILING_SECONDS, 1),
        token: "barPink",
        label: "Focus this week",
        display: formatFocus(focusSeconds7),
      },
      {
        key: "streak",
        value: Math.min(insights.streak / STREAK_CEILING_DAYS, 1),
        token: "accent",
        label: "Streak",
        display: `${insights.streak} d`,
      },
    ];
  }, [insights, focusSeconds7]);

  const theme = THEME_META[themePreference];
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(themePreference) + 1) % THEME_ORDER.length];
  const cycleAppearance = () => updateSetting("themePreference", nextTheme);

  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const permissionStatus = useNotificationStore((s) => s.permissionStatus);
  const refreshPermissionStatus = useNotificationStore((s) => s.refreshPermissionStatus);
  const requestPermission = useNotificationStore((s) => s.requestPermission);
  const [isRequestingReminders, setIsRequestingReminders] = useState(false);

  // re-checked on every focus so coming back from iOS Settings updates the row
  useFocusEffect(
    useCallback(() => {
      void refreshPermissionStatus();
    }, [refreshPermissionStatus]),
  );

  const reminders = useMemo(
    () => reminderRowState(permissionStatus, notificationsEnabled),
    [permissionStatus, notificationsEnabled],
  );

  const handleRemindersPress = async () => {
    switch (reminders.action) {
      case "turnOff":
        updateSetting("notificationsEnabled", false);
        return;
      case "turnOn":
        updateSetting("notificationsEnabled", true);
        return;
      case "openSettings":
        // the OS won't show its dialog again once denied, so Settings is the only way back
        void Linking.openSettings();
        return;
      case "requestPermission": {
        if (isRequestingReminders) return;
        setIsRequestingReminders(true);
        const outcome = await requestPermission();
        updateSetting("notificationsEnabled", outcome === "granted");
        setIsRequestingReminders(false);
        return;
      }
      default: {
        const exhaustive: never = reminders.action;
        return exhaustive;
      }
    }
  };

  // two deliberate taps before anything is deleted: the row opens a warning, its Continue reveals the delete
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [isDeletingAllData, setIsDeletingAllData] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  const closeDeleteFlow = () => {
    if (isDeletingAllData) return;
    setDeleteStep(0);
    setDeleteError(false);
  };

  const handleConfirmDeleteAllData = async () => {
    setIsDeletingAllData(true);
    setDeleteError(false);
    try {
      await resetAllData();
      setDeleteStep(0);
      setIsDeletingAllData(false);
      // the layout guard would redirect anyway, this just makes the destination explicit
      router.replace("/onboarding/welcome");
    } catch {
      setIsDeletingAllData(false);
      setDeleteError(true);
    }
  };

  // the share sheet is the success feedback, only a throw gets a dialog
  const [isExportingData, setIsExportingData] = useState(false);
  const [exportError, setExportError] = useState(false);

  const handleExportData = async () => {
    setIsExportingData(true);
    setExportError(false);
    try {
      await exportAllData();
    } catch {
      setExportError(true);
    } finally {
      setIsExportingData(false);
    }
  };

  // dev builds only. every learned figure is gated on a sample count, so a fresh install
  // shows nothing but counters. demoSeed also refuses to run outside a dev build
  const [seedState, setSeedState] = useState<"idle" | "loading" | "done" | "failed">("idle");

  const handleSeedDemoData = async () => {
    if (seedState === "loading") return;
    setSeedState("loading");
    try {
      const result = await seedDemoData();
      setSeedState(result.ok ? "done" : "failed");
    } catch {
      setSeedState("failed");
    }
  };

  // the result is step 3 of this sheet, not a sibling Modal: swapping two transparent
  // Modals in one commit can drop the presentation on iOS
  type ImportOutcome = Awaited<ReturnType<typeof importAllData>>;
  const [importStep, setImportStep] = useState<0 | 1 | 2 | 3>(0);
  const [pendingImportText, setPendingImportText] = useState<string | null>(null);
  const [isImportingData, setIsImportingData] = useState(false);
  const [importOutcome, setImportOutcome] = useState<ImportOutcome | null>(null);

  // the picker read can throw (temp copy gone, permission), before the parser ever sees the file
  const [isPickingFile, setIsPickingFile] = useState(false);
  // matched by name so app/ doesn't import services/
  const [pickFileError, setPickFileError] = useState<false | "unreadable" | "too-large">(false);

  const closeImportFlow = () => {
    if (isImportingData) return;
    setImportStep(0);
    setPendingImportText(null);
    setImportOutcome(null);
  };

  const handlePressImportData = async () => {
    if (isPickingFile) return;
    setIsPickingFile(true);
    try {
      const text = await pickBackupText();
      if (text === null) return;
      setPendingImportText(text);
      setImportStep(1);
    } catch (error) {
      setPickFileError(error instanceof Error && error.name === "BackupFileTooLargeError" ? "too-large" : "unreadable");
    } finally {
      setIsPickingFile(false);
    }
  };

  const handleConfirmImportData = async () => {
    if (isImportingData) return;
    if (pendingImportText === null) return;
    setIsImportingData(true);
    // no try/catch: importAllData never rejects, every failure is an ok:false result
    const result = await importAllData(pendingImportText);
    setIsImportingData(false);
    setPendingImportText(null);
    setImportOutcome(result);
    setImportStep(3);
  };

  const importTitle =
    importStep === 1
      ? "Replace all data?"
      : importStep === 2
        ? "Are you sure?"
        : importOutcome?.ok
          ? "Import complete"
          : importOutcome
            ? IMPORT_FAILURE_TITLES[importOutcome.reason]
            : "";

  return (
    <Screen>
      <ScreenHeader
        title="My profile"
        right={
          <CircleButton
            icon={theme.icon}
            onPress={cycleAppearance}
            accessibilityLabel={`Appearance: ${theme.label}`}
            accessibilityHint={`Switches to ${THEME_META[nextTheme].label.toLowerCase()}`}
          />
        }
      />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: spacing.sm,
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
          gap: spacing.sm,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingHorizontal: spacing.sm, marginTop: spacing.base, marginBottom: spacing.sm }}>
          <IdentityRow name={displayName?.trim() || "You"} subtitle="Runs on this device" />
        </View>

        <Card padding="base">
          <Text
            className="text-subheading font-medium text-content dark:text-content-dark-primary"
            style={{ letterSpacing: typography.subheading.letterSpacing, marginBottom: spacing.md }}
            accessibilityRole="header"
          >
            Analytics
          </Text>
          <AnalyticsBar segments={segments} />

          {/* below the threshold show progress, not just "still learning": a counter reads as
              working, silence reads as broken */}
          <Text
            className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginTop: spacing.md }}
          >
            {insights.productiveWindow !== null
              ? `Best window: ${WEEKDAY_LABELS[insights.productiveWindow.dayOfWeek]}, ${formatHourRange(insights.productiveWindow.hourOfDay)}, ${Math.round(insights.productiveWindow.completionRate * 100)}% done then`
              : `Learning your best window: ${insights.windowProgress.have} of ${insights.windowProgress.need} logged`}
          </Text>

          {/* its own threshold: only signals with both an estimate and an actual count */}
          <Text
            className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary"
            style={{ marginTop: spacing.xs }}
          >
            {insights.estimateCalibration !== null
              ? calibrationLine(insights.estimateCalibration.ratio)
              : `Learning your time estimates: ${insights.calibrationProgress.have} of ${insights.calibrationProgress.need} logged`}
          </Text>

          <View style={{ marginTop: spacing.xs }}>
            <SettingsRow
              icon="time-outline"
              label="Recent sessions"
              value={`${sessions.length}`}
              onPress={() => setShowSessions(true)}
              accessibilityLabel={`Recent sessions, ${sessions.length}`}
              accessibilityHint="Opens your focus session history"
            />
          </View>
        </Card>

        <SettingsGroup label="Appearance">
          <SelectChipRow accessibilityLabel="Appearance">
            {THEME_ORDER.map((option) => (
              <SelectChip
                key={option}
                label={THEME_META[option].label}
                icon={THEME_META[option].icon}
                selected={themePreference === option}
                onPress={() => updateSetting("themePreference", option)}
                accessibilityLabel={`${THEME_META[option].label} appearance`}
              />
            ))}
          </SelectChipRow>
        </SettingsGroup>

        <SettingsGroup label="Notifications">
          <SettingsRow
            icon="alarm-outline"
            label="Reminders"
            value={reminders.value}
            onPress={handleRemindersPress}
            disabled={isRequestingReminders}
            accessory={
              isRequestingReminders ? (
                <ActivityIndicator size="small" accessibilityLabel="Requesting notification permission" />
              ) : undefined
            }
            accessibilityHint={REMINDERS_HINTS[reminders.action]}
          />
          <SettingsRow
            icon="notifications-outline"
            label="Notifications"
            value={`${maxNotificationsPerHour} per hour`}
            onPress={() => setShowMaxNotifPicker(true)}
            accessibilityHint="Changes the most reminders sent in one hour"
          />
          <SettingsRow
            icon="moon-outline"
            label="Quiet hours"
            value={`${formatHour(quietHoursStart)} to ${formatHour(quietHoursEnd)}`}
            onPress={() => setShowQuietHoursPicker(true)}
            accessibilityHint="Changes when reminders stay silent"
          />
        </SettingsGroup>

        <SettingsGroup label="Planning">
          <SettingsRow icon="time-outline" label="Busy times" onPress={() => router.push("/settings/busy-times")} />
          <SettingsRow
            icon="hardware-chip-outline"
            label="Model"
            value={modelStatusValue(modelStatus)}
            onPress={() => router.push("/settings/model")}
          />
          <SettingsRow icon="document-text-outline" label="Licenses" onPress={() => router.push("/settings/licenses")} />
        </SettingsGroup>

        <SettingsGroup label="About">
          <SettingsRow
            icon="information-circle-outline"
            label="Version"
            value={appVersionLabel()}
            chevron={false}
          />
          <SettingsRow
            icon="lock-closed-outline"
            label="Privacy"
            value="Nothing leaves this device"
            chevron={false}
            accessibilityHint="All processing happens on this device; nothing is collected or sent"
          />
          <SettingsRow icon="help-circle-outline" label="How Uncoil works" onPress={() => router.push("/tutorial")} />
          <SettingsRow icon="sparkles-outline" label="About the AI" onPress={() => router.push("/settings/legal/ai")} />
          <SettingsRow icon="document-text-outline" label="Terms of Use" onPress={() => router.push("/settings/legal/terms")} />
          <SettingsRow
            icon="shield-checkmark-outline"
            label="Privacy Policy"
            onPress={() => router.push("/settings/legal/privacy")}
          />
        </SettingsGroup>

        <SettingsGroup label="Your data">
          <SettingsRow
            icon="share-outline"
            label="Export my data"
            onPress={handleExportData}
            disabled={isExportingData}
            accessory={isExportingData ? <ActivityIndicator size="small" accessibilityLabel="Exporting" /> : undefined}
          />
          <SettingsRow
            icon="download-outline"
            label="Import data"
            onPress={handlePressImportData}
            disabled={isPickingFile}
            accessory={isPickingFile ? <ActivityIndicator size="small" accessibilityLabel="Opening file" /> : undefined}
          />
          {__DEV__ ? (
            <SettingsRow
              icon="flask-outline"
              label="Load demo data"
              value={seedState === "done" ? "Loaded" : seedState === "failed" ? "Failed" : undefined}
              disabled={seedState === "loading"}
              chevron={false}
              onPress={handleSeedDemoData}
              accessory={seedState === "loading" ? <ActivityIndicator size="small" accessibilityLabel="Loading demo data" /> : undefined}
              accessibilityHint="Replaces everything on this device with three weeks of sample history"
            />
          ) : null}
          <SettingsRow
            icon="trash-outline"
            label="Delete all data"
            tone="danger"
            chevron={false}
            onPress={() => setDeleteStep(1)}
            accessibilityHint="Opens a two-step confirmation"
          />
        </SettingsGroup>
      </ScrollView>

      <SheetFrame
        visible={showSessions}
        title="Recent sessions"
        onClose={() => setShowSessions(false)}
        closeLabel="Close recent sessions"
        footer={
          <Button title="Close" variant="primary" onPress={() => setShowSessions(false)} accessibilityLabel="Close recent sessions" />
        }
      >
        {recentSessions.length === 0 ? (
          <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
            No sessions yet. Start one from any task.
          </Text>
        ) : (
          recentSessions.map((session) => {
            const minutes = Math.round((session.durationSeconds ?? 0) / 60);
            const steps = session.completedSubtaskIds.length;
            const detail = `${minutes} min · ${steps} ${steps === 1 ? "step" : "steps"} done · ${formatSessionDate(session.startedAt)}`;
            return (
              <View
                key={session.id}
                className="flex-row items-center"
                style={{ minHeight: TOUCH_TARGET_MIN }}
                accessibilityLabel={`${session.taskTitleSnapshot}. ${detail}`}
              >
                <Ionicons
                  name="checkmark-circle-outline"
                  size={ICON_SIZE.row}
                  className="text-content-secondary dark:text-content-dark-secondary"
                />
                <View className="flex-1" style={{ marginLeft: spacing.md }}>
                  <Text className="text-body font-sans text-content dark:text-content-dark-primary" numberOfLines={2}>
                    {session.taskTitleSnapshot}
                  </Text>
                  <Text className="text-caption font-sans text-content-secondary dark:text-content-dark-secondary">
                    {detail}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </SheetFrame>

      <SheetFrame
        visible={deleteStep !== 0}
        title={deleteStep === 1 ? "Delete all data?" : "Are you sure?"}
        onClose={closeDeleteFlow}
        closeLabel="Close delete all data confirmation"
        scroll={false}
        footer={
          deleteStep === 1 ? (
            <>
              <Button
                title="Continue"
                variant="danger"
                onPress={() => setDeleteStep(2)}
                accessibilityLabel="Continue to final delete all data confirmation"
              />
              <Button title="Cancel" variant="ghost" onPress={closeDeleteFlow} accessibilityLabel="Cancel delete all data" />
            </>
          ) : (
            <>
              <Button
                title="Delete everything"
                variant="danger"
                loading={isDeletingAllData}
                onPress={handleConfirmDeleteAllData}
                accessibilityLabel="Confirm delete all data permanently"
              />
              <Button
                title="Cancel"
                variant="ghost"
                onPress={closeDeleteFlow}
                disabled={isDeletingAllData}
                accessibilityLabel="Cancel delete all data"
              />
            </>
          )
        }
      >
        {deleteStep === 1 ? (
          <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
            This permanently deletes every task, focus session, and setting stored on this device. This
            cannot be undone.
          </Text>
        ) : (
          <>
            <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
              There is no way to recover this once it&apos;s gone. Uncoil will restart as if just installed.
            </Text>
            {deleteError && (
              <Text
                className="text-body font-sans text-content dark:text-content-dark-primary"
                style={{ marginTop: spacing.base }}
                accessibilityLiveRegion="polite"
              >
                Something went wrong. Please try again.
              </Text>
            )}
          </>
        )}
      </SheetFrame>

      <SheetFrame
        visible={exportError}
        title="Could not export"
        onClose={() => setExportError(false)}
        closeLabel="Close export error"
        scroll={false}
        footer={
          <Button title="Close" variant="primary" onPress={() => setExportError(false)} accessibilityLabel="Close export error" />
        }
      >
        <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
          Could not create the backup file.
        </Text>
      </SheetFrame>

      <SheetFrame
        visible={importStep !== 0}
        title={importTitle}
        onClose={closeImportFlow}
        closeLabel="Close import data confirmation"
        scroll={false}
        footer={
          importStep === 1 ? (
            <>
              <Button
                title="Continue"
                variant="danger"
                onPress={() => setImportStep(2)}
                accessibilityLabel="Continue to final import data confirmation"
              />
              <Button title="Cancel" variant="ghost" onPress={closeImportFlow} accessibilityLabel="Cancel import data" />
            </>
          ) : importStep === 2 ? (
            <>
              <Button
                title="Replace my data"
                variant="danger"
                loading={isImportingData}
                onPress={handleConfirmImportData}
                accessibilityLabel="Confirm replace my data"
              />
              <Button
                title="Cancel"
                variant="ghost"
                onPress={closeImportFlow}
                disabled={isImportingData}
                accessibilityLabel="Cancel import data"
              />
            </>
          ) : importOutcome?.ok ? (
            <Button title="Done" variant="primary" onPress={closeImportFlow} accessibilityLabel="Done" />
          ) : (
            <Button title="Close" variant="primary" onPress={closeImportFlow} accessibilityLabel="Close import error" />
          )
        }
      >
        <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
          {importStep === 1
            ? "Importing this file replaces every task, focus session, and setting currently on this device. The current data on this device is saved first, before anything is replaced."
            : importStep === 2
              ? "This replaces everything currently on this device with the imported file."
              : importOutcome?.ok
                ? `Imported ${importOutcome.counts.tasks} tasks and ${importOutcome.counts.sessions} sessions.`
                : importOutcome
                  ? IMPORT_FAILURE_MESSAGES[importOutcome.reason]
                  : ""}
        </Text>
      </SheetFrame>

      <SheetFrame
        visible={pickFileError !== false}
        title="Could not import"
        onClose={() => setPickFileError(false)}
        closeLabel="Close import file error"
        scroll={false}
        footer={
          <Button
            title="Close"
            variant="primary"
            onPress={() => setPickFileError(false)}
            accessibilityLabel="Close import file error"
          />
        }
      >
        <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary">
          {pickFileError === "too-large"
            ? "That file is too large to be an Uncoil backup."
            : "Could not read that file."}
        </Text>
      </SheetFrame>

      <SheetFrame
        visible={showMaxNotifPicker}
        title="Notifications per hour"
        onClose={() => setShowMaxNotifPicker(false)}
        closeLabel="Dismiss"
        scroll={false}
      >
        <Text
          className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
          style={{ marginBottom: spacing.base }}
        >
          The most reminders Uncoil sends in one hour.
        </Text>
        <SelectChipRow accessibilityLabel="Notifications per hour">
          {PER_HOUR_OPTIONS.map((val) => (
            <SelectChip
              key={val}
              label={`${val}`}
              selected={maxNotificationsPerHour === val}
              onPress={() => {
                updateSetting("maxNotificationsPerHour", val);
                setShowMaxNotifPicker(false);
              }}
              accessibilityLabel={`${val} per hour`}
            />
          ))}
        </SelectChipRow>
      </SheetFrame>

      <SheetFrame
        visible={showQuietHoursPicker}
        title="Quiet hours"
        onClose={() => setShowQuietHoursPicker(false)}
        closeLabel="Dismiss"
        scroll={false}
        footer={
          <Button
            title="Done"
            variant="primary"
            onPress={() => setShowQuietHoursPicker(false)}
            accessibilityLabel="Done choosing quiet hours"
          />
        }
      >
        <Text
          className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
          style={{ marginBottom: spacing.base }}
        >
          No reminders during these hours.
        </Text>
        <Text
          className="text-caption font-medium text-content-secondary dark:text-content-dark-secondary"
          style={{ marginBottom: spacing.sm }}
        >
          Starts at
        </Text>
        <SelectChipRow accessibilityLabel="Quiet hours start">
          {QUIET_START_OPTIONS.map((h) => (
            <SelectChip
              key={h}
              label={formatHour(h)}
              selected={quietHoursStart === h}
              onPress={() => updateSetting("quietHoursStart", h)}
              accessibilityLabel={`Starts at ${formatHour(h)}`}
            />
          ))}
        </SelectChipRow>
        <Text
          className="text-caption font-medium text-content-secondary dark:text-content-dark-secondary"
          style={{ marginTop: spacing.base, marginBottom: spacing.sm }}
        >
          Ends at
        </Text>
        <SelectChipRow accessibilityLabel="Quiet hours end">
          {QUIET_END_OPTIONS.map((h) => (
            <SelectChip
              key={h}
              label={formatHour(h)}
              selected={quietHoursEnd === h}
              onPress={() => updateSetting("quietHoursEnd", h)}
              accessibilityLabel={`Ends at ${formatHour(h)}`}
            />
          ))}
        </SelectChipRow>
      </SheetFrame>
    </Screen>
  );
}
