import React from "react";
import { View, type ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export interface ScreenProps extends ViewProps {
  children: React.ReactNode;
  // false only for a screen that draws its own top inset
  topInset?: boolean;
  className?: string;
}

// every screen's root, so the status bar strip shows the screen colour and never scrolled
// content. ScreenHeader leaves the inset to this, adding it in both doubled the offset
export function Screen({ children, topInset = true, className = "", style, ...props }: ScreenProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      className={`flex-1 bg-surface dark:bg-surface-dark ${className}`.trim()}
      style={[{ paddingTop: topInset ? insets.top : 0 }, style]}
      {...props}
    >
      {children}
    </View>
  );
}
