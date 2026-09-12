// Home — graded per TILE, not per screen. This file owns grading and
// navigation only. Tiles fill OFFLINE; the only gateway-shaped read is
// reachability on the vault lockup.

import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet } from "react-native";

import { homeDayOneFoot } from "@centraid/client/home-copy";

import { isAlarmBlanked } from "../kit/e2e-alarm";
import { useReplica } from "../kit/replica/ReplicaProvider";
import { HomeRoom } from "../kit/rooms";
import { TEST_IDS } from "../kit/test-ids";
import { pageMargin, useTheme } from "../kit/theme";
import type { ThemeColors } from "../kit/theme";
import {
  apiHeaders,
  fetchJson,
  requireGatewayBase,
  resolveGatewayBase,
} from "../lib/gateway";
import { subscribeVaultLinks } from "../lib/vault-links";
import type { HomeScreenProps } from "../navigation";
import AllAppsSheet from "./home/AllAppsSheet";
import { ALL_APPS_SHEET } from "./home/band-navigation";
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
import {
  countThings,
  gridMembership,
  springboardState,
} from "./home/springboard-policy";
import { useOriginHealth } from "./home/useOriginHealth";
import { usePlaceNavigation } from "./home/usePlaceNavigation";
import { useSpringboardTiles } from "./home/useSpringboardTiles";
import VaultBar from "./home/VaultBar";

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

export default function HomeScreen({
  navigation,
  route: homeRoute,
}: HomeScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Write-only on purpose: the cover renders the same either way, and the
  // setter is what `loadHome` needs to drive its retries.
  const [, setState] = useState<HomeState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  // More pressed on a place's band lands HERE with `sheet` set (R-NY-1).
  const sheet = homeRoute.params?.sheet;
  const [allAppsOpen, setAllAppsOpen] = useState(sheet === ALL_APPS_SHEET);
  const pins = usePins();
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

  const { earned, idleIds } = useMemo(
    () => gridMembership(items, tiles),
    [items, tiles]
  );

  const moves = useMemo(() => firstMoves(idleIds), [idleIds]);
  const springboard = useMemo(
    () => springboardState([...tiles.values()]),
    [tiles]
  );
  const things = useMemo(() => countThings(tiles.values()), [tiles]);

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
    () => navigation.navigate("Settings", { screen: "SettingsHome" }),
    [navigation]
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
   * Band and All-apps go through the one band navigation every place root
   * uses (`usePlaceNavigation`, R-NY-1): Home + the place, never deeper. On
   * Home, More opens the sheet in place.
   */
  const openAllApps = useCallback(() => setAllAppsOpen(true), []);
  const { goToPlace, selectBandTab } = usePlaceNavigation(
    navigation,
    openAllApps
  );

  const openPlace = useCallback(
    (id: string): void => goToPlace(id as PlaceId),
    [goToPlace]
  );

  // A `sheet` param arriving on the mounted Home opens the sheet while
  // rendering: the param is a prop, so this is state adjusted to a prop, not
  // an effect. The effect only clears the param on the navigator, so a later
  // arrival does not open the sheet again.
  const [seenSheet, setSeenSheet] = useState(sheet);
  if (sheet !== seenSheet) {
    setSeenSheet(sheet);
    if (sheet === ALL_APPS_SHEET) setAllAppsOpen(true);
  }
  useEffect(() => {
    if (sheet === ALL_APPS_SHEET) navigation.setParams({ sheet: undefined });
  }, [navigation, sheet]);

  // #890 W6 — the alarm test's mutation site. In every ordinary build this
  // branch is statically false and eliminated: `EXPO_PUBLIC_CENTRAID_E2E_ALARM`
  // is inlined at export time and nothing but the quarterly alarm lane sets it.
  // In that lane, Home renders nothing, HOME_READY_MARKER never appears, and the
  // suite MUST go red — a green there is the alarm not sounding, and it fails
  // the job. See apps/mobile/src/kit/e2e-alarm.ts for why the mutation belongs
  // in the artifact rather than in the harness.
  // An empty ROOM rather than `null`, so the production signature stays
  // `React.JSX.Element` — widening a shipped return type to accommodate a
  // test-only branch would be the mutation leaking into the product. The claim
  // is identical either way: the band never mounts (the room is handed none),
  // so HOME_READY_MARKER never appears and every flow that waits for it must
  // fail.
  if (isAlarmBlanked("home")) return <HomeRoom />;

  return (
    // Explicit paddingTop — SafeAreaView edges can resolve to zero in cover stacks.
    // `home-screen` is the arrival handle: HOME_READY_MARKER keyed on the band's
    // accessibility label, and its predecessor ("Home ready") vanished with a
    // copy change (#789/#839). A root testID cannot be re-worded.
    <HomeRoom
      band={<HomeBand active="home" onSelect={selectBandTab} />}
      /* The same lockup every app draws (`VaultBar`) — the springboard has no
         special version of "which vault, which gateway". */
      head={<HomeTitleRow onSettings={openSettings} />}
      overlay={
        <AllAppsSheet
          items={items}
          onClose={() => setAllAppsOpen(false)}
          onOpenApp={openItem}
          onOpenPlace={openPlace}
          onTogglePin={togglePin}
          pinnedIds={pins}
          tiles={tiles}
          visible={allAppsOpen}
        />
      }
      status={
        <HomeStatusLine
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
          signal={healthSignal}
        />
      }
      testID={TEST_IDS.home.screen}
      vault={<VaultBar />}
    >
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
    </HomeRoom>
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
