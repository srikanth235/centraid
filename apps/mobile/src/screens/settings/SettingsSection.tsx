// A labelled Settings section — a mono uppercase eyebrow over its content, with
// consistent top spacing so the Settings screen reads as evenly-spaced bands
// (You · Appearance · Space · Desktop link · Approvals · Advanced). Extracted so
// every section shares one label treatment and rhythm (issue #498).

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { family, spacing, t, useTheme, type ThemeColors } from '../../kit/theme';

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
      ...t('small'),
      color: colors.ink3,
      fontFamily: family.monoMedium,
      letterSpacing: 0.8,
      marginBottom: spacing[3],
      textTransform: 'uppercase',
    },
    section: { marginTop: spacing[6] },
  });
