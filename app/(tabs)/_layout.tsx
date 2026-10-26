import { Tabs, router } from "expo-router";
import React from "react";
import { View } from "react-native";
import { FloatingTabBar } from "@/components/ui/FloatingTabBar";

export default function TabLayout() {
  return (
    <View style={{ flex: 1 }}>
      <Tabs
        tabBar={(props) => <FloatingTabBar {...props} onAdd={() => router.push("/task/new")} />}
        screenOptions={{
          headerShown: false,
          tabBarStyle: { display: "none" },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Home",
            tabBarAccessibilityLabel: "Home tab",
          }}
        />
        <Tabs.Screen
          name="calendar"
          options={{
            title: "Schedule",
            tabBarAccessibilityLabel: "Schedule tab",
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: "Profile",
            tabBarAccessibilityLabel: "Profile tab",
          }}
        />
        {/* routable without a tab slot so existing links still resolve */}
        <Tabs.Screen name="tasks" options={{ href: null }} />
        <Tabs.Screen name="focus" options={{ href: null }} />
      </Tabs>
    </View>
  );
}
