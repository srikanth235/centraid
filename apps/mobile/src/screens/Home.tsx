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
import { subscribeVaultLinks } from "../lib/vault-links";
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
import {
  countThings,
  gridMembership,
  springboardState,
} from "./home/springboard-policy";
import { useOriginHealth } from "./home/useOriginHealth";
import { useSpringboardTiles } from "./home/useSpringboardTiles";
import VaultBar from "./home/VaultBar";

const H_PADDING = pageMargin;

type HomeState =
  | { kind: "loading" }
  | { kind: "no-gateway" }
  | { kind: "ready" }
  | { kind: "error" };

const HOME_STALE_MS = 30_000;

let homeLoadedAt = 0;
let homeInFlight: Promise<void> | undefined;

async function loadHome(
  setState: (next: HomeState) => void,
  options: { force?: boolean } = {}
): Promise<void> {
  if (!options.force && Date.now() - homeLoadedAt < HOME_STALE_MS) return;
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
    setState({ kind: "error" });
  }
}

export default function HomeScreen({
  navigation,
}: HomeScreenProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [, setState] = useState<HomeState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [allAppsOpen, setAllAppsOpen] = useState(false);
  const pins = usePins();
  const replica = useReplica();
  const healthSignal = useOriginHealth();

  useEffect(() => {
    void loadHome(setState);
  }, []);
  useEffect(() => {
    void hydratePins();
  }, []);
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

  const openPhotos = useCallback((): void => {
    const item = items.find((candidate) => candidate.meta.id === "photos");
    if (item) openItem(item);
  }, [items, openItem]);
  const openDocuments = useCallback((): void => {
    const item = items.find((candidate) => candidate.meta.id === "docs");
    if (item) openItem(item);
  }, [items, openItem]);

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
          // Intentionally empty.
        }
      }
      await replica.refresh?.();
    } catch {
      // Intentionally empty.
    }
    await loadHome(setState, { force: true });
  }, [replica]);

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

  if (isAlarmBlanked("home")) return <View style={styles.screen} />;

  return (
    <View
      style={[styles.screen, { paddingTop: insets.top }]}
      testID={TEST_IDS.home.screen}
    >
      {/* The same lockup every app draws (`VaultBar`) — the springboard has no
          special version of "which vault, which gateway". */}
      <VaultBar />

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

      <AllAppsSheet
        visible={allAppsOpen}
        items={items}
        tiles={tiles}
        pinnedIds={pins}
        onOpenApp={openItem}
        onOpenPlace={openPlace}
        onTogglePin={togglePin}
        onClose={() => setAllAppsOpen(false)}
      />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    content: {
      paddingBottom: 24,
      paddingHorizontal: H_PADDING,
      paddingTop: 4,
    },
    screen: { backgroundColor: colors.bg, flex: 1 },
  });
