import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import type { AppMetaResolved } from '@centraid/design-tokens';

import Button from '../kit/components/Button';
import Icon from '../kit/components/Icon';
import Logo from '../kit/components/Logo';
import { family, spacing, t, useTheme, type ThemeColors } from '../kit/theme';
import { GatewayError, listApps, resolveAppMeta, resolveGatewayBase } from '../lib/gateway';
import type { AppsScreenProps } from '../navigation';

const H_PADDING = 18;
const NATIVE_APPS: readonly AppMetaResolved[] = [
  resolveAppMeta({
    id: 'photos',
    name: 'Photos',
    description: 'Timeline, memories, albums and private backup.',
    iconKey: 'Camera',
    colorKey: 'violet',
  }),
  resolveAppMeta({
    id: 'docs',
    name: 'Docs',
    description: 'Files, folders, offline search and secure custody.',
    iconKey: 'Folder',
    colorKey: 'indigo',
  }),
  resolveAppMeta({
    id: 'agenda',
    name: 'Agenda',
    description: 'Calendar, schedule, guests and reminders.',
    iconKey: 'Calendar',
    colorKey: 'rose',
  }),
];

type HomeState =
  | { kind: 'loading' }
  | { kind: 'no-gateway' }
  | { kind: 'ready'; apps: AppMetaResolved[] }
  | { kind: 'error'; message: string };

export default function HomeScreen({ navigation }: AppsScreenProps<'Home'>): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [state, setState] = useState<HomeState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<TextInput | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const base = await resolveGatewayBase();
      if (!base) {
        setState({ kind: 'no-gateway' });
        return;
      }
      const rows = await listApps();
      const nativeIds = new Set(NATIVE_APPS.map((app) => app.id));
      setState({
        apps: rows.map(resolveAppMeta).filter((app) => !nativeIds.has(app.id)),
        kind: 'ready',
      });
    } catch (error) {
      setState({
        kind: 'error',
        message:
          error instanceof GatewayError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Could not load apps.',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);
  const openSearch = (): void => {
    setSearching(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const closeSearch = (): void => {
    setSearching(false);
    setQuery('');
  };
  const q = query.trim().toLowerCase();
  const remoteApps = state.kind === 'ready' ? state.apps : [];
  const filter = (app: AppMetaResolved): boolean =>
    !q || app.name.toLowerCase().includes(q) || app.desc.toLowerCase().includes(q);
  const nativeMatches = NATIVE_APPS.filter(filter);
  const remoteMatches = remoteApps.filter(filter);

  const openApp = (app: AppMetaResolved): void => {
    if (app.id === 'photos') navigation.navigate('Photos', { screen: 'PhotosHome' });
    else if (app.id === 'docs') navigation.navigate('Docs', { screen: 'DocsHome' });
    else if (app.id === 'agenda') navigation.navigate('Agenda', { screen: 'AgendaHome' });
    else navigation.navigate('AppDetail', { appId: app.id });
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        {searching ? (
          <View style={styles.searchField}>
            <Icon name="Search" size={16} color={colors.ink3} strokeWidth={1.75} />
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={setQuery}
              placeholder="Search all apps"
              placeholderTextColor={colors.ink3}
              style={styles.searchInput}
              returnKeyType="search"
              autoCorrect={false}
              autoCapitalize="none"
            />
            <Pressable onPress={closeSearch} hitSlop={8} accessibilityLabel="Close search">
              <Icon name="X" size={18} color={colors.ink2} strokeWidth={1.75} />
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.wordmark}>
              <Logo size={27} />
              <Text style={styles.wordmarkText}>centraid</Text>
            </View>
            <View style={styles.headerActions}>
              <IconButton label="Search apps" icon="Search" onPress={openSearch} colors={colors} />
              <IconButton
                label="Settings"
                icon="Settings"
                onPress={() => navigation.navigate('SettingsTab', { screen: 'Settings' })}
                colors={colors}
              />
            </View>
          </>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.accent}
          />
        }
      >
        {!searching ? (
          <View style={styles.intro}>
            <Text style={styles.eyebrow}>YOUR PRIVATE SUPER-APP</Text>
            <Text style={styles.hero}>Everything you build, in one place.</Text>
            <Text style={styles.heroCopy}>
              Open a native workspace or any app from your Centraid desktop.
            </Text>
          </View>
        ) : null}

        {nativeMatches.length ? (
          <Section title="Built in" count={nativeMatches.length} styles={styles}>
            <View style={styles.appGrid}>
              {nativeMatches.map((app) => (
                <LauncherCard key={app.id} app={app} onPress={() => openApp(app)} styles={styles} />
              ))}
            </View>
          </Section>
        ) : null}

        <Section title="Your apps" count={remoteMatches.length} styles={styles}>
          {state.kind === 'loading' ? (
            <View style={styles.statusRow}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.statusCopy}>Loading desktop apps…</Text>
            </View>
          ) : state.kind === 'no-gateway' ? (
            <ConnectionCard
              title="Connect your desktop"
              copy="Pair once to bring every app you build into this library."
              action="Pair desktop"
              onPress={() => navigation.navigate('SettingsTab', { screen: 'Settings' })}
              styles={styles}
            />
          ) : state.kind === 'error' ? (
            <ConnectionCard
              title="Desktop is offline"
              copy={state.message}
              action="Check settings"
              onPress={() => navigation.navigate('SettingsTab', { screen: 'Settings' })}
              styles={styles}
            />
          ) : remoteMatches.length ? (
            <View style={styles.appGrid}>
              {remoteMatches.map((app) => (
                <LauncherCard key={app.id} app={app} onPress={() => openApp(app)} styles={styles} />
              ))}
            </View>
          ) : (
            <Text style={styles.statusCopy}>
              {q ? `No apps match “${query}”.` : 'Apps created on desktop will appear here.'}
            </Text>
          )}
        </Section>

        <View style={styles.buildPrompt}>
          <View style={styles.buildIcon}>
            <Icon name="Sparkle" size={22} color={colors.accent} />
          </View>
          <View style={styles.buildCopy}>
            <Text style={styles.buildTitle}>What should we build?</Text>
            <Text style={styles.statusCopy}>Start a new app with Centraid on desktop.</Text>
          </View>
          <Button
            label="New"
            icon="Plus"
            variant="soft"
            onPress={() => navigation.navigate('MobileFallback')}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({
  title,
  count,
  children,
  styles,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionCount}>{count}</Text>
      </View>
      {children}
    </View>
  );
}

function LauncherCard({
  app,
  onPress,
  styles,
}: {
  app: AppMetaResolved;
  onPress(): void;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${app.name}`}
      onPress={onPress}
      style={({ pressed }) => [styles.appCard, pressed && styles.appCardPressed]}
    >
      <View style={[styles.appIcon, { backgroundColor: app.color }]}>
        <Icon name={app.iconKey} size={25} color="#fff" strokeWidth={1.8} />
      </View>
      <Text style={styles.appName} numberOfLines={1}>
        {app.name}
      </Text>
      <Text style={styles.appDesc} numberOfLines={2}>
        {app.desc}
      </Text>
      <View style={styles.openRow}>
        <Text style={styles.openLabel}>Open</Text>
        <Icon name="ArrowRight" size={14} color={styles.openLabel.color} />
      </View>
    </Pressable>
  );
}

function ConnectionCard({
  title,
  copy,
  action,
  onPress,
  styles,
}: {
  title: string;
  copy: string;
  action: string;
  onPress(): void;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element {
  return (
    <View style={styles.connectionCard}>
      <View style={styles.connectionCopy}>
        <Text style={styles.connectionTitle}>{title}</Text>
        <Text style={styles.statusCopy}>{copy}</Text>
      </View>
      <Pressable onPress={onPress} style={styles.connectionAction}>
        <Text style={styles.connectionActionText}>{action}</Text>
      </Pressable>
    </View>
  );
}

function IconButton({
  label,
  icon,
  onPress,
  colors,
}: {
  label: string;
  icon: 'Search' | 'Settings';
  onPress(): void;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        { borderColor: colors.line },
        pressed && { opacity: 0.6 },
      ]}
    >
      <Icon name={icon} size={18} color={colors.ink} strokeWidth={1.75} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  iconButton: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
});

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    appCard: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 16,
      borderWidth: 1,
      minHeight: 172,
      padding: 14,
      width: '48.5%',
    },
    appCardPressed: { opacity: 0.88, transform: [{ scale: 0.97 }] },
    appDesc: { ...t('tiny'), color: colors.ink2, lineHeight: 17, marginTop: 5 },
    appGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    appIcon: {
      alignItems: 'center',
      borderRadius: 13,
      height: 48,
      justifyContent: 'center',
      marginBottom: 13,
      width: 48,
    },
    appName: { ...t('bodyStrong'), color: colors.ink },
    buildCopy: { flex: 1 },
    buildIcon: {
      alignItems: 'center',
      backgroundColor: colors.bgSunken,
      borderRadius: 12,
      height: 42,
      justifyContent: 'center',
      width: 42,
    },
    buildPrompt: {
      alignItems: 'center',
      borderColor: colors.line,
      borderRadius: 16,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 12,
      marginTop: spacing[7],
      padding: 14,
    },
    buildTitle: { ...t('bodyStrong'), color: colors.ink },
    connectionAction: { paddingHorizontal: 4, paddingVertical: 8 },
    connectionActionText: { ...t('small'), color: colors.accent, fontFamily: family.sansBold },
    connectionCard: {
      alignItems: 'center',
      backgroundColor: colors.bgSunken,
      borderRadius: 14,
      flexDirection: 'row',
      gap: 12,
      padding: 14,
    },
    connectionCopy: { flex: 1 },
    connectionTitle: { ...t('bodyStrong'), color: colors.ink, marginBottom: 4 },
    content: { paddingBottom: 44, paddingHorizontal: H_PADDING },
    eyebrow: {
      color: colors.accent,
      fontFamily: family.monoBold,
      fontSize: 10,
      letterSpacing: 1.2,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 52,
      paddingHorizontal: H_PADDING,
    },
    headerActions: { flexDirection: 'row', gap: 9 },
    hero: {
      color: colors.ink,
      fontFamily: family.displayBold,
      fontSize: 30,
      letterSpacing: -1.1,
      lineHeight: 35,
      marginTop: 8,
      maxWidth: 330,
    },
    heroCopy: { ...t('body'), color: colors.ink2, lineHeight: 21, marginTop: 9, maxWidth: 330 },
    intro: { paddingBottom: 28, paddingTop: 30 },
    openLabel: { ...t('tiny'), color: colors.accent, fontFamily: family.sansBold },
    openRow: {
      alignItems: 'center',
      bottom: 13,
      flexDirection: 'row',
      gap: 4,
      position: 'absolute',
      right: 13,
    },
    safe: { backgroundColor: colors.bg, flex: 1 },
    searchField: {
      alignItems: 'center',
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 10,
      borderWidth: 1,
      flex: 1,
      flexDirection: 'row',
      gap: 8,
      height: 40,
      paddingHorizontal: 11,
    },
    searchInput: { ...t('body'), color: colors.ink, flex: 1, padding: 0 },
    section: { marginTop: 25 },
    sectionCount: { ...t('tiny'), color: colors.ink3 },
    sectionHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 11,
    },
    sectionTitle: { ...t('bodyStrong'), color: colors.ink },
    statusCopy: { ...t('small'), color: colors.ink2, lineHeight: 18 },
    statusRow: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingVertical: 14 },
    wordmark: { alignItems: 'center', flexDirection: 'row', gap: 8 },
    wordmarkText: {
      color: colors.ink,
      fontFamily: family.displayBold,
      fontSize: 18,
      letterSpacing: -0.4,
    },
  });
