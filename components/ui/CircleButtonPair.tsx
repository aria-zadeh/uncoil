import React from "react";
import { View } from "react-native";
import { spacing } from "@/utils/design-tokens";

const OVERLAP = spacing.sm;

export interface CircleButtonPairProps {
  children: [React.ReactNode, React.ReactNode];
}

export function CircleButtonPair({ children }: CircleButtonPairProps) {
  const [leading, trailing] = children;
  return (
    <View className="flex-row items-center">
      {leading}
      <View style={{ marginLeft: -OVERLAP, zIndex: 1 }}>{trailing}</View>
    </View>
  );
}
