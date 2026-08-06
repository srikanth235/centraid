// `out of room` — the fourth designed state (Binding Layer brief, "States"),
// mirroring packages/client/src/react/ui/states.tsx's OutOfRoom structurally:
// cause, consequence, one action. Never edit that file from here — read it
// for structure only.
//
// Mobile had the sentence (../../lib/replica/replica-storage-error.ts) with
// no component consuming it (issue #708 gap). This is that component, wired
// to ReplicaProvider's `storageFull` flag, itself set from the real
// `isReplicaStorageFullError` signal raised by the op-sqlite driver.
//
// Desktop's variant also plots a bounded quota (used/limit bytes, a meter).
// The mobile signal is an OS ENOSPC/SQLITE_FULL error with no knowable device
// quota to plot, so the meter is optional here — supplied only when a caller
// actually has used/limit figures. Cause and consequence are mandatory
// either way; the consequence line still outranks the cause, same as
// desktop.
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { borders, t, useTheme } from "../theme";
import { Text } from "./NativeText";

export interface OutOfRoomProps {
  /** The CAUSE, stated plainly. "Phone storage is full." */
  cause: string;
  /** The CONSEQUENCE — the line that matters, and the largest thing here. */
  consequence: string;
  /** Optional numeric line + meter, only when a real used/limit is known. */
  usedLabel?: string;
  limitLabel?: string;
  /** 0–1. Above 1 the meter takes the danger tone rather than overflowing. */
  fractionUsed?: number;
  /** ONE action. A list of remedies is a way of not choosing one. */
  actionLabel: string;
  onAction: () => void;
}

export default function OutOfRoom({
  cause,
  consequence,
  usedLabel,
  limitLabel,
  fractionUsed,
  actionLabel,
  onAction,
}: OutOfRoomProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = makeStyles();
  const showMeter =
    fractionUsed !== undefined &&
    usedLabel !== undefined &&
    limitLabel !== undefined;
  const over = showMeter && fractionUsed >= 1;
  return (
    <View
      style={[styles.wrap, { borderColor: colors.lineStrong }]}
      accessibilityRole="summary"
    >
      <Text style={[styles.cause, { color: colors.textSoft }]}>{cause}</Text>
      {/* THE line that matters — largest thing in the block on purpose. */}
      <Text style={[styles.consequence, { color: colors.text }]}>
        {consequence}
      </Text>
      {showMeter ? (
        <>
          <View style={[styles.meter, { backgroundColor: colors.bgSunken }]}>
            <View
              style={[
                styles.meterFill,
                {
                  backgroundColor: over ? colors.danger : colors.warning,
                  width: `${Math.min(1, Math.max(0, fractionUsed)) * 100}%`,
                },
              ]}
            />
          </View>
          <Text style={[t("mono"), { color: colors.textFaint }]}>
            {usedLabel} of {limitLabel}
          </Text>
        </>
      ) : null}
      {/* An outlined action, never a filled surface — this state is not a
          confirm flow, and nothing here is destructive. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        onPress={onAction}
        style={({ pressed }) => [
          styles.action,
          { borderColor: colors.lineStrong },
          pressed && styles.actionPressed,
        ]}
      >
        <Text style={[t("smallStrong"), { color: colors.text }]}>
          {actionLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    action: {
      alignSelf: "flex-start",
      borderRadius: 7,
      borderWidth: 1,
      marginTop: 4,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    actionPressed: { opacity: 0.6 },
    cause: { ...t("small") },
    consequence: { ...t("title") },
    meter: {
      borderRadius: 999,
      height: 4,
      overflow: "hidden",
    },
    meterFill: { height: "100%" },
    wrap: {
      borderRadius: 12,
      borderWidth: borders.hairline,
      gap: 8,
      padding: 16,
    },
  });
