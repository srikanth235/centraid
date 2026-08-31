// Home — graded per TILE, not per screen. This file owns grading and
// navigation only. Tiles fill OFFLINE; the only gateway-shaped read is
// reachability on the vault lockup.

import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { homeDayOneFoot } from "@centraid/client/home-copy";

import { isAlarmBlanked } from "../kit/e2e-alarm";
import { useReplica } from "../kit/replica/ReplicaProvider";
import { TEST_IDS } from "../kit/test-ids";
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

// From the token, never re-typed (R.margin.m).
const H_PADDING = pageMargin;

type HomeState =
  | { kind: "loading" }
  | { kind: "no-gateway" }
  | { kind: "ready" }
  | { kind: "error" };

const HOME_STALE_MS = 30_000;

let homeLoadedAt = 0;
let homeInFlight: Promise<void> | undefined;

// Module-scope: closes over the setter only, no `useCallback` identity.
async function loadHome(
  setState: (next: HomeState) => void,
  options: { force?: boolean } = {}
): Promise<void> {
  if (!options.force && Date.now() - homeLoadedAt < HOME_STALE_MS) return;
  // One setter: a mid-load caller joins the running load.
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
    // Gateway facts go on the status line — never a banner, never a thrown-away grid.
    setState({ kind: "error" });
  }
}

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
  // Grid order is user data — hydrate once at mount.
  useEffect(() => {
    void hydratePins();
  }, []);
  // Vault switch re-points the app; the grid must reload.
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
    // Springboard order first, then pins — reverse lets the default un-pin downward.
    () => orderByPins(orderForSpringboard(buildLauncherItems()), pins),
    [pins]
  );
  const tiles = useSpringboardTiles();

  // No tile → keep on the grid. Home has no read that could call it empty.
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
          navigation.navigate("Locker", { screen: "LockerHome" });
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
          navigation.navigate("Tally", { screen: "TallyHome" });
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

  /** `connectors` has no mobile screen — route to Settings. */
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

  /** By app id, not the top-3 `moves` list — day-one buttons are fixed. */
  const openPhotos = useCallback((): void => {
    const item = items.find((candidate) => candidate.meta.id === "photos");
    if (item) openItem(item);
  }, [items, openItem]);
  const openDocuments = useCallback((): void => {
    const item = items.find((candidate) => candidate.meta.id === "docs");
    if (item) openItem(item);
  }, [items, openItem]);

  /**
   * Demo seed (#290) by hand — do not import `vaultDemoLoad` (client barrel
   * pulls pdfjs + sqlite-wasm into the phone). Fail-soft: a partial fill
   * leaves the offer live.
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
          // oxlint-disable-next-line no-await-in-loop -- ordered by contract
          await fetchJson(
            `${base}/centraid/_vault/demo/${encodeURIComponent(appId)}`,
            { headers: apiHeaders(), method: "POST" }
          );
        } catch {
          // Per-app failure is survivable.
        }
      }
      // Before the tiles re-read, or they rebuild from the pre-seed replica.
      await replica.refresh?.();
    } catch {
      // A dead gateway costs this offer, never the screen.
    }
    await loadHome(setState, { force: true });
  }, [replica]);

  /**
   * Band and All-apps share this map. `starred` is a stated no-op — no mobile
   * screen. `default` is `never` so a new place is a typecheck failure.
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
          // No mobile screen — stated no-op.
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

  // #890 W6 — the alarm test's mutation site. In every ordinary build this
  // branch is statically false and eliminated: `EXPO_PUBLIC_CENTRAID_E2E_ALARM`
  // is inlined at export time and nothing but the quarterly alarm lane sets it.
  // In that lane, Home renders nothing, HOME_READY_MARKER never appears, and the
  // suite MUST go red — a green there is the alarm not sounding, and it fails
  // the job. See apps/mobile/src/kit/e2e-alarm.ts for why the mutation belongs
  // in the artifact rather than in the harness.
  // An empty View rather than `null`, so the production signature stays
  // `React.JSX.Element` — widening a shipped return type to accommodate a
  // test-only branch would be the mutation leaking into the product. The claim
  // is identical either way: the band never mounts, so HOME_READY_MARKER never
  // appears and every flow that waits for it must fail.
  if (isAlarmBlanked("home")) return <View style={styles.screen} />;

  return (
    // Explicit paddingTop — SafeAreaView edges can resolve to zero in cover stacks.
    // `home-screen` is the arrival handle: HOME_READY_MARKER keyed on the band's
    // accessibility label, and its predecessor ("Home ready") vanished with a
    // copy change (#789/#839). A root testID cannot be re-worded.
    <View
      style={[styles.screen, { paddingTop: insets.top }]}
      testID={TEST_IDS.home.screen}
    >
      <VaultHeader
        vaultName={vault.vaultName}
        gatewayName={vault.gatewayName}
        color={vault.color}
        offline={offline}
        onSwitchVault={() => setVaultsOpen(true)}
        onSearch={() => setSearchOpen(true)}
        onNewChat={() => navigation.navigate("Assistant")}
      />

      {/* Fixed chrome, not scroll content — scrollbar starts below the app-bar rule. */}
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
        {/* No offline banner — the status line covers it; offline is not an incident. */}
        {springboard === "first-run" ? (
          <DayOne
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
    // Clears the flush band so the last row stays tappable.
    content: {
      paddingBottom: 24,
      paddingHorizontal: H_PADDING,
      paddingTop: 4,
    },
    screen: { backgroundColor: colors.bg, flex: 1 },
  });
