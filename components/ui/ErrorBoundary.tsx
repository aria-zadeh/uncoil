import React from "react";
import { View, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "./Button";
import { spacing, typography } from "@/utils/design-tokens";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// a class because error boundaries have no hook form, which is also why the fallback
// uses SafeAreaView instead of useSafeAreaInsets. errors are logged locally, never sent
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    console.error("ErrorBoundary caught an error", error, info.componentStack);
  }

  handleReset = (): void => {
    this.setState({ hasError: false });
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <SafeAreaView className="flex-1 bg-surface dark:bg-surface-dark">
        <View className="flex-1 items-center justify-center" style={{ paddingHorizontal: spacing.xl, gap: spacing.base }}>
          <Text
            className="text-title font-medium text-content dark:text-content-dark-primary text-center"
            style={{ letterSpacing: typography.title.letterSpacing }}
            accessibilityRole="header"
          >
            Something went wrong
          </Text>
          <Text className="text-body font-sans text-content-secondary dark:text-content-dark-secondary text-center">
            Uncoil hit an error it could not recover from. Your tasks are saved on this device.
          </Text>
          <View style={{ marginTop: spacing.base, alignSelf: "stretch" }}>
            <Button title="Try again" variant="primary" onPress={this.handleReset} accessibilityLabel="Try again" />
          </View>
        </View>
      </SafeAreaView>
    );
  }
}
