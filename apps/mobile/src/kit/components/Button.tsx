import React, { useMemo } from 'react';
import { Pressable, View, Text, StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import type { IconName } from '@centraid/design-tokens';
import Icon from './Icon';
import { radii, spacing, t, useTheme, type ThemeColors } from '../theme';

export type ButtonVariant = 'primary' | 'soft' | 'ghost';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export default function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  style,
}: ButtonProps): React.JSX.Element {
  const isPrimary = variant === 'primary';
  const isSoft = variant === 'soft';
  const isGhost = variant === 'ghost';
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.base,
        isPrimary && styles.primary,
        isSoft && styles.soft,
        isGhost && styles.ghost,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}
    >
      <View style={styles.row}>
        {icon ? (
          <Icon
            name={icon}
            size={14}
            color={isPrimary ? colors.inkInv : colors.ink}
            strokeWidth={isPrimary ? 2 : 1.75}
          />
        ) : null}
        <Text style={[styles.label, isPrimary && styles.labelPrimary]}>{label}</Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    base: {
      borderRadius: radii.md,
      borderWidth: 1,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    disabled: { opacity: 0.4 },
    ghost: { backgroundColor: 'transparent', borderColor: 'transparent' },
    label: { ...t('small'), color: colors.ink, fontWeight: '500' },
    labelPrimary: { color: colors.inkInv },
    pressed: { opacity: 0.85 },
    primary: { backgroundColor: colors.ink, borderColor: colors.ink },
    row: { alignItems: 'center', flexDirection: 'row', gap: spacing[2], justifyContent: 'center' },
    soft: { backgroundColor: colors.bgElev, borderColor: colors.line },
  });
