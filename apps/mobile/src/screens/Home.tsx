// governance: allow-repo-hygiene file-size-limit cohesive design-port launcher screen (greeting + app grid + automations + bottom bar); decompose into subcomponents in a follow-up (#498)
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import type { AppMetaResolved } from '@centraid/design-tokens';

import Icon from '../kit/components/Icon';
import { family, spacing, t, useTheme, type ThemeColors } from '../kit/theme';
import { GatewayError, listApps, resolveAppMeta, resolveGatewayBase } from '../lib/gateway';
import {
  firstNameOf,
  getProfileColor,
  getProfileName,
  greetingFor,
  initialsOf,
} from '../lib/profile';
import type { AppsScreenProps } from '../navigation';

const H_PADDING = 20;
const NATIVE_APPS: readonly AppMetaResolved[] = [
  resolveAppMeta({
    id: 'photos',
    name: 'Photos',
    description: 'Timeline, memories, albums and private backup.',
    iconKey: 'Camera',
    colorKey: 'ochre',
  }),
  resolveAppMeta({
    id: 'docs',
    name: 'Docs',
    description: 'Files, folders, offline search and secure custody.',
    iconKey: 'Folder',
    colorKey: 'slate',
  }),
  resolveAppMeta({
    id: 'agenda',
    name: 'Agenda',
    description: 'Calendar, schedule, guests and reminders.',
    iconKey: 'Calendar',
    colorKey: 'indigo',
  }),
];

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

type HomeState =
  | { kind: 'loading' }
  | { kind: 'no-gateway' }
  | { kind: 'ready'; apps: AppMetaResolved[] }
  | { kind: 'error'; message: string };

export default function HomeScreen({ navigation }: AppsScreenProps<'Home'>): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<HomeState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [profile, setProfile] = useState(() => ({
    name: getProfileName(),
    color: getProfileColor(),
  }));
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
      setProfile({ name: getProfileName(), color: getProfileColor() });
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
  const allApps = [...nativeMatches, ...remoteMatches];

  const openApp = (app: AppMetaResolved): void => {
    if (app.id === 'photos') navigation.navigate('Photos', { screen: 'PhotosHome' });
    else if (app.id === 'docs') navigation.navigate('Docs', { screen: 'DocsHome' });
    else if (app.id === 'agenda') navigation.navigate('Agenda', { screen: 'AgendaHome' });
    else navigation.navigate('AppDetail', { appId: app.id });
  };

  const greetName = firstNameOf(profile.name) || 'there';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {searching ? (
        <View style={styles.searchBar}>
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
        </View>
      ) : (
        <View style={styles.header}>
          <View style={styles.greetBlock}>
            <Text style={styles.date}>{DATE_FORMAT.format(new Date()).toUpperCase()}</Text>
            <Text style={styles.greet}>
              {greetingFor()},{'\n'}
              <Text style={[styles.greetName, { color: profile.color }]}>{greetName}</Text>
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Profile and settings"
            onPress={() => navigation.navigate('SettingsTab', { screen: 'Settings' })}
            style={({ pressed }) => [
              styles.avatar,
              { backgroundColor: profile.color },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.avatarText}>{initialsOf(profile.name)}</Text>
          </Pressable>
        </View>
      )}

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
        <Text style={styles.railLabel}>YOUR APPS</Text>

        {allApps.length ? (
          <View style={styles.appGrid}>
            {allApps.map((app) => (
              <LauncherTile key={app.id} app={app} onPress={() => openApp(app)} styles={styles} />
            ))}
          </View>
        ) : null}

        {state.kind === 'loading' ? (
          <View style={styles.statusRow}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.statusCopy}>Loading your apps…</Text>
          </View>
        ) : state.kind === 'no-gateway' ? (
          <ConnectionCard
            title="Connect your computer"
            copy="Pair once to bring every app you build into this launcher."
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
        ) : remoteMatches.length === 0 && q ? (
          <Text style={styles.statusCopy}>No apps match “{query}”.</Text>
        ) : null}

        <Pressable
          onPress={() => navigation.navigate('MobileFallback')}
          style={({ pressed }) => [styles.automationRow, pressed && { opacity: 0.85 }]}
        >
          <View style={[styles.automationIcon, { backgroundColor: colors.accent }]}>
            <Icon name="Sparkle" size={22} color="#fff" strokeWidth={1.6} />
          </View>
          <View style={styles.automationCopy}>
            <Text style={styles.automationTitle}>Automations</Text>
            <Text style={styles.automationSub}>3 running · 15 available</Text>
          </View>
          <Icon name="ChevronRight" size={18} color={colors.ink4} strokeWidth={2} />
        </Pressable>
      </ScrollView>

      <View style={[styles.tabBar, { paddingBottom: 9 + insets.bottom }]}>
        <TabItem
          label="Approvals"
          feather="check-circle"
          onPress={() => navigation.navigate('SettingsTab', { screen: 'Approvals' })}
          styles={styles}
          colors={colors}
        />
        <TabItem
          label="Search"
          feather="search"
          onPress={openSearch}
          styles={styles}
          colors={colors}
        />
        <View style={styles.fabColumn}>
          <Pressable
            accessibilityLabel="Assistant"
            onPress={() => navigation.navigate('MobileFallback')}
            style={({ pressed }) => [
              styles.fab,
              { backgroundColor: colors.accent },
              pressed && { opacity: 0.85 },
            ]}
          >
            <View style={styles.fabHighlight} pointerEvents="none" />
            <Icon name="Sparkle" size={24} color="#fff" strokeWidth={1.6} />
          </Pressable>
          <Text style={styles.fabLabel}>Assistant</Text>
        </View>
        <TabItem
          label="Settings"
          feather="settings"
          onPress={() => navigation.navigate('SettingsTab', { screen: 'Settings' })}
          styles={styles}
          colors={colors}
        />
        <TabItem
          label="Gateway"
          feather="bar-chart-2"
          onPress={() => navigation.navigate('SettingsTab', { screen: 'Settings' })}
          styles={styles}
          colors={colors}
        />
      </View>
    </SafeAreaView>
  );
}

function LauncherTile({
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
      style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
    >
      <View style={[styles.tileIcon, { backgroundColor: app.color }]}>
        <View style={styles.tileHighlight} pointerEvents="none" />
        <Icon name={app.iconKey} size={30} color="#fff" strokeWidth={1.7} />
      </View>
      <Text style={styles.tileLabel} numberOfLines={1}>
        {app.name}
      </Text>
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

function TabItem({
  label,
  feather,
  onPress,
  styles,
  colors,
}: {
  label: string;
  feather: React.ComponentProps<typeof Feather>['name'];
  onPress(): void;
  styles: ReturnType<typeof makeStyles>;
  colors: ThemeColors;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.tabItem, pressed && { opacity: 0.6 }]}
    >
      <Feather name={feather} size={22} color={colors.ink3} />
      <Text style={styles.tabLabel}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    appGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      rowGap: 20,
    },
    automationCopy: { flex: 1 },
    automationIcon: {
      alignItems: 'center',
      borderRadius: 13,
      elevation: 6,
      height: 46,
      justifyContent: 'center',
      shadowColor: colors.accent,
      shadowOffset: { height: 8, width: 0 },
      shadowOpacity: 0.4,
      shadowRadius: 12,
      width: 46,
    },
    automationRow: {
      alignItems: 'center',
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 14,
      marginTop: spacing[6],
      paddingHorizontal: 16,
      paddingVertical: 15,
    },
    automationSub: { ...t('small'), color: colors.ink3, marginTop: 1 },
    automationTitle: { ...t('bodyStrong'), color: colors.ink },
    avatar: {
      alignItems: 'center',
      borderRadius: 19,
      height: 38,
      justifyContent: 'center',
      width: 38,
    },
    avatarText: { color: '#fff', fontFamily: family.sansBold, fontSize: 14 },
    connectionAction: { paddingHorizontal: 4, paddingVertical: 8 },
    connectionActionText: { ...t('small'), color: colors.accent, fontFamily: family.sansBold },
    connectionCard: {
      alignItems: 'center',
      backgroundColor: colors.bgSunken,
      borderRadius: 14,
      flexDirection: 'row',
      gap: 12,
      marginTop: 22,
      padding: 14,
    },
    connectionCopy: { flex: 1 },
    connectionTitle: { ...t('bodyStrong'), color: colors.ink, marginBottom: 4 },
    content: { paddingBottom: 20, paddingHorizontal: H_PADDING, paddingTop: 6 },
    date: {
      color: colors.ink3,
      fontFamily: family.monoMedium,
      fontSize: 11,
      letterSpacing: 0.9,
    },
    fab: {
      alignItems: 'center',
      borderRadius: 26,
      elevation: 8,
      height: 52,
      justifyContent: 'center',
      overflow: 'hidden',
      shadowColor: colors.accent,
      shadowOffset: { height: 8, width: 0 },
      shadowOpacity: 0.45,
      shadowRadius: 12,
      transform: [{ translateY: -16 }],
      width: 52,
    },
    fabColumn: { alignItems: 'center', flex: 1 },
    fabHighlight: {
      backgroundColor: 'rgba(255,255,255,0.22)',
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      height: '52%',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    fabLabel: { color: colors.ink3, fontFamily: family.sansMedium, fontSize: 10, marginTop: -9 },
    greet: {
      color: colors.ink,
      fontFamily: family.serif,
      fontSize: 28,
      letterSpacing: -0.3,
      lineHeight: 33,
      marginTop: 9,
    },
    greetBlock: { flex: 1 },
    greetName: { fontFamily: family.serifItalic },
    header: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 52,
      paddingBottom: 22,
      paddingHorizontal: H_PADDING,
      paddingTop: 8,
    },
    railLabel: {
      color: colors.ink3,
      fontFamily: family.monoMedium,
      fontSize: 11,
      letterSpacing: 0.9,
      marginBottom: 16,
    },
    safe: { backgroundColor: colors.bg, flex: 1 },
    searchBar: { paddingBottom: 12, paddingHorizontal: H_PADDING, paddingTop: 8 },
    searchField: {
      alignItems: 'center',
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 10,
      borderWidth: 1,
      flexDirection: 'row',
      gap: 8,
      height: 44,
      paddingHorizontal: 12,
    },
    searchInput: { ...t('body'), color: colors.ink, flex: 1, padding: 0 },
    statusCopy: { ...t('small'), color: colors.ink2, lineHeight: 18 },
    statusRow: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingVertical: 14 },
    tabBar: {
      alignItems: 'flex-end',
      backgroundColor: colors.bgElev,
      borderTopColor: colors.line,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'space-around',
      paddingHorizontal: 8,
      paddingTop: 9,
    },
    tabItem: { alignItems: 'center', flex: 1, gap: 4 },
    tabLabel: { color: colors.ink3, fontFamily: family.sansMedium, fontSize: 10 },
    tile: { alignItems: 'center', gap: 9, width: '25%' },
    tileHighlight: {
      backgroundColor: 'rgba(255,255,255,0.16)',
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      height: '55%',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    tileIcon: {
      alignItems: 'center',
      borderRadius: 18,
      elevation: 4,
      height: 62,
      justifyContent: 'center',
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { height: 6, width: 0 },
      shadowOpacity: 0.22,
      shadowRadius: 10,
      width: 62,
    },
    tileLabel: { color: colors.ink2, fontFamily: family.sansMedium, fontSize: 12 },
    tilePressed: { opacity: 0.7, transform: [{ scale: 0.94 }] },
  });
