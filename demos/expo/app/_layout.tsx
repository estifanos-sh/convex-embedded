import { Stack } from "expo-router/stack";
import { StatusBar } from "expo-status-bar";

import { colors } from "@/src/theme";

export default function RootLayout() {
  return (
    <>
      <Stack
        screenOptions={{
          contentStyle: { backgroundColor: colors.background.secondary },
          headerBackButtonDisplayMode: "minimal",
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.background.secondary },
          headerTintColor: colors.content.primary,
        }}
      >
        <Stack.Screen name="index" options={{ title: "Documents" }} />
        <Stack.Screen name="document/[id]" options={{ headerShown: false }} />
      </Stack>
      <StatusBar style="light" />
    </>
  );
}
