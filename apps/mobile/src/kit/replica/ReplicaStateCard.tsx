// The kit's own explanation block for a replica a member cannot currently
// read (Photos v4 handoff §14, README:333: "a grey mosaic with no explanation
// is a bug").
//
// Two defects this file used to carry, both load-bearing for every app that
// mounts it (Tally, People, Tasks, Photos, Notes, Agenda, Docs):
//
//   1. `connection === "offline"` fell through the old early-return (it only
//      excluded "unavailable"), so the one moment this card exists to cover —
//      a member who lost the gateway mid-session — rendered nothing at all.
//      Fixed by widening the guard to both no-data connection states.
//   2. The rendered shape was a filled elevated card with a 28px danger icon
//      and a filled accent button — the alarm grammar the handoff reserves
//      for something actually wrong, not for "this device can't reach the
//      gateway right now" (spec :4867-4873: bordered `--net` block, no fill,
//      no icon, sans body in ink, an OUTLINED retry).
//
// Kept app-agnostic on purpose: this is a kit component, not a Photos one, so
// its copy names no app-specific noun ("photographs") — `noun` is the only
// thing a caller supplies, and the offline sentence stays generic to whatever
// `noun` names.
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "../components/NativeText";
import type { ReplicaQueryConnection } from "../hooks/useReplicaQuery";
import { borders, family, radii, useTheme } from "../theme";

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
  const noData = connection === "unavailable" || connection === "offline";
  if (!noData && !error) return null;
  const unavailable = connection === "unavailable";
  const title = unavailable
    ? `${noun} is not connected`
    : error
      ? `${noun} could not be loaded`
      : `${noun} is offline`;
  // Adapted honestly from the handoff's offline-banner copy (:4871), which
  // names the gateway/device split directly — kept app-agnostic (no
  // "photographs", "captions", "albums") so it reads true for any `noun`
  // this card is ever mounted under.
  const message = unavailable
    ? (unavailableReason ??
      "Pair or reconnect a gateway. An unavailable vault is never treated as an empty one.")
    : (error ??
      "The gateway is unreachable. What renders here comes from this device; its bytes stay on the gateway until it's reachable again.");
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
    fontFamily: family.sansRegular,
    fontSize: 13,
    lineHeight: 19,
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
    fontSize: 13,
  },
  title: {
    fontFamily: family.sansMedium,
    fontSize: 15,
  },
});
