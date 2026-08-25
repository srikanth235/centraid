// The Home screen — the Binding Layer's two-tier, three-state springboard.
//
// GRADED, NOT BINARY. A vault fills gradually, so Home has three states decided
// per TILE, not per screen: every readable tile settled and empty is a day-one
// page; a mix is the grid plus a band of first moves; all content is the grid
// alone.
//
// This file owns ONLY the grading and the navigation wiring — every visual
// block is its own component, so it stays a readable assembly.
//
// Tiles read the local replica per app and fill OFFLINE. The only
// gateway-shaped read left is reachability, which the vault lockup states.

import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { homeDayOneFoot } from "@centraid/client/home-copy";

import { useReplica } from "../kit/replica/ReplicaProvider";
import { pageMargin, useTheme } from "../kit/theme";
import type { ThemeColors } from "../kit/theme";
import {
  apiHeaders,
  fetchJson,
  requireGatewayBase,
  resolveGatewayBase,
} from "../lib/gateway";
import { getActiveVaultLink, subscribeVaultLinks } from "../lib/vault-links";
import type { HomeScreenProps } from "../navigation";
import AllAppsSheet from "./home/AllAppsSheet";
import type { BandTarget } from "./home/band";
import {
  buildLauncherItems,
  orderByPins,
  orderForSpringboard,
} from "./home/catalog";
import type { LauncherItem } from "./home/catalog";
import { firstMoves } from "./home/first-moves";
import type { FirstMove } from "./home/first-moves";
import FirstMovesBand, { DayOne } from "./home/FirstMoves";
import { hydratePins, togglePin, usePins } from "./home/home-pins";
import HomeBand from "./home/HomeBand";
import HomeStatusLine from "./home/HomeStatusLine";
import HomeTitleRow from "./home/HomeTitleRow";
import LauncherGrid from "./home/LauncherGrid";
import type { PlaceId } from "./home/places";
import SearchOverlay from "./home/SearchOverlay";
import {
  countThings,
  springboardState,
  tileEarnsGrid,
} from "./home/springboard-policy";
import { useOriginHealth } from "./home/useOriginHealth";
import { useSpringboardTiles } from "./home/useSpringboardTiles";
import VaultHeader from "./home/VaultHeader";
import VaultsSwitcher from "./home/VaultsSwitcher";

// Lowered from the token, never re-typed, so every screen agrees on where the
// page starts (R.margin.m, handoff :3356).
const H_PADDING = pageMargin;

type HomeState =
  | { kind: "loading" }
  | { kind: "no-gateway" }
  | { kind: "ready" }
  | { kind: "error" };

/** Mount, focus, vault-link events and doorbells would otherwise cost three
 *  round trips per tab-away for an unchanged answer. Anything that genuinely
 *  invalidates the screen forces past this window. */
const HOME_STALE_MS = 30_000;

let homeLoadedAt = 0;
let homeInFlight: Promise<void> | undefined;

// Outside the component: it closes over nothing but the stable setter, so it
// needs no `useCallback` identity dance.
async function loadHome(
  setState: (next: HomeState) => void,
  options: { force?: boolean } = {}
): Promise<void> {
  if (!options.force && Date.now() - homeLoadedAt < HOME_STALE_MS) return;
  // One screen owns this setter, so a mid-load caller wants the running load.
  if (homeInFlight) return homeInFlight;
  homeInFlight = runHomeLoad(setState).finally(() => {
    homeInFlight = undefined;
  });
  return homeInFlight;
}

async function runHomeLoad(setState: (next: HomeState) => void): Promise<void> {
  try {
    const base = await resolveGatewayBase();
    setState(base ? { kind: "ready" } : { kind: "no-gateway" });
    if (base) homeLoadedAt = Date.now();
  } catch {
    // The status line is where gateway facts go — never a banner, never a
    // thrown-away grid.
    setState({ kind: "error" });
  }
}

/** The vault + gateway lockup, re-read whenever the active link changes. */
function useActiveVault(): {
  vaultName: string | undefined;
  gatewayName: string | undefined;
  color: string | undefined;
} {
  const [link, setLink] = useState(getActiveVaultLink);
  useEffect(() => subscribeVaultLinks(() => setLink(getActiveVaultLink())), []);
  return {
    color: link?.color,
    gatewayName: link?.desktopName,
    vaultName: link?.vaultName,
  };
}

export default function HomeScreen({
  navigation,
}: HomeScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [state, setState] = useState<HomeState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [vaultsOpen, setVaultsOpen] = useState(false);
  const [allAppsOpen, setAllAppsOpen] = useState(false);
  const pins = usePins();
  const vault = useActiveVault();
  const replica = useReplica();
  const healthSignal = useOriginHealth();

  useEffect(() => {
    void loadHome(setState);
  }, []);
  // The grid order is user data — hydrated once at mount, like the appearance
  // prefs in App.tsx.
  useEffect(() => {
    void hydratePins();
  }, []);
  // A vault switch re-points the whole app, so the grid must reload.
  useEffect(
    () => subscribeVaultLinks(() => void loadHome(setState, { force: true })),
    []
  );
  useFocusEffect(
    useCallback(() => {
      void loadHome(setState);
    }, [])
  );

  const onRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    await loadHome(setState, { force: true });
    setRefreshing(false);
  }, []);

  const items = useMemo(
    // Springboard order first, THEN pins: reversing the two lets the default
    // re-sort a pinned app back down the grid.
    () => orderByPins(orderForSpringboard(buildLauncherItems()), pins),
    [pins]
  );
  const tiles = useSpringboardTiles();

  // The grading. An app with NO tile at all keeps its place on the grid: Home
  // has no read that could call it empty, so demoting it would be a guess.
  const { earned, idleIds } = useMemo(() => {
    const kept: LauncherItem[] = [];
    const idle: string[] = [];
    for (const item of items) {
      const tile = tiles.get(item.meta.id);
      if (!tile || tileEarnsGrid(tile)) kept.push(item);
      else idle.push(item.meta.id);
    }
    return { earned: kept, idleIds: idle };
  }, [items, tiles]);

  const moves = useMemo(() => firstMoves(idleIds), [idleIds]);
  const springboard = useMemo(
    () => springboardState([...tiles.values()]),
    [tiles]
  );
  const things = useMemo(() => countThings(tiles.values()), [tiles]);
  const offline = state.kind === "no-gateway" || state.kind === "error";

  const openItem = useCallback(
    (item: LauncherItem): void => {
      const { route } = item;
      // The root stack fires the launch haptic on transitionStart (App.tsx).
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
          navigation.navigate("People", { screen: "PeopleHome" });
          break;
        case "notes":
          navigation.navigate("Notes");
          break;
        case "tally":
          navigation.navigate("Tally");
          break;
      }
    },
    [navigation]
  );

  const openSettings = useCallback(
    () => navigation.navigate("Settings", { screen: "Settings" }),
    [navigation]
  );

  const openFromSearch = useCallback(
    (item: LauncherItem): void => {
      setSearchOpen(false);
      openItem(item);
    },
    [openItem]
  );

  /** A first move must land somewhere that can TAKE content. `connectors` has
   *  no mobile screen — connecting an account is a desktop act — so it routes
   *  to Settings; app moves open the app, where its own add control lives. */
  const pickMove = useCallback(
    (move: FirstMove): void => {
      if (move.id === "connectors") {
        openSettings();
        return;
      }
      const item = items.find((candidate) => candidate.meta.id === move.id);
      if (item) openItem(item);
    },
    [items, openItem, openSettings]
  );

  /** Found by app id, NOT through the top-3-limited `moves` list: day one's two
   *  buttons are fixed regardless of which apps `firstMoves()` ranks first. */
  const openPhotos = useCallback((): void => {
    const item = items.find((candidate) => candidate.meta.id === "photos");
    if (item) openItem(item);
  }, [items, openItem]);
  const openDocuments = useCallback((): void => {
    const item = items.find((candidate) => candidate.meta.id === "docs");
    if (item) openItem(item);
  }, [items, openItem]);

  /**
   * "Fill it with sample content" (#290): status, one seed POST per seedable
   * app, then a replica pull so the tiles catch up.
   *
   * Speaks the `/centraid/_vault/demo` wire contract by hand rather than
   * importing `vaultDemoLoad`: that lives behind `packages/client`'s bare
   * barrel, which is NOT a mobile-reachable subpath and drags `pdfjs-dist` and
   * `@sqlite.org/sqlite-wasm` into the phone bundle.
   *
   * Fail-soft throughout, as desktop's `homeSample.ts` is: a partial or failed
   * fill leaves the offer live, never a crash on the screen every route
   * returns to.
   */
  const fillSample = useCallback(async (): Promise<void> => {
    try {
      const base = await requireGatewayBase();
      const status = await fetchJson<{
        apps: readonly { appId: string; seedable: boolean }[];
      }>(`${base}/centraid/_vault/demo`, { headers: apiHeaders() });
      const seedable = status.apps
        .filter((app) => app.seedable)
        .map((app) => app.appId);
      for (const appId of seedable) {
        try {
          // Sequential and per-app-caught: one generator throwing is not the
          // others' problem.
          // oxlint-disable-next-line no-await-in-loop -- ordered by contract
          await fetchJson(
            `${base}/centraid/_vault/demo/${encodeURIComponent(appId)}`,
            { headers: apiHeaders(), method: "POST" }
          );
        } catch {
          // Per-app failure is survivable — see the function comment.
        }
      }
      // Must precede the tiles' re-read, or they rebuild from the pre-seed
      // replica and day one appears to have done nothing.
      await replica.refresh?.();
    } catch {
      // A gateway that will not answer costs this offer, never the screen.
    }
    await loadHome(setState, { force: true });
  }, [replica]);

  /**
   * Every place resolved to the nearest REAL mobile screen, shared by the band
   * and the All-apps sheet so the two cannot name different destinations for
   * one place.
   *
   * `starred` has NO mobile screen and stays a STATED no-op: routing a labelled
   * row to a page that does not hold what it promised is the bug class this
   * whole switch exists to avoid. A place with nowhere to go fails loudly.
   *
   * The `default` arm asserts `never`, so a new place with no case here is a
   * typecheck failure rather than a silent fall-through.
   */
  const goToPlace = useCallback(
    (id: PlaceId): void => {
      switch (id) {
        case "home":
          break;
        case "notifs":
          navigation.navigate("Settings", { screen: "Approvals" });
          break;
        case "autos":
          navigation.navigate("Automations");
          break;
        case "conn":
          navigation.navigate("Connectors");
          break;
        case "settings":
          openSettings();
          break;
        case "stats":
          navigation.navigate("Insights");
          break;
        case "gateway":
          navigation.navigate("SystemOnPhone");
          break;
        case "storage":
          navigation.navigate("Settings", { screen: "PhoneStorage" });
          break;
        case "data":
          navigation.navigate("Data");
          break;
        case "devices":
          navigation.navigate("Devices");
          break;
        case "starred":
          // No mobile screen for this place yet — see the function comment.
          break;
        default: {
          const exhaustive: never = id;
          throw new Error(`Unhandled place: ${String(exhaustive)}`);
        }
      }
    },
    [navigation, openSettings]
  );

  const openPlace = useCallback(
    (id: string): void => goToPlace(id as PlaceId),
    [goToPlace]
  );

  const selectBandTab = useCallback(
    (target: BandTarget): void => {
      if (target === "more") {
        setAllAppsOpen(true);
        return;
      }
      goToPlace(target);
    },
    [goToPlace]
  );

  return (
    // Explicit `paddingTop`, never SafeAreaView edges: edges intermittently
    // resolves to zero inside this app's cover stacks, landing the vault lockup
    // under the status bar.
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <VaultHeader
        vaultName={vault.vaultName}
        gatewayName={vault.gatewayName}
        color={vault.color}
        offline={offline}
        onSwitchVault={() => setVaultsOpen(true)}
        onSearch={() => setSearchOpen(true)}
        onNewChat={() => navigation.navigate("Assistant")}
      />

      {/* Fixed chrome, NOT scroll content: the lockup and app bar are
          `flex:none` siblings above the scroll region, so the scrollbar starts
          below the app bar's own hairline rule (:5532–5533). */}
      <HomeTitleRow />
      <HomeStatusLine
        signal={healthSignal}
        onOpen={() => {
          switch (healthSignal.destination) {
            case undefined:
              break;
            case "phone":
              navigation.navigate("Settings", { screen: "PhoneStorage" });
              break;
            case "backup":
              navigation.navigate("Settings", { screen: "BackupHealth" });
              break;
            case "notifications":
              navigation.navigate("SignalNotification", {
                cause: healthSignal.notificationCause ?? healthSignal.copy,
                detail: healthSignal.notificationDetail ?? "phone",
              });
              break;
          }
        }}
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
        {/* NO offline banner: the status line covers it in one neutral clause,
            and an offline-first product does not present its premise as an
            incident. */}
        {springboard === "first-run" ? (
          <DayOne
            // Real counts, zero included: the foot is honest about the zero.
            foot={homeDayOneFoot(items.length, things.total)}
            onSeedSample={() => void fillSample()}
            onBringPhotos={openPhotos}
            onBringDocuments={openDocuments}
          />
        ) : (
          <>
            <LauncherGrid items={earned} tiles={tiles} onOpen={openItem} />
            <FirstMovesBand moves={moves} onPick={pickMove} />
          </>
        )}
      </ScrollView>

      <HomeBand active="home" onSelect={selectBandTab} />

      {searchOpen ? (
        <SearchOverlay
          items={items}
          onOpen={openFromSearch}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}

      <AllAppsSheet
        visible={allAppsOpen}
        items={items}
        tiles={tiles}
        pinnedIds={pins}
        onOpenApp={openFromSearch}
        onOpenPlace={openPlace}
        onTogglePin={togglePin}
        onClose={() => setAllAppsOpen(false)}
      />

      <VaultsSwitcher
        open={vaultsOpen}
        onClose={() => setVaultsOpen(false)}
        onPairDesktop={openSettings}
      />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Clears the flush band, so the grid's last row stays tappable.
    content: {
      paddingBottom: 24,
      paddingHorizontal: H_PADDING,
      paddingTop: 4,
    },
    screen: { backgroundColor: colors.bg, flex: 1 },
  });
