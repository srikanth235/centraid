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
