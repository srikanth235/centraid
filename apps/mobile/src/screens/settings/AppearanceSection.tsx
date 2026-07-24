// Settings → Appearance (issue #498) — a three-way segmented control over the
// device-local theme override (System / Light / Dark). Writing the preference
// (kit/theme/appearance) re-renders every themed surface immediately, so the
// choice previews live under the finger. 'System' follows the OS scheme.

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  setAppearance,
  spacing,
  t,
  useAppearance,
  useTheme,
  type Appearance,
  type ThemeColors,
} from '../../kit/theme';
import SettingsSection from './SettingsSection';

const OPTIONS: ReadonlyArray<{ value: Appearance; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function AppearanceSection(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const current = useAppearance();

  return (
    <SettingsSection label="Appearance">
      <View style={styles.segment}>
        {OPTIONS.map((opt) => {
          const active = opt.value === current;
          return (
            <Pressable
              key={opt.value}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={opt.label}
              onPress={() => setAppearance(opt.value)}
              style={[styles.seg, active && styles.segActive]}
            >
              <Text style={[styles.segLabel, active && styles.segLabelActive]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.help}>
        Choose how Centraid looks. System follows your phone&apos;s light or dark setting.
      </Text>
    </SettingsSection>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    help: { ...t('small'), color: colors.ink3, marginTop: spacing[3] },
    seg: {
      alignItems: 'center',
      borderRadius: 8,
      flex: 1,
      paddingVertical: 9,
    },
    segActive: { backgroundColor: colors.accent },
    segLabel: { ...t('body'), color: colors.ink2 },
    segLabelActive: { color: '#fff' },
    segment: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 11,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 4,
      padding: 3,
    },
  });
