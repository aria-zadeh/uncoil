import React from "react";
import { Redirect } from "expo-router";

// focus starts from each task now. the route stays so old links still resolve
export default function FocusScreen() {
  return <Redirect href="/(tabs)/profile" />;
}
