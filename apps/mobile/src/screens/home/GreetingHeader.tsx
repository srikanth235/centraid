// The editorial greeting header at the top of the springboard Home (issue #498,
// Slice B). A time-of-day salutation set upright in the Playfair serif, the
// profile name in its italic and tinted with the profile colour, next to a round
// identity avatar that opens the Space drawer.
//
// The avatar is the drawer handle: tapping it (or the left-edge swipe Home owns)
// opens the Space menu. It carries the profile colour + initial so identity and
// the "switch space" affordance read as one thing.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { family, useTheme, type ThemeColors } from '../../kit/theme';
import { firstNameOf, greetingFor, initialsOf } from '../../lib/profile';

export interface GreetingHeaderProps {
  name: string;
  // Raw hex profile colour (see lib/profile). Tints the name + the avatar.
  color: string;
  onOpenMenu: () => void;
}

export default function GreetingHeader({
  name,
  color,
  onOpenMenu,
}: GreetingHeaderProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = React.useMemo(() => makeStyles(colors), [colors]);
  // Salutation follows the device clock at mount (see lib/profile.greetingFor).
  const hello = greetingFor();
  const tint = /^#[0-9a-fA-F]{6}$/.test(color) ? color : colors.accent;
  const display = firstNameOf(name) || 'there';

  return (
    <View style={styles.row}>
      <View style={styles.greeting}>
        <Text style={styles.hello}>{hello},</Text>
        <Text style={[styles.name, { color: tint }]} numberOfLines={1}>
          {display}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open space menu"
        onPress={onOpenMenu}
        hitSlop={10}
        style={({ pressed }) => [
          styles.avatar,
          { backgroundColor: tint },
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.avatarInitial}>{initialsOf(name)}</Text>
      </Pressable>
    </View>
  );
}

const AVATAR = 42;

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    avatar: {
      alignItems: 'center',
      borderRadius: AVATAR / 2,
      height: AVATAR,
      justifyContent: 'center',
      width: AVATAR,
    },
    avatarInitial: {
      color: '#fff',
      fontFamily: family.displayBold,
      fontSize: 17,
    },
    greeting: { flex: 1, paddingRight: 12 },
    hello: {
      color: colors.ink2,
      fontFamily: family.serif,
      fontSize: 15,
      letterSpacing: 0.2,
    },
    name: {
      fontFamily: family.serifItalic,
      fontSize: 28,
      letterSpacing: -0.3,
      marginTop: 1,
    },
    pressed: { opacity: 0.7 },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      paddingBottom: 14,
      paddingHorizontal: 20,
      paddingTop: 4,
    },
  });
