import React, { useMemo } from "react";
import { Pressable, StyleSheet } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

/** The Library header's explicit mode-entry control. */
export default function PhotosSelectChip({
  disabled,
  onPress,
}: {
  disabled: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Select"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.chip}
    >
      <Text style={styles.text}>Select</Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    chip: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      paddingHorizontal: 8,
    },
    text: { ...t("control"), color: colors.text },
  });
