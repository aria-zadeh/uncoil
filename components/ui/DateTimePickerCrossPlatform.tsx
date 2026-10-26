import React from "react";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useColorScheme } from "nativewind";
import { colors } from "@/utils/design-tokens";

export interface DateTimePickerCrossPlatformProps {
  value: Date;
  onChange: (date: Date) => void;
  mode: "date" | "time";
  minimumDate?: Date;
  display?: "default" | "inline" | "spinner";
  accessibilityLabel?: string;
}

// iOS only now. the name is left over, kept so importers don't change
export function DateTimePickerCrossPlatform({
  value,
  onChange,
  mode,
  minimumDate,
  display = "default",
  accessibilityLabel,
}: DateTimePickerCrossPlatformProps) {
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";

  return (
    <DateTimePicker
      value={value}
      mode={mode}
      display={display}
      minimumDate={minimumDate}
      themeVariant={scheme}
      accentColor={colors[scheme].selected}
      onChange={(_event, selected) => {
        if (selected) onChange(selected);
      }}
      accessibilityLabel={accessibilityLabel}
    />
  );
}
