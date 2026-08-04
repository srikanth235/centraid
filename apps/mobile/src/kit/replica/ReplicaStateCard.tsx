import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import Icon from "../components/Icon";
import { Text } from "../components/NativeText";
import type { ReplicaQueryConnection } from "../hooks/useReplicaQuery";
import { family, radii, useTheme } from "../theme";

export default function ReplicaStateCard({
  connection,
  error,
  unavailableReason,
  noun,
  onRetry,
}: {
  connection: ReplicaQueryConnection;
  error?: string;
  unavailableReason?: string;
  noun: string;
  onRetry?: () => void;
}): React.JSX.Element | null {
  const { colors } = useTheme();
  if (connection !== "unavailable" && !error) return null;
  const unavailable = connection === "unavailable";
  const title = unavailable
    ? `${noun} is not connected`
    : `${noun} could not be loaded`;
  const message = unavailable
    ? (unavailableReason ??
      "Pair or reconnect a gateway. An unavailable vault is never treated as an empty one.")
    : error!;
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.card,
        { backgroundColor: colors.bgElev, borderColor: colors.line },
      ]}
    >
      <Icon
        name={unavailable ? "wifi-off" : "alert-circle"}
        size={28}
        color={colors.danger}
      />
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.message, { color: colors.textSoft }]}>
        {message}
      </Text>
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={[styles.retry, { backgroundColor: colors.accent }]}
        >
          <Text style={[styles.retryText, { color: colors.bg }]}>
            Try again
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: "center",
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
    margin: 20,
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  message: {
    fontFamily: family.sansRegular,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  retry: {
    borderRadius: radii.lg,
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryText: {
    fontFamily: family.sansMedium,
    fontSize: 13,
  },
  title: {
    fontFamily: family.sansMedium,
    fontSize: 19,
    textAlign: "center",
  },
});
