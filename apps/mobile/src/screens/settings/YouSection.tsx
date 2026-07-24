// Settings → You (issue #498) — the local profile: a display name and an accent
// colour for the avatar + Home greeting. The phone is a client of a desktop
// gateway, so this is a light device-local preference (see lib/profile), not the
// vault identity (that is Settings → Space). Edits persist as you type / tap and
// the avatar previews the colour + initials live.

import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { radii, spacing, t, useTheme, type ThemeColors } from '../../kit/theme';
import {
  PROFILE_COLORS,
  getProfileColor,
  getProfileName,
  initialsOf,
  setProfileColor,
  setProfileName,
} from '../../lib/profile';
import ColorSwatchRow from './ColorSwatchRow';
import SettingsSection from './SettingsSection';

export default function YouSection(): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [name, setName] = useState(getProfileName);
  const [color, setColor] = useState(getProfileColor);

  const onName = (value: string): void => {
    setName(value);
    setProfileName(value);
  };
  const onColor = (hex: string): void => {
    setColor(hex);
    setProfileColor(hex);
  };

  return (
    <SettingsSection label="You">
      <View style={styles.card}>
        <View style={styles.identity}>
          <View style={[styles.avatar, { backgroundColor: color }]}>
            <Text style={styles.avatarInitial}>{initialsOf(name)}</Text>
          </View>
          <TextInput
            value={name}
            onChangeText={onName}
            placeholder="Your name"
            placeholderTextColor={colors.ink3}
            style={styles.input}
            returnKeyType="done"
          />
        </View>

        <Text style={styles.fieldLabel}>Colour</Text>
        <ColorSwatchRow value={color} options={PROFILE_COLORS} onChange={onColor} />
      </View>
    </SettingsSection>
  );
}

const AVATAR = 44;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    avatar: {
      alignItems: 'center',
      borderRadius: AVATAR / 2,
      height: AVATAR,
      justifyContent: 'center',
      width: AVATAR,
    },
    avatarInitial: { color: '#fff', ...t('bodyStrong') },
    card: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      gap: spacing[3],
      padding: spacing[4],
    },
    fieldLabel: { ...t('small'), color: colors.ink2, fontWeight: '500', marginTop: spacing[1] },
    identity: { alignItems: 'center', flexDirection: 'row', gap: spacing[3] },
    input: {
      ...t('body'),
      backgroundColor: colors.bg,
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: 1,
      color: colors.ink,
      flex: 1,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
  });
