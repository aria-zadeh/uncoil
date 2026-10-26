import "@/global.css";
// side effect: lets NativeWind `text-*` classes tint Ionicons
import "@/components/ui/icons";
import React, { useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  useFonts,
} from "@expo-google-fonts/instrument-sans";
import { useColorScheme } from "nativewind";
import * as Notifications from "expo-notifications";
import {
  flushNotifications,
  flushWrites,
  initializeStores,
  useNotificationStore,
  useSettingsStore,
  useTaskStore,
} from "@/store/runtime";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

// setting the handler is not a permission request, so module load is fine
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// hold the splash until stores and fonts are ready so no text draws in a fallback face.
// both calls can reject (already hidden, no native splash) and that is fine
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

// keys are the family names that `fontFamily` styles and `font-*` classes select
const FONTS = {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
};

// throwing in render is the only way to hand a non-render error to a boundary
function StartupFailed({ error }: { error: unknown }): React.ReactNode {
  throw error instanceof Error ? error : new Error(String(error));
}

export default function RootLayout() {
  const [storesReady, setStoresReady] = useState(false);
  const [initError, setInitError] = useState<{ error: unknown } | null>(null);
  // a failed font load falls back to the system font instead of holding the splash
  const [fontsLoaded, fontError] = useFonts(FONTS);
  const fontsSettled = fontsLoaded || fontError !== null;
  const ready = storesReady && fontsSettled;
  const failed = initError !== null && fontsSettled;

  // every store hook throws before hydration, so nothing renders until `ready`
  useEffect(() => {
    let cancelled = false;
    initializeStores().then(
      () => {
        if (!cancelled) setStoresReady(true);
      },
      (error: unknown) => {
        if (!cancelled) setInitError({ error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // effects run after commit, so the first real frame is already on screen
  useEffect(() => {
    if (!ready && !failed) return;
    void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready, failed]);

  // writes are debounced, so flush before the OS can kill a backgrounded app
  useEffect(() => {
    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === "background" || state === "inactive") {
        void flushWrites();
        // reminders for a task completed or deleted just before a kill must still be cancelled
        void flushNotifications();
      }
    };
    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => subscription.remove();
  }, []);

  if (failed) {
    return (
      <ErrorBoundary>
        <StartupFailed error={initError.error} />
      </ErrorBoundary>
    );
  }

  if (!ready) return null;

  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}

// split out so store hooks only run after hydration, while RootLayout's own hooks stay unconditional
function AppShell() {
  const { colorScheme, setColorScheme } = useColorScheme();
  const themePreference = useSettingsStore((s) => s.themePreference);
  const onboardingComplete = useSettingsStore((s) => s.onboardingComplete);
  const rescheduleAll = useTaskStore((s) => s.rescheduleAll);
  const syncNotifications = useNotificationStore((s) => s.syncNotifications);
  const refreshPermissionStatus = useNotificationStore((s) => s.refreshPermissionStatus);

  useEffect(() => {
    setColorScheme(themePreference === "system" ? "system" : themePreference);
  }, [themePreference, setColorScheme]);

  // re-propose open tasks at most hourly while foregrounded. no background modes,
  // the interval stops as soon as the app leaves the foreground
  useEffect(() => {
    const HOUR_MS = 60 * 60 * 1000;
    let lastSweepAt = 0;
    let interval: ReturnType<typeof setInterval> | null = null;

    const sweep = (): void => {
      const nowMs = Date.now();
      if (nowMs - lastSweepAt < HOUR_MS) return;
      lastSweepAt = nowMs;
      // permission can be revoked in system settings at any time. a failed read keeps the last known status
      refreshPermissionStatus().catch(() => undefined);
      rescheduleAll();
      syncNotifications();
    };

    const startInterval = (): void => {
      if (interval !== null) return;
      interval = setInterval(sweep, HOUR_MS);
    };
    const stopInterval = (): void => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const handleAppStateChange = (state: AppStateStatus): void => {
      if (state === "active") {
        sweep();
        startInterval();
      } else {
        stopInterval();
      }
    };

    if (AppState.currentState === "active") {
      sweep();
      startInterval();
    }
    const subscription = AppState.addEventListener("change", handleAppStateChange);
    return () => {
      subscription.remove();
      stopInterval();
    };
  }, [rescheduleAll, syncNotifications, refreshPermissionStatus]);

  return (
    <>
      {/* Stack.Protected, not a conditional child: routes are file-based, so leaving a
          Stack.Screen out gates nothing. a null child also makes the router warn */}
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={!onboardingComplete}>
          <Stack.Screen name="onboarding" />
        </Stack.Protected>
        {/* reachable before onboarding finishes so the first task can be made during setup */}
        <Stack.Screen
          name="task/new"
          options={{ presentation: "modal", animation: "slide_from_bottom" }}
        />
        <Stack.Protected guard={onboardingComplete}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="task/[id]" options={{ animation: "slide_from_right" }} />
          <Stack.Screen
            name="focus/session"
            options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen name="settings/busy-times" options={{ animation: "slide_from_right" }} />
          <Stack.Screen
            name="tutorial"
            options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }}
          />
        </Stack.Protected>
      </Stack>
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
    </>
  );
}
