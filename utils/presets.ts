// each list is rendered by more than one screen, kept here so the chip rows can't drift

export const DURATION_PRESETS = [
  { value: 15, label: "15m" },
  { value: 30, label: "30m" },
  { value: 45, label: "45m" },
  { value: 60, label: "1h" },
  { value: 90, label: "1.5h" },
  { value: 120, label: "2h" },
  { value: 180, label: "3h" },
] as const;

export const PER_HOUR_OPTIONS = [1, 2, 3, 5, 10] as const;
export const QUIET_START_OPTIONS = [20, 21, 22, 23, 0] as const;
export const QUIET_END_OPTIONS = [5, 6, 7, 8, 9] as const;
