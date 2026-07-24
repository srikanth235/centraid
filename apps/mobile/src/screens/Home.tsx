// The springboard Home launcher (issue #498, Slice B). A thin composition over
// the pieces in ./home: the editorial greeting, the attention-first status line,
// the always-eight-apps grid, the floating glass dock, and the search overlay.
//
// Home owns only the data load and the navigation wiring; every visual block is
// its own component so this file stays a readable assembly (and under the
// repo-hygiene size cap, hence no exemption header).
//
// Data model: one `listAppRegistry()` fetch per load splits into openable apps
// (the grid, merged over the static catalog) and an automations count (the
// attention line); parked approvals load best-effort on top. When there's no
// gateway, the grid still renders — the eight apps show, gateway-hosted ones
// dimmed — so the launcher always advertises the full surface.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { useFocusEffect } from '@react-navigation/native';
import type { AppMetaResolved } from '@centraid/design-tokens';

import { family, useTheme, type ThemeColors } from '../kit/theme';
import {
  GatewayError,
  isOpenableApp,
  listAppRegistry,
  listParked,
  resolveAppMeta,
  resolveGatewayBase,
} from '../lib/gateway';
import { getProfileColor, getProfileName } from '../lib/profile';
import { subscribeSpaces } from '../lib/spaces';
import type { HomeScreenProps } from '../navigation';
import GreetingHeader from './home/GreetingHeader';
import AttentionLine, { type ConnectionState } from './home/AttentionLine';
import LauncherGrid from './home/LauncherGrid';
import GlassDock from './home/GlassDock';
import SearchOverlay from './home/SearchOverlay';
import SpaceDrawer from './home/SpaceDrawer';
import SpacesSwitcher from './home/SpacesSwitcher';
import { NATIVE_APP_IDS, buildLauncherItems, type LauncherItem } from './home/catalog';

const H_PADDING = 20;

// A drag must start within this many points of the left screen edge to open the
// Space drawer, so an edge-swipe never competes with in-content horizontal
// scroll (e.g. the attention line's chip strip).
const EDGE_ZONE = 24;

// Stable empty listing for the not-ready states — a fresh `[]` per render would
// defeat the `items` memo below (exhaustive-deps flags it).
const NO_APPS: readonly AppMetaResolved[] = [];

type HomeState =
  | { kind: 'loading' }
  | { kind: 'no-gateway' }
  | { kind: 'ready'; apps: AppMetaResolved[]; automations: number }
  | { kind: 'error'; message: string };

export default function HomeScreen({ navigation }: HomeScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [state, setState] = useState<HomeState>({ kind: 'loading' });
  const [approvals, setApprovals] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(false);
  const [profile, setProfile] = useState(() => ({
    name: getProfileName(),
    color: getProfileColor(),
  }));

  const load = useCallback(async (): Promise<void> => {
    try {
      const base = await resolveGatewayBase();
      if (!base) {
        setState({ kind: 'no-gateway' });
        setApprovals(0);
        return;
      }
      const rows = await listAppRegistry();
      const apps = rows
        .filter(isOpenableApp)
        .map(resolveAppMeta)
        .filter((app) => !NATIVE_APP_IDS.has(app.id));
      const automations = rows.filter((row) => row.kind === 'automation').length;
      setState({ apps, automations, kind: 'ready' });
      // Approvals are secondary — never fail the whole load over them.
      try {
        setApprovals((await listParked()).length);
      } catch {
        setApprovals(0);
      }
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
      setApprovals(0);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // Switching / adding / forgetting a Space re-points the whole app at a new
  // vault — reload the grid so it reflects the now-active space's apps.
  useEffect(() => subscribeSpaces(() => void load()), [load]);
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

  const remoteApps = state.kind === 'ready' ? state.apps : NO_APPS;
  const items = useMemo(() => buildLauncherItems(remoteApps), [remoteApps]);
  const automations = state.kind === 'ready' ? state.automations : 0;

  const connection: ConnectionState =
    state.kind === 'ready'
      ? { kind: 'ready' }
      : state.kind === 'error'
        ? { kind: 'error', message: state.message }
        : state; // loading | no-gateway

  const openItem = useCallback(
    (item: LauncherItem): void => {
      const { route } = item;
      // The root stack fires the launch haptic on transitionStart (App.tsx), so
      // this handler only routes.
      switch (route.kind) {
        case 'photos':
          navigation.navigate('Photos', { screen: 'PhotosHome' });
          break;
        case 'docs':
          navigation.navigate('Docs', { screen: 'DocsHome' });
          break;
        case 'agenda':
          navigation.navigate('Agenda', { screen: 'AgendaHome' });
          break;
        case 'app':
          navigation.navigate('AppDetail', { appId: route.appId });
          break;
        case 'pair':
          navigation.navigate('Settings', { screen: 'Settings' });
          break;
      }
    },
    [navigation],
  );

  const openFromSearch = useCallback(
    (item: LauncherItem): void => {
      setSearchOpen(false);
      openItem(item);
    },
    [openItem],
  );

  const openSettings = useCallback(
    () => navigation.navigate('Settings', { screen: 'Settings' }),
    [navigation],
  );

  const openMenu = useCallback(() => setMenuOpen(true), []);

  // Left-edge swipe opens the drawer. `activeOffsetX` demands horizontal intent
  // and `failOffsetY` bows out to vertical grid scroll, so the gesture only wins
  // on a deliberate rightward drag; the edge guard keeps it off in-content swipes.
  const edgeStartX = useSharedValue(0);
  const edgeSwipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(18)
        .failOffsetY([-16, 16])
        .onBegin((event) => {
          edgeStartX.value = event.x;
        })
        .onStart(() => {
          if (edgeStartX.value <= EDGE_ZONE) runOnJS(setMenuOpen)(true);
        }),
    [edgeStartX],
  );

  return (
    <GestureDetector gesture={edgeSwipe}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <GreetingHeader name={profile.name} color={profile.color} onOpenMenu={openMenu} />

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
              tintColor={colors.accent}
            />
          }
        >
          <AttentionLine
            connection={connection}
            approvals={approvals}
            automations={automations}
            onApprovals={() => navigation.navigate('Settings', { screen: 'Approvals' })}
            onAutomations={() => navigation.navigate('Automations')}
            onPair={openSettings}
          />

          <Text style={styles.railLabel}>YOUR APPS</Text>
          <LauncherGrid items={items} onOpen={openItem} />
        </ScrollView>

        <GlassDock
          onSearch={() => setSearchOpen(true)}
          onAssistant={() => navigation.navigate('Assistant')}
          onSettings={openSettings}
        />

        {searchOpen ? (
          <SearchOverlay
            items={items}
            onOpen={openFromSearch}
            onClose={() => setSearchOpen(false)}
          />
        ) : null}

        <SpaceDrawer
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          connection={connection}
          approvals={approvals}
          profile={profile}
          onSpaces={() => {
            setMenuOpen(false);
            setSpacesOpen(true);
          }}
          onAssistant={() => navigation.navigate('Assistant')}
          onAutomations={() => navigation.navigate('Automations')}
          onInsights={() => navigation.navigate('Insights')}
          onApprovals={() => navigation.navigate('Settings', { screen: 'Approvals' })}
          onSettings={openSettings}
        />

        <SpacesSwitcher
          open={spacesOpen}
          onClose={() => setSpacesOpen(false)}
          onPairDesktop={openSettings}
        />
      </SafeAreaView>
    </GestureDetector>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Bottom padding clears the floating dock so the last app row stays tappable.
    content: { paddingBottom: 140, paddingHorizontal: H_PADDING, paddingTop: 6 },
    railLabel: {
      color: colors.ink3,
      fontFamily: family.monoMedium,
      fontSize: 11,
      letterSpacing: 0.9,
      marginBottom: 16,
    },
    safe: { backgroundColor: colors.bg, flex: 1 },
  });
