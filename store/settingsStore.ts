// one storage key holds all of it, so every action queues the whole settings object
import { createStore, type StoreApi } from 'zustand/vanilla';

import { STORAGE_KEYS } from '@/data/keys';
import type { WriteQueue } from '@/data/writeQueue';
import type { BusyBlock, CalendarEvent, UserSettings } from '@/types';

export interface StoreDeps {
  queue: WriteQueue;
  // ISO 8601
  now: () => string;
  // UUID v4
  newId: () => string;
  // prefs, busy blocks and events all change the notification plan. optional for tests
  notificationStore?: { getState: () => { syncNotifications: () => void } };
}

const NOTIFICATION_SETTING_KEYS: ReadonlySet<keyof UserSettings> = new Set([
  'notificationsEnabled',
  'maxNotificationsPerHour',
  'quietHoursStart',
  'quietHoursEnd',
]);

// leaving out repeatDays means a one-off
export type NewCalendarEventInput = Omit<CalendarEvent, 'id' | 'createdAt' | 'repeatDays'> & {
  repeatDays?: CalendarEvent['repeatDays'];
};
export type CalendarEventUpdate = Partial<Omit<CalendarEvent, 'id' | 'createdAt'>>;

export interface SettingsState extends UserSettings {
  updateSetting: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => void;
  completeOnboarding: () => void;
  setEnergyPeak: (start: number, end: number) => void;
  toggleBusyBlock: (block: BusyBlock) => void;
  setAvailabilityNotes: (notes: string) => void;
  addCalendarEvent: (event: NewCalendarEventInput) => string;
  updateCalendarEvent: (id: string, updates: CalendarEventUpdate) => void;
  deleteCalendarEvent: (id: string) => void;
}

/** strips the actions off, for storage and backups */
export function toUserSettings(state: SettingsState): UserSettings {
  return {
    schemaVersion: state.schemaVersion,
    displayName: state.displayName,
    onboardingComplete: state.onboardingComplete,
    notificationsEnabled: state.notificationsEnabled,
    maxNotificationsPerHour: state.maxNotificationsPerHour,
    quietHoursStart: state.quietHoursStart,
    quietHoursEnd: state.quietHoursEnd,
    busyBlocks: state.busyBlocks,
    calendarEvents: state.calendarEvents,
    availabilityNotes: state.availabilityNotes,
    energyPeakStart: state.energyPeakStart,
    energyPeakEnd: state.energyPeakEnd,
    typicalSessionMinutes: state.typicalSessionMinutes,
    autoAcceptProposedSchedule: state.autoAcceptProposedSchedule,
    breakMinutes: state.breakMinutes,
    themePreference: state.themePreference,
    generationOptOut: state.generationOptOut,
  };
}

export function createSettingsStore(deps: StoreDeps, initial: UserSettings): StoreApi<SettingsState> {
  return createStore<SettingsState>()((set, get) => {
    const persist = (): void => deps.queue.queue(STORAGE_KEYS.settings, toUserSettings(get()));
    const syncNotifications = (): void => deps.notificationStore?.getState().syncNotifications();

    return {
      ...initial,

      updateSetting: (key, value) => {
        // a computed key defeats the partial-state check. key and value are typed at the call site
        const patch = { [key]: value } as Partial<UserSettings>;
        set(patch);
        persist();
        if (NOTIFICATION_SETTING_KEYS.has(key)) syncNotifications();
      },

      completeOnboarding: () => {
        set({ onboardingComplete: true });
        persist();
      },

      setEnergyPeak: (start, end) => {
        set({ energyPeakStart: start, energyPeakEnd: end });
        persist();
      },

      toggleBusyBlock: (block) => {
        set((state) => {
          const exists = state.busyBlocks.some((b) => b.day === block.day && b.period === block.period);
          return {
            busyBlocks: exists
              ? state.busyBlocks.filter((b) => !(b.day === block.day && b.period === block.period))
              : [...state.busyBlocks, block],
          };
        });
        persist();
        syncNotifications();
      },

      setAvailabilityNotes: (notes) => {
        set({ availabilityNotes: notes });
        persist();
      },

      addCalendarEvent: (event) => {
        const id = deps.newId();
        const created: CalendarEvent = {
          ...event,
          repeatDays: event.repeatDays ?? [],
          id,
          createdAt: deps.now(),
        };
        set((state) => ({ calendarEvents: [...state.calendarEvents, created] }));
        persist();
        syncNotifications();
        return id;
      },

      updateCalendarEvent: (id, updates) => {
        set((state) => ({
          calendarEvents: state.calendarEvents.map((e) => (e.id === id ? { ...e, ...updates } : e)),
        }));
        persist();
        syncNotifications();
      },

      deleteCalendarEvent: (id) => {
        set((state) => ({
          calendarEvents: state.calendarEvents.filter((e) => e.id !== id),
        }));
        persist();
        syncNotifications();
      },
    };
  });
}
