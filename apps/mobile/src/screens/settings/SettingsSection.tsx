import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import { family, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";

export interface SettingsSectionProps {
  label: string;
  children: React.ReactNode;
}

export default function SettingsSection({
  label,
  children,
}: SettingsSectionProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    label: {
      ...t("small"),
      color: colors.textFaint,
      fontFamily: family.sansMedium,
      letterSpacing: 0.8,
      marginBottom: spacing[3],
      textTransform: "uppercase",
    },
    section: { marginTop: spacing[6] },
  });
