import React from "react";
import {
  View,
  Pressable,
  Text,
  ActivityIndicator,
  useWindowDimensions,
  type PressableProps,
} from "react-native";
import { useColorScheme } from "nativewind";
import { colors, spacing, BUTTON_MIN_HEIGHT, TOUCH_TARGET_MIN } from "@/utils/design-tokens";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends Omit<PressableProps, "children"> {
  title: string;
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: React.ReactNode;
}

// press feedback is a fill change, not a scale, so the label never shifts
const variantClasses: Record<ButtonVariant, { base: string; text: string }> = {
  primary: {
    base: "bg-primary dark:bg-primary-bright active:bg-primary-dark dark:active:bg-primary-bright-dark",
    text: "text-primary-foreground dark:text-primary-bright-foreground",
  },
  secondary: {
    base: "bg-surface-elevated dark:bg-surface-dark-elevated active:bg-border dark:active:bg-border-dark",
    text: "text-content dark:text-content-dark-primary",
  },
  ghost: {
    base: "bg-transparent active:bg-surface-elevated dark:active:bg-surface-dark-elevated",
    text: "text-content dark:text-content-dark-primary",
  },
  danger: {
    base: "bg-danger active:bg-danger-dark",
    text: "text-danger-foreground",
  },
};

const variantHeight: Record<ButtonVariant, number> = {
  primary: BUTTON_MIN_HEIGHT,
  secondary: BUTTON_MIN_HEIGHT,
  ghost: TOUCH_TARGET_MIN,
  danger: BUTTON_MIN_HEIGHT,
};

// declares its own role and label, which is why scripts/verify/a11y.mjs skips its call sites
export function Button({
  title,
  variant = "primary",
  loading = false,
  disabled,
  icon,
  className = "",
  style,
  ...props
}: ButtonProps) {
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === "dark" ? "dark" : "light";
  const styles = variantClasses[variant];
  const isDisabled = disabled || loading;
  // one line truncates at large Dynamic Type. minHeight lets the pill grow, two lines is enough
  const { fontScale } = useWindowDimensions();
  const allowWrap = fontScale >= 1.3;
  const spinnerColor =
    variant === "primary"
      ? colors[scheme].primaryForeground
      : variant === "danger"
        ? colors[scheme].dangerForeground
        : colors[scheme].text;

  return (
    <Pressable
      {...props}
      disabled={isDisabled}
      className={`flex-row items-center justify-center rounded-full ${styles.base} ${disabled ? "opacity-50" : ""} ${className}`}
      // plain array, never the function form: NativeWind's Pressable drops function
      // styles and the min height goes with it. a caller's function style is ignored
      style={[
        {
          minHeight: variantHeight[variant],
          paddingHorizontal: spacing.xl,
          paddingVertical: allowWrap ? spacing.xs : 0,
        },
        typeof style === "function" ? undefined : style,
      ]}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      accessibilityLabel={props.accessibilityLabel || title}
    >
      {icon && !loading ? <View style={{ marginRight: spacing.sm }}>{icon}</View> : null}
      <Text
        className={`text-bodyMedium font-medium ${styles.text} ${loading ? "opacity-0" : ""}`}
        style={allowWrap ? { textAlign: "center", flexShrink: 1 } : undefined}
        numberOfLines={allowWrap ? 2 : 1}
      >
        {title}
      </Text>
      {loading && (
        <View className="absolute inset-0 items-center justify-center">
          <ActivityIndicator color={spinnerColor} />
        </View>
      )}
    </Pressable>
  );
}
