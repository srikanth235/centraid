// The universal-search overlay (issue #498, Slice B change #6). Dock Search
// raises this as a full-screen frosted sheet — local component state, not a nav
// route, so it's cheap to open and dismiss. It autofocuses an input, filters the
// eight-app grid live, and hints that deeper search (photos, docs, people)
// arrives with the gateway.
//
// Tapping the scrim dismisses: the blurred background sits under a full-screen
// Pressable, and the content layer is `box-none`, so a tap on empty space falls
// through to close while taps on the input / a tile / Cancel are handled.

import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from '../../kit/components/Icon';
import LauncherGrid from './LauncherGrid';
import { filterLauncherItems, type LauncherItem } from './catalog';
import { family, t, useTheme, type ThemeColors, type Scheme } from '../../kit/theme';

const H_PADDING = 20;

// Full-screen scrim. The original layered an expo-blur BlurView beneath this
// film; that native module isn't wired into this build yet (deferred polish),
// so the scrim runs near-opaque to stay legible over any content beneath it.
const TINT: Record<Scheme, string> = {
  light: 'rgba(241, 236, 225, 0.97)',
  dark: 'rgba(16, 19, 24, 0.97)',
};

export interface SearchOverlayProps {
  items: readonly LauncherItem[];
  onOpen(item: LauncherItem): void;
  onClose(): void;
}

export default function SearchOverlay({
  items,
  onOpen,
  onClose,
}: SearchOverlayProps): React.JSX.Element {
  const { colors, scheme } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');

  const matches = useMemo(() => filterLauncherItems(items, query), [items, query]);
  const trimmed = query.trim();

  return (
    <View style={StyleSheet.absoluteFill}>
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: TINT[scheme] }]}
        pointerEvents="none"
      />
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close search"
      />

      <View style={[styles.content, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <View style={styles.searchRow}>
          <View style={styles.field}>
            <Icon name="Search" size={17} color={colors.ink3} strokeWidth={1.8} />
            <TextInput
              autoFocus
              value={query}
              onChangeText={setQuery}
              placeholder="Search your apps"
              placeholderTextColor={colors.ink3}
              style={styles.input}
              returnKeyType="search"
              autoCorrect={false}
              autoCapitalize="none"
            />
          </View>
          <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Cancel search">
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.results}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {matches.length ? (
            <LauncherGrid items={matches} onOpen={onOpen} />
          ) : (
            <Text style={styles.empty}>No apps match &ldquo;{trimmed}&rdquo;.</Text>
          )}

          <View style={styles.hint}>
            <Icon name="Sparkle" size={15} color={colors.ink3} strokeWidth={1.7} />
            <Text style={styles.hintText}>
              Deeper search — photos, docs and people — arrives once your desktop is paired.
            </Text>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    cancel: { ...t('body'), color: colors.accent, fontFamily: family.sansMedium },
    content: { flex: 1, paddingHorizontal: H_PADDING },
    empty: { ...t('small'), color: colors.ink2, paddingVertical: 8 },
    field: {
      alignItems: 'center',
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flex: 1,
      flexDirection: 'row',
      gap: 8,
      height: 46,
      paddingHorizontal: 12,
    },
    hint: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      marginTop: 28,
      paddingRight: 12,
    },
    hintText: { ...t('small'), color: colors.ink3, flex: 1, lineHeight: 18 },
    input: { ...t('body'), color: colors.ink, flex: 1, padding: 0 },
    results: { paddingTop: 22 },
    searchRow: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  });
