import { Stack } from "expo-router";

export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }}>
      <Stack.Screen name="welcome" />
      <Stack.Screen name="name" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="availability" />
      <Stack.Screen name="energy" />
    </Stack>
  );
}
