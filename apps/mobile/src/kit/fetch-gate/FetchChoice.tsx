// Gated-fetch choice UI (`fetchAccess`): held preview plus the one tap that
// spends bytes — never a silent fetch, never a spinner. Theme-token geometry.

import React from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Pressable, StyleSheet, View } from "react-native";

import Icon from "../components/Icon";
import { Text } from "../components/NativeText";
import { radii, spacing, t, useTheme } from "../theme";

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  chip: {
    alignItems: "center",
    borderRadius: radii.pill,
    borderWidth: 1,
    bottom: spacing[3],
    flexDirection: "row",
    gap: spacing[1],
    insetInlineStart: spacing[3],
    minHeight: 44,
    paddingHorizontal: spacing[3],
    position: "absolute",
  },
  chipText: { ...t("control") },
});

/** Standalone chip for callers that don't need the centred wrapper. */
export function FetchChoiceChip({
  label,
  onPress,
  accessibilityLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={[
        styles.chip,
        { backgroundColor: colors.stage, borderColor: colors.stageLine },
        style,
      ]}
    >
      <Icon name="download" size={15} color={colors.onStage} />
      <Text style={[styles.chipText, { color: colors.onStage }]}>{label}</Text>
    </Pressable>
  );
}

/** Preview + chip; renders when `fetchAccess` answers `needs-choice`. */
export function FetchChoicePlaceholder({
  width,
  height,
  label,
  accessibilityLabel,
  onFetch,
  children,
}: {
  width: number;
  height: number;
  label: string;
  accessibilityLabel: string;
  onFetch: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={[styles.center, { width, height }]}>
      {children}
      <FetchChoiceChip
        accessibilityLabel={accessibilityLabel}
        label={label}
        onPress={onFetch}
      />
    </View>
  );
}
