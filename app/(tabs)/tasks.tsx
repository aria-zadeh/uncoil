import React from "react";
import { Redirect } from "expo-router";

// merged into Home. the route stays so old links and router.push calls still land
export default function TasksScreen() {
  return <Redirect href="/(tabs)" />;
}
