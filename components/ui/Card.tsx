import React from "react";
import { View, type ViewProps, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { shadows, spacing, borderRadius, HAIRLINE } from "@/utils/design-tokens";
import { PressableScale } from "./PressableScale";

const FOOTER_INSET = spacing.xs;

type CardVariant = "default" | "elevated" | "flat";
type CardPadding = "none" | "sm" | "base" | "lg";

interface CardBaseProps {
  // elevated drops the hairline. flat is deprecated, use SubPanel
  variant?: CardVariant;
  padding?: CardPadding;
  children: React.ReactNode;
  // usually a SubPanel, inset from the card's sides and bottom
  footer?: React.ReactNode;
  className?: string;
}

interface TappableCardProps extends CardBaseProps, Omit<PressableProps, "children" | "className"> {
  onPress: PressableProps["onPress"];
}

interface StaticCardProps extends CardBaseProps, Omit<ViewProps, "children" | "className"> {
  onPress?: never;
}

type CardProps = TappableCardProps | StaticCardProps;

const variantClasses: Record<CardVariant, string> = {
  default: "bg-surface-card dark:bg-surface-dark-card border-border dark:border-border-dark rounded-lg",
  elevated: "bg-surface-card dark:bg-surface-dark-card rounded-lg",
  flat: "bg-surface dark:bg-surface-dark border-border dark:border-border-dark rounded-md",
};

const variantBorder: Record<CardVariant, number> = {
  default: HAIRLINE,
  elevated: 0,
  flat: HAIRLINE,
};

const variantShadow: Record<CardVariant, object> = {
  default: shadows.md,
  elevated: shadows.md,
  flat: {},
};

const variantRadius: Record<CardVariant, number> = {
  default: borderRadius.lg,
  elevated: borderRadius.lg,
  flat: borderRadius.md,
};

const paddingValue: Record<CardPadding, number> = {
  none: 0,
  sm: spacing.sm,
  base: spacing.md,
  lg: spacing.base,
};

function cardClasses(variant: CardVariant, className: string) {
  return `${variantClasses[variant]} ${className}`;
}

function cardPadding(padding: CardPadding, hasFooter: boolean) {
  // none sets nothing so a caller's own padding classes still apply
  if (padding === "none") return {};
  const pad = paddingValue[padding];
  return {
    paddingTop: pad,
    paddingHorizontal: pad,
    paddingBottom: hasFooter ? Math.min(pad, FOOTER_INSET) : pad,
  };
}

function Footer({ padding, children }: { padding: CardPadding; children: React.ReactNode }) {
  const pad = paddingValue[padding];
  const pull = Math.max(0, pad - FOOTER_INSET);
  return <View style={{ marginTop: spacing.md, marginHorizontal: -pull }}>{children}</View>;
}

function TappableCard({
  variant = "default",
  padding = "base",
  children,
  footer,
  onPress,
  className = "",
  style,
  ...props
}: TappableCardProps) {
  return (
    <PressableScale
      accessibilityRole="button"
      {...props}
      onPress={onPress}
      radius={variantRadius[variant]}
      className={cardClasses(variant, className)}
      // Reanimated's animated Pressable can't resolve a function-form style, so a
      // caller's function style is ignored rather than losing the padding and hairline
      style={[
        { borderWidth: variantBorder[variant] },
        cardPadding(padding, Boolean(footer)),
        variantShadow[variant],
        typeof style === "function" ? undefined : (style as StyleProp<ViewStyle>),
      ]}
    >
      {children}
      {footer ? <Footer padding={padding}>{footer}</Footer> : null}
    </PressableScale>
  );
}

export function Card({ variant = "default", padding = "base", children, footer, onPress, className = "", ...props }: CardProps) {
  if (onPress) {
    return (
      <TappableCard
        variant={variant}
        padding={padding}
        footer={footer}
        onPress={onPress}
        className={className}
        {...(props as PressableProps)}
      >
        {children}
      </TappableCard>
    );
  }

  const { style, ...viewProps } = props as ViewProps;
  return (
    <View
      className={cardClasses(variant, className)}
      style={[{ borderWidth: variantBorder[variant] }, cardPadding(padding, Boolean(footer)), variantShadow[variant], style]}
      {...viewProps}
    >
      {children}
      {footer ? <Footer padding={padding}>{footer}</Footer> : null}
    </View>
  );
}
