// The kit's own explanation block for a replica with NOTHING to show and no
// prospect of getting it — `unavailable` (no gateway ever paired) and `error`
// (a read that failed; an empty grid that is a bug). `offline` is deliberately
// not one of them: a vault is a local replica, offline it renders from bytes
// already on the phone, and carding the product's own premise as an incident —
// in a block holding ~45% of the screen on every app that mounts it — is an
// over-announcement. Offline is stated once by the replica
// bar (Gateway asleep · Wake help) for members who can act on it.
//
// Kept app-agnostic on purpose: this is a kit component, not a Photos one, so
// its copy names no app-specific noun ("photographs") — `noun` is the only
// thing a caller supplies.
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "../components/NativeText";
import type { ReplicaQueryConnection } from "../hooks/useReplicaQuery";
import { borders, family, radii, useTheme, t } from "../theme";

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
  const unavailable = connection === "unavailable";
  if (!unavailable && !error) return null;
  const title = unavailable
    ? `${noun} is not connected`
    : `${noun} could not be loaded`;
  const message = unavailable
    ? (unavailableReason ?? "Pair or reconnect a gateway.")
    : (error ?? "");
  return (
    <View
      accessibilityRole="alert"
      style={[styles.card, { borderColor: colors.net }]}
    >
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.message, { color: colors.text }]}>{message}</Text>
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={[styles.retry, { borderColor: colors.line }]}
        >
          <Text style={[styles.retryText, { color: colors.text }]}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    borderWidth: borders.hairline,
    gap: 10,
    margin: 20,
    paddingHorizontal: 20,
    paddingVertical: 20,
  },
  message: {
    ...t("small"),
  },
  retry: {
    alignSelf: "flex-start",
    borderRadius: radii.md,
    borderWidth: borders.hairline,
    marginTop: 4,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  retryText: {
    fontFamily: family.sansMedium,
    fontSize: t("mono").fontSize,
  },
  title: {
    fontFamily: family.sansMedium,
    fontSize: t("body").fontSize,
  },
});
