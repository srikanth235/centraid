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

import { RETRY_ACTION } from "@centraid/client/surface-copy";

import { Text } from "../components/NativeText";
import type { ReplicaQueryConnection } from "../hooks/replica-query-state";
import { borders, family, radii, spacing, useTheme, t } from "../theme";

export default function ReplicaStateCard({
  connection,
  error,
  unavailableReason,
  noun,
  onRetry,
}: {
  connection: ReplicaQueryConnection;
  /** A SIGNAL that the read failed; never rendered. See `message` below. */
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
  // S14 (#1015): `error` is a SIGNAL that the read failed, never the words a
  // member reads. It arrives as `error.message` from five call sites — a
  // fetch's own sentence, a status code, a Swift filename — and printing it
  // told a member about the program rather than about their vault.
  const message = unavailable
    ? (unavailableReason ?? "Pair or reconnect a vault host.")
    : `${noun} is on this phone; the vault host could not be reached.`;
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
          <Text style={[styles.retryText, { color: colors.text }]}>
            {RETRY_ACTION}
          </Text>
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
    paddingHorizontal: spacing[5],
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
    paddingHorizontal: spacing[4],
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
