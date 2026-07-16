import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  TextInput,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import type { AppMetaResolved } from '@centraid/design-tokens';
import Tile from '../kit/components/Tile';
import Icon from '../kit/components/Icon';
import Logo from '../kit/components/Logo';
import Button from '../kit/components/Button';
import { spacing, t, family, useTheme, type ThemeColors } from '../kit/theme';
import { GatewayError, listApps, resolveAppMeta, resolveGatewayBase } from '../lib/gateway';
import type { AppsScreenProps } from '../navigation';

const COLS = 4;
const H_PADDING = 22;

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
      // Tunnel first, manual URL second. `undefined` means neither is set
      // up yet — the empty state points at pairing.
      const base = await resolveGatewayBase();
      if (!base) {
        setState({ kind: 'no-gateway' });
        return;
      }
      const rows = await listApps();
      setState({ apps: rows.map(resolveAppMeta), kind: 'ready' });
    } catch (err) {
      const message =
        err instanceof GatewayError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not load apps.';
      setState({ kind: 'error', message });
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

  const visibleApps = state.kind === 'ready' ? state.apps : [];
  const q = query.trim().toLowerCase();
  const matches = q
    ? visibleApps.filter(
        (a) => a.name.toLowerCase().includes(q) || (a.desc || '').toLowerCase().includes(q),
      )
    : visibleApps;

  const openSearch = (): void => {
    setSearching(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const closeSearch = (): void => {
    setSearching(false);
    setQuery('');
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
              placeholder="Search apps"
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
              <Logo size={26} />
              <Text style={styles.title}>centraid</Text>
            </View>
            <View style={styles.headerActions}>
              {state.kind === 'ready' ? (
                <Pressable
                  onPress={() => navigation.navigate('SettingsTab', { screen: 'Approvals' })}
                  style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
                  accessibilityLabel="Approvals"
                >
                  <Icon name="CheckCircle" size={18} color={colors.ink} strokeWidth={1.75} />
                </Pressable>
              ) : null}
              <Pressable
                onPress={openSearch}
                style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
                accessibilityLabel="Search"
              >
                <Icon name="Search" size={18} color={colors.ink} strokeWidth={1.75} />
              </Pressable>
              <Pressable
                onPress={() => navigation.navigate('SettingsTab', { screen: 'Settings' })}
                style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}
                accessibilityLabel="Settings"
              >
                <Icon name="Settings" size={18} color={colors.ink} strokeWidth={1.75} />
              </Pressable>
            </View>
          </>
        )}
      </View>

      <ScrollView
        contentContainerStyle={styles.gridWrap}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.ink3}
          />
        }
      >
        {renderBody(
          state,
          matches,
          query,
          () => navigation.navigate('SettingsTab', { screen: 'Settings' }),
          navigation,
          styles,
          colors,
        )}
      </ScrollView>

      {!searching && (
        <View style={styles.dots}>
          <View style={[styles.dot, styles.dotActive]} />
          <View style={styles.dot} />
        </View>
      )}

      <Pressable
        onPress={() => navigation.navigate('MobileFallback')}
        style={({ pressed }) => [styles.fab, pressed && { transform: [{ scale: 0.96 }] }]}
        accessibilityLabel="New app"
      >
        <Icon name="Plus" size={26} color="#fff" strokeWidth={2.2} />
      </Pressable>
    </SafeAreaView>
  );
}

function renderBody(
  state: HomeState,
  matches: AppMetaResolved[],
  query: string,
  openSettings: () => void,
  navigation: AppsScreenProps<'Home'>['navigation'],
  styles: ReturnType<typeof makeStyles>,
  colors: ThemeColors,
): React.JSX.Element {
  if (state.kind === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.ink3} />
      </View>
    );
  }
  if (state.kind === 'no-gateway') {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Connect to your desktop.</Text>
        <Text style={styles.emptyCopy}>
          Apps you build on your Mac show up here. Scan the pairing QR code once and everything
          loads over an encrypted tunnel.
        </Text>
        <View style={styles.emptyAction}>
          <Button label="Pair with your desktop" icon="Camera" onPress={openSettings} />
        </View>
        <View style={styles.emptyAction}>
          <Button label="Open Settings" icon="Settings" variant="soft" onPress={openSettings} />
        </View>
      </View>
    );
  }
  if (state.kind === 'error') {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Gateway unreachable.</Text>
        <Text style={styles.emptyCopy}>{state.message}</Text>
        <Text style={styles.emptyHint}>
          Make sure Centraid is running on your Mac and both devices are online. Pull to refresh
          once reconnected.
        </Text>
        <View style={styles.emptyAction}>
          <Button label="Check Settings" icon="Settings" variant="soft" onPress={openSettings} />
        </View>
      </View>
    );
  }
  if (matches.length === 0) {
    if (query) {
      return <Text style={styles.searchEmpty}>No apps match "{query}".</Text>;
    }
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>No apps yet.</Text>
        <Text style={styles.emptyCopy}>
          Open Centraid on your Mac and create your first app. It'll appear here.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.grid}>
      {matches.map((app) => (
        <View key={app.id} style={styles.cell}>
          <Tile app={app} onPress={() => navigation.navigate('AppDetail', { appId: app.id })} />
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    cell: {
      alignItems: 'center',
      width: `${100 / COLS}%`,
    },
    center: { alignItems: 'center', paddingVertical: 80 },
    dot: {
      backgroundColor: colors.ink4,
      borderRadius: 3,
      height: 6,
      width: 6,
    },
    dotActive: { backgroundColor: colors.ink2 },
    dots: {
      flexDirection: 'row',
      gap: 6,
      justifyContent: 'center',
      paddingBottom: 14,
    },
    empty: {
      alignItems: 'flex-start',
      paddingHorizontal: 4,
      paddingTop: 32,
    },
    emptyAction: { alignSelf: 'stretch', marginTop: spacing[4] },
    emptyCopy: { ...t('body'), color: colors.ink2, marginBottom: spacing[3] },
    emptyHint: { ...t('small'), color: colors.ink3 },
    emptyTitle: { ...t('title'), color: colors.ink, marginBottom: spacing[2] },
    fab: {
      alignItems: 'center',
      backgroundColor: colors.accent,
      borderRadius: 28,
      bottom: 96,
      elevation: 6,
      height: 56,
      justifyContent: 'center',
      position: 'absolute',
      right: 22,
      shadowColor: colors.accent,
      shadowOffset: { height: 8, width: 0 },
      shadowOpacity: 0.4,
      shadowRadius: 24,
      width: 56,
    },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      rowGap: 22,
    },
    gridWrap: {
      paddingBottom: 24,
      paddingHorizontal: H_PADDING,
      paddingTop: 18,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 44,
      paddingHorizontal: H_PADDING,
      paddingVertical: 4,
    },
    headerActions: { flexDirection: 'row', gap: 10 },
    iconBtn: {
      alignItems: 'center',
      borderColor: colors.line,
      borderRadius: 8,
      borderWidth: 1,
      height: 36,
      justifyContent: 'center',
      width: 36,
    },
    safe: { backgroundColor: colors.bg, flex: 1 },
    searchEmpty: {
      ...t('small'),
      color: colors.ink3,
      marginTop: 32,
      textAlign: 'center',
    },
    searchField: {
      alignItems: 'center',
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderRadius: 8,
      borderWidth: 1,
      flex: 1,
      flexDirection: 'row',
      gap: 8,
      height: 36,
      paddingHorizontal: 10,
    },
    searchInput: {
      flex: 1,
      ...t('body'),
      color: colors.ink,
      padding: 0,
    },
    title: {
      color: colors.ink,
      fontFamily: family.displayBold,
      fontSize: 18,
      letterSpacing: -0.4,
    },
    wordmark: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
    },
  });
