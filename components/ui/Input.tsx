import React, { useState } from "react";
import { View, Text, TextInput, type TextInputProps } from "react-native";
import { useColorScheme } from "nativewind";
import { colors, spacing, borderRadius, HAIRLINE, TOUCH_TARGET_MIN } from "@/utils/design-tokens";

const LABEL_GAP = spacing.xs + 2;
const MULTILINE_HEIGHT = spacing["5xl"] + spacing.xl;

export interface InputProps
  extends Omit<TextInputProps, "value" | "onChangeText" | "placeholder" | "multiline" | "autoFocus" | "keyboardType" | "accessibilityLabel" | "style"> {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  multiline?: boolean;
  minHeight?: number;
  autoFocus?: boolean;
  keyboardType?: TextInputProps["keyboardType"];
  accessibilityLabel?: string;
  error?: string;
  disabled?: boolean;
}

export function Input({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  minHeight,
  autoFocus = false,
  keyboardType,
  accessibilityLabel,
  error,
  disabled = false,
  onFocus,
  onBlur,
  ...rest
}: InputProps) {
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const [focused, setFocused] = useState(false);

  const borderColor = focused ? colors[scheme].selected : colors[scheme].border;
  const fieldMinHeight = minHeight ?? (multiline ? MULTILINE_HEIGHT : TOUCH_TARGET_MIN);

  return (
    <View className={disabled ? "opacity-50" : ""}>
      <Text
        className="text-body font-sans text-content-secondary dark:text-content-dark-secondary"
        style={{ marginBottom: LABEL_GAP }}
      >
        {label}
      </Text>
      <TextInput
        {...rest}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors[scheme].textMuted}
        multiline={multiline}
        autoFocus={autoFocus}
        keyboardType={keyboardType}
        editable={!disabled}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        className="bg-surface-card dark:bg-surface-dark-card text-body font-sans text-content dark:text-content-dark-primary"
        style={{
          minHeight: fieldMinHeight,
          borderWidth: HAIRLINE,
          borderColor,
          borderRadius: multiline ? borderRadius.xl : borderRadius.full,
          paddingHorizontal: spacing.base,
          paddingVertical: multiline ? spacing.md : 0,
          textAlignVertical: multiline ? "top" : "center",
        }}
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ disabled }}
      />
      {error ? (
        <Text
          className="text-small font-medium text-danger-dark dark:text-danger-bright"
          style={{ marginTop: spacing.sm - 2 }}
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}
