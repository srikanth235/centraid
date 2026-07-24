// A row of colour swatches for picking a hex tint — shared by Settings → You
// (the profile colour) and Settings → Space (the vault colour) so both wear the
// same picker (issue #498). The selected swatch reads with a ring + check; the
// value is a raw hex string, matching how both callers store it.

import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useTheme, type ThemeColors } from '../../kit/theme';

export interface ColorSwatchRowProps {
  value: string;
  options: readonly string[];
  onChange(hex: string): void;
}

export default function ColorSwatchRow({
  value,
  options,
  onChange,
}: ColorSwatchRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      {options.map((hex) => {
        const active = hex.toLowerCase() === value.toLowerCase();
        return (
          <Pressable
            key={hex}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Colour ${hex}`}
            onPress={() => onChange(hex)}
            style={({ pressed }) => [
              styles.swatch,
              { backgroundColor: hex, borderColor: active ? colors.ink : 'transparent' },
              pressed && styles.pressed,
            ]}
          >
            {active ? <Feather name="check" size={16} color="#fff" /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const SIZE = 34;

const makeStyles = (_colors: ThemeColors) =>
  StyleSheet.create({
    pressed: { opacity: 0.7 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    swatch: {
      alignItems: 'center',
      borderRadius: SIZE / 2,
      borderWidth: 2,
      height: SIZE,
      justifyContent: 'center',
      width: SIZE,
    },
  });
