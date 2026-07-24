import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';

import { family, useTheme } from '../../kit/theme';
import type { ThemeColors } from '../../kit/theme/resolve';
import type { PhotosScreenProps } from '../../navigation';

type Nav = PhotosScreenProps<'PhotosHome'>['navigation'];

const SUGGESTIONS = [
  'Everywhere I traveled this year',
  'My number plate',
  'When did Priya learn to swim?',
];

export default function PhotosAskView({ navigation }: { navigation: Nav }): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const search = (): void => navigation.navigate('PhotosSearch');
  // The floating nav pill + FAB overlay the bottom strip (PhotosHome renders them
  // position:absolute over this view). Lift the composer clear of them: the bar is
  // ~64pt tall over the home-indicator inset, so pad past both plus a gap.
  const barClearance = insets.bottom + 64 + 16;

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.empty}>
          <View style={[styles.accentTile, { backgroundColor: colors.accent }]}>
            <Feather name="search" size={26} color="#fff" />
            <Feather name="star" size={13} color="#fff" style={styles.accentStar} />
          </View>
          <Text style={[styles.headline, { color: colors.ink }]}>
            Looking for one particular photo?
          </Text>
          <Text style={[styles.subcopy, { color: colors.ink3 }]}>
            Ask in your own words. Centraid searches faces, places, text and moments across your
            vault — privately, on your device.
          </Text>
        </View>

        <View style={styles.tryBlock}>
          <Text style={[styles.eyebrow, { color: colors.ink3 }]}>TRY ASKING</Text>
          {SUGGESTIONS.map((suggestion) => (
            <Pressable
              key={suggestion}
              onPress={search}
              style={[styles.bubble, { backgroundColor: colors.bgSunken }]}
            >
              <Text style={[styles.bubbleText, { color: colors.ink }]}>{suggestion}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>

      <View
        style={[
          styles.inputBar,
          { backgroundColor: colors.bg, borderTopColor: colors.line, paddingBottom: barClearance },
        ]}
      >
        <Pressable
          style={[styles.input, { backgroundColor: colors.bgSunken }]}
          onPress={search}
          accessibilityRole="button"
          accessibilityLabel="Ask about your photos"
        >
          <Text style={[styles.inputText, { color: colors.ink3 }]}>Ask about your photos…</Text>
        </Pressable>
        <Pressable
          style={[styles.send, { backgroundColor: colors.accent }]}
          onPress={search}
          accessibilityLabel="Send"
        >
          <Feather name="arrow-right" size={20} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (_colors: ThemeColors): ReturnType<typeof StyleSheet.create> =>
  StyleSheet.create({
    accentStar: { position: 'absolute', right: 12, top: 12 },
    accentTile: {
      alignItems: 'center',
      borderRadius: 17,
      height: 60,
      justifyContent: 'center',
      width: 60,
    },
    bubble: {
      alignSelf: 'flex-end',
      borderRadius: 18,
      borderBottomRightRadius: 5,
      maxWidth: '82%',
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    bubbleText: { fontFamily: family.sansRegular, fontSize: 15, textAlign: 'right' },
    empty: { alignItems: 'center', paddingHorizontal: 30, paddingVertical: 16 },
    eyebrow: {
      alignSelf: 'flex-start',
      fontFamily: family.monoMedium,
      fontSize: 11,
      letterSpacing: 0.9,
      marginBottom: 2,
    },
    headline: {
      fontFamily: family.displayBold,
      fontSize: 24,
      letterSpacing: -0.6,
      lineHeight: 29,
      marginTop: 20,
      textAlign: 'center',
    },
    input: {
      flex: 1,
      borderRadius: 23,
      height: 46,
      justifyContent: 'center',
      paddingHorizontal: 18,
    },
    inputBar: {
      alignItems: 'center',
      borderTopWidth: 0.5,
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    inputText: { fontFamily: family.sansRegular, fontSize: 15 },
    root: { flex: 1 },
    scroll: { flexGrow: 1, justifyContent: 'center', paddingBottom: 8 },
    send: {
      alignItems: 'center',
      borderRadius: 23,
      height: 46,
      justifyContent: 'center',
      width: 46,
    },
    subcopy: {
      fontFamily: family.sansRegular,
      fontSize: 15,
      lineHeight: 21,
      marginTop: 9,
      maxWidth: 288,
      textAlign: 'center',
    },
    tryBlock: {
      alignItems: 'flex-end',
      gap: 10,
      paddingBottom: 8,
      paddingHorizontal: 16,
      paddingTop: 8,
    },
  });
