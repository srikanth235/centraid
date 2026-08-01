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

import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AppState,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS, useSharedValue } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import type { AppMetaResolved } from "@centraid/design-tokens";

import { family, useTheme } from "../kit/theme";
import type { ThemeColors } from "../kit/theme";
import { fetchDailyBrief } from "../lib/daily-brief";
import type { DailyBrief } from "../lib/daily-brief";
import {
  GatewayError,
  isOpenableApp,
  listAppRegistry,
  getNotifications,
  resolveAppMeta,
  resolveGatewayBase,
  subscribeMobileNotificationsChanges,
} from "../lib/gateway";
import { getProfileColor, getProfileName } from "../lib/profile";
import { subscribeVaultLinks } from "../lib/vault-links";
import type { HomeScreenProps } from "../navigation";
import AttentionLine from "./home/AttentionLine";
import type { ConnectionState } from "./home/AttentionLine";
import { NATIVE_APP_IDS, buildLauncherItems } from "./home/catalog";
import type { LauncherItem } from "./home/catalog";
import DailyBriefCard from "./home/DailyBriefCard";
import GlassDock from "./home/GlassDock";
import GreetingHeader from "./home/GreetingHeader";
import LauncherGrid from "./home/LauncherGrid";
import SearchOverlay from "./home/SearchOverlay";
import VaultDrawer from "./home/VaultDrawer";
import VaultsSwitcher from "./home/VaultsSwitcher";

const H_PADDING = 20;

// A drag must start within this many points of the left screen edge to open the
// Vault drawer, so an edge-swipe never competes with in-content horizontal
// scroll (e.g. the attention line's chip strip).
const EDGE_ZONE = 24;

// Stable empty listing for the not-ready states — a fresh `[]` per render would
// defeat the `items` memo below (exhaustive-deps flags it).
const NO_APPS: readonly AppMetaResolved[] = [];

type HomeState =
  | { kind: "loading" }
  | { kind: "no-gateway" }
  | {
      kind: "ready";
      apps: AppMetaResolved[];
      automations: number;
      brief?: DailyBrief;
    }
  | { kind: "error"; message: string };

// The loader lives outside the component: it closes over nothing but the two
// (stable) state setters, so it needs no `useCallback` identity dance and the
// effects below read as plain async kick-offs.
/**
 * How long a loaded Home stays good enough to reuse.
 *
 * Home used to re-fetch the app registry, the daily brief and notifications on
 * mount, on every focus, on every vault-link event and on every doorbell — so
 * tabbing away and back cost three round trips for an answer that had not
 * changed. Anything that genuinely invalidates the screen (pull-to-refresh, a
 * vault switch) forces past this window; ordinary navigation does not.
 */
const HOME_STALE_MS = 30_000;

let homeLoadedAt = 0;
let homeInFlight: Promise<void> | undefined;

async function loadHome(
  setState: (next: HomeState) => void,
  setApprovals: (next: number) => void,
  options: { force?: boolean } = {}
): Promise<void> {
  if (!options.force && Date.now() - homeLoadedAt < HOME_STALE_MS) return;
  // One screen owns these setters, so a caller that arrives mid-load wants the
  // result of the load already running, not a second copy of it.
  if (homeInFlight) return homeInFlight;
  homeInFlight = runHomeLoad(setState, setApprovals).finally(() => {
    homeInFlight = undefined;
  });
  return homeInFlight;
}

async function runHomeLoad(
  setState: (next: HomeState) => void,
  setApprovals: (next: number) => void
): Promise<void> {
  try {
    const base = await resolveGatewayBase();
    if (!base) {
      setState({ kind: "no-gateway" });
      setApprovals(0);
      return;
    }
    const [rows, brief] = await Promise.all([
      listAppRegistry(),
      fetchDailyBrief().catch(() => undefined),
    ]);
    const apps = rows
      .filter(isOpenableApp)
      .map(resolveAppMeta)
      .filter((app) => !NATIVE_APP_IDS.has(app.id));
    const automations = rows.filter((row) => row.kind === "automation").length;
    setState({ apps, automations, brief, kind: "ready" });
    homeLoadedAt = Date.now();
    // Notifications is secondary — never fail the whole load over it.
    try {
      setApprovals((await getNotifications()).decisions.count);
    } catch {
      setApprovals(0);
    }
  } catch (error) {
    setState({
      kind: "error",
      message:
        error instanceof GatewayError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Could not load apps.",
    });
    setApprovals(0);
  }
}

// Left-edge swipe opens the drawer. `activeOffsetX` demands horizontal intent
// and `failOffsetY` bows out to vertical grid scroll, so the gesture only wins
// on a deliberate rightward drag; the edge guard keeps it off in-content swipes.
// Built outside the component because `Gesture.Pan()` is a capitalised factory
// whose builder chain mutates the object, and the handlers drive a shared value
// — both shapes the React compiler rejects inside a render body.
function buildEdgeSwipeGesture(
  edgeStartX: SharedValue<number>,
  onOpenMenu: (open: boolean) => void
): ReturnType<typeof Gesture.Pan> {
  return Gesture.Pan()
    .activeOffsetX(18)
    .failOffsetY([-16, 16])
    .onBegin((event) => {
      edgeStartX.value = event.x;
    })
    .onStart(() => {
      if (edgeStartX.value <= EDGE_ZONE) runOnJS(onOpenMenu)(true);
    });
}

export default function HomeScreen({
  navigation,
}: HomeScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [state, setState] = useState<HomeState>({ kind: "loading" });
  const [approvals, setApprovals] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [vaultsOpen, setVaultsOpen] = useState(false);
  const [profile, setProfile] = useState(() => ({
    name: getProfileName(),
    color: getProfileColor(),
  }));

  useEffect(() => {
    void loadHome(setState, setApprovals);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const refreshNotificationsCount = (): void => {
      void getNotifications()
        .then((notifications) => setApprovals(notifications.decisions.count))
        .catch(() => undefined);
    };
    void subscribeMobileNotificationsChanges(
      refreshNotificationsCount,
      controller.signal
    ).catch(() => undefined);
    // The SSE doorbell is the primary signal; this is its backstop, and a
    // backgrounded phone has no badge to keep current.
    let timer: ReturnType<typeof setInterval> | undefined;
    const startPoll = (): void => {
      timer ??= setInterval(refreshNotificationsCount, 60_000);
    };
    const stopPoll = (): void => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const appStateSub = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        refreshNotificationsCount();
        startPoll();
      } else stopPoll();
    });
    if (AppState.currentState === "active") startPoll();
    return () => {
      controller.abort();
      appStateSub.remove();
      stopPoll();
    };
  }, []);
  // Switching / adding / forgetting a Vault re-points the whole app at a new
  // vault — reload the grid so it reflects the now-active vault's apps.
  useEffect(
    () =>
      subscribeVaultLinks(
        () => void loadHome(setState, setApprovals, { force: true })
      ),
    []
  );
  useFocusEffect(
    useCallback(() => {
      void loadHome(setState, setApprovals);
      setProfile({ name: getProfileName(), color: getProfileColor() });
    }, [])
  );

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await loadHome(setState, setApprovals, { force: true });
    setRefreshing(false);
  }, []);

  const remoteApps = state.kind === "ready" ? state.apps : NO_APPS;
  const items = useMemo(() => buildLauncherItems(remoteApps), [remoteApps]);
  const automations = state.kind === "ready" ? state.automations : 0;

  const connection: ConnectionState =
    state.kind === "ready"
      ? { kind: "ready" }
      : state.kind === "error"
        ? { kind: "error", message: state.message }
        : state; // loading | no-gateway

  const openItem = useCallback(
    (item: LauncherItem): void => {
      const { route } = item;
      // The root stack fires the launch haptic on transitionStart (App.tsx), so
      // this handler only routes.
      switch (route.kind) {
        case "photos":
          navigation.navigate("Photos", { screen: "PhotosHome" });
          break;
        case "docs":
          navigation.navigate("Docs", { screen: "DocsHome" });
          break;
        case "agenda":
          navigation.navigate("Agenda", { screen: "AgendaHome" });
          break;
        case "locker":
          navigation.navigate("Locker");
          break;
        case "tasks":
          navigation.navigate("Tasks");
          break;
        case "people":
          navigation.navigate("People");
          break;
        case "notes":
          navigation.navigate("Notes");
          break;
        case "tally":
          navigation.navigate("Tally");
          break;
        case "app":
          navigation.navigate("AppDetail", { appId: route.appId });
          break;
        case "pair":
          navigation.navigate("Settings", { screen: "Settings" });
          break;
      }
    },
    [navigation]
  );

  const openFromSearch = useCallback(
    (item: LauncherItem): void => {
      setSearchOpen(false);
      openItem(item);
    },
    [openItem]
  );

  const openSettings = useCallback(
    () => navigation.navigate("Settings", { screen: "Settings" }),
    [navigation]
  );

  const openMenu = useCallback(() => setMenuOpen(true), []);

  const edgeStartX = useSharedValue(0);
  const edgeSwipe = useMemo(
    () => buildEdgeSwipeGesture(edgeStartX, setMenuOpen),
    [edgeStartX]
  );

  return (
    <GestureDetector gesture={edgeSwipe}>
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <GreetingHeader
          name={profile.name}
          color={profile.color}
          onOpenMenu={openMenu}
        />

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
            onApprovals={() =>
              navigation.navigate("Settings", { screen: "Approvals" })
            }
            onAutomations={() => navigation.navigate("Automations")}
            onPair={openSettings}
          />
          <DailyBriefCard
            brief={state.kind === "ready" ? state.brief : undefined}
            onEvents={() =>
              navigation.navigate("Agenda", { screen: "AgendaHome" })
            }
            onTasks={() => navigation.navigate("Tasks")}
            onPhotos={() =>
              navigation.navigate("Photos", { screen: "PhotosHome" })
            }
            onTally={() => navigation.navigate("Tally")}
          />

          <Text
            // The launcher grid is intentionally visible while its gateway
            // data loads, but the Daily Brief above it can still arrive and
            // move every tile. Publish that distinction to assistive tech (and
            // device-driving journeys) so an early "YOUR APPS" sighting is not
            // mistaken for a stable, tappable layout.
            accessibilityLabel={
              state.kind === "loading"
                ? "Your apps, loading"
                : "Your apps, ready"
            }
            accessibilityLiveRegion="polite"
            style={styles.railLabel}
          >
            YOUR APPS
          </Text>
          <LauncherGrid items={items} onOpen={openItem} />
        </ScrollView>

        <GlassDock
          onSearch={() => setSearchOpen(true)}
          onAssistant={() => navigation.navigate("Assistant")}
          onCapture={() => navigation.navigate("Capture")}
        />

        {searchOpen ? (
          <SearchOverlay
            items={items}
            onOpen={openFromSearch}
            onClose={() => setSearchOpen(false)}
          />
        ) : null}

        <VaultDrawer
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          connection={connection}
          approvals={approvals}
          profile={profile}
          onVaults={() => {
            setMenuOpen(false);
            setVaultsOpen(true);
          }}
          onAssistant={() => navigation.navigate("Assistant")}
          onAutomations={() => navigation.navigate("Automations")}
          onInsights={() => navigation.navigate("Insights")}
          onApprovals={() =>
            navigation.navigate("Settings", { screen: "Approvals" })
          }
          onSettings={openSettings}
        />

        <VaultsSwitcher
          open={vaultsOpen}
          onClose={() => setVaultsOpen(false)}
          onPairDesktop={openSettings}
        />
      </SafeAreaView>
    </GestureDetector>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Bottom padding clears the floating dock so the last app row stays tappable.
    content: {
      paddingBottom: 140,
      paddingHorizontal: H_PADDING,
      paddingTop: 6,
    },
    railLabel: {
      color: colors.ink3,
      fontFamily: family.monoMedium,
      fontSize: 11,
      letterSpacing: 0.9,
      marginBottom: 16,
    },
    safe: { backgroundColor: colors.bg, flex: 1 },
  });
