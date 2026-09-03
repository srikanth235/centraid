import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { borders, t, useTheme, radii } from "../theme";
import { Text } from "./NativeText";

export interface OutOfRoomProps {
  cause: string;
  consequence: string;
  usedLabel?: string;
  limitLabel?: string;
  fractionUsed?: number;
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
      {/* THE line that matters — largest on purpose. */}
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
      {/* Outlined, never filled: not a confirm flow. */}
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
      borderRadius: radii.md,
      borderWidth: 1,
      marginTop: 4,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    actionPressed: { opacity: 0.6 },
    cause: { ...t("small") },
    consequence: { ...t("title") },
    meter: {
      borderRadius: radii.pill,
      height: 4,
      overflow: "hidden",
    },
    meterFill: { height: "100%" },
    wrap: {
      borderRadius: radii.lg,
      borderWidth: borders.hairline,
      gap: 8,
      padding: 16,
    },
  });
