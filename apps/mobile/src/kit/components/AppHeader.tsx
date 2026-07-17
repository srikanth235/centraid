import React, { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { IconName } from '@centraid/design-tokens';
import Icon from './Icon';
import { radii, spacing, t, useTheme, type ThemeColors } from '../theme';

export interface AppHeaderProps {
  title: string;
  subtitle?: string;
  color: string;
  iconKey: IconName;
  onBack: () => void;
}

export default function AppHeader({
  title,
  subtitle,
  color,
  iconKey,
  onBack,
}: AppHeaderProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.bar}>
      <Pressable onPress={onBack} hitSlop={12} style={styles.backBtn}>
        <Icon name="ArrowLeft" size={20} color={colors.ink} />
      </Pressable>
      <View style={[styles.iconWrap, { backgroundColor: color }]}>
        <Icon name={iconKey} size={16} color="#fff" strokeWidth={2} />
      </View>
      <View style={styles.titleWrap}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backBtn: { padding: spacing[1] },
    bar: {
      alignItems: 'center',
      backgroundColor: colors.bg,
      borderBottomColor: colors.line,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: spacing[3],
      paddingBottom: spacing[3],
      paddingHorizontal: spacing[4],
      paddingTop: spacing[3],
    },
    iconWrap: {
      alignItems: 'center',
      borderRadius: radii.sm,
      height: 32,
      justifyContent: 'center',
      width: 32,
    },
    subtitle: { ...t('tiny'), color: colors.ink3, marginTop: 2 },
    title: { ...t('bodyStrong'), color: colors.ink },
    titleWrap: { flex: 1, minWidth: 0 },
  });
