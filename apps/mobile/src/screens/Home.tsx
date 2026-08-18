// The Home screen — the Binding Layer's two-tier, three-state springboard.
//
// The frame, top to bottom: which vault and which gateway (./home/VaultHeader),
// the route's own title row carrying the view's one filled control
// (./home/HomeTitleRow), the content tiles that have earned the grid
// (./home/LauncherGrid), the first moves for the apps that have not
// (./home/FirstMoves), one Origin health ribbon (./home/HomeStatusLine), and the
// band of frame destinations (./home/HomeBand).
//
// GRADED, NOT BINARY. A vault fills up gradually, so Home has three states and
// they are decided per tile, not per screen:
//
//  · every readable tile settled and empty  → a themed day-one PAGE;
//  · some tiles with content, some without  → the grid, plus a quiet band of
//    first moves under a hairline rule;
//  · everything with content                → the grid alone.
//
// Home owns only the grading and the navigation wiring; every visual block is
// its own component so this file stays a readable assembly.
//
// Data: the tiles read the local replica per app (./home/useSpringboardTiles)
// and fill offline, independently of the gateway. The only gateway-shaped read
// left is reachability, which the vault lockup states — the eight first-party
// apps render either way, because their UI is in the binary.

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

// The shared page margin — R.margin.m (handoff :3356), lowered as
// `pageMargin` rather than re-typed here, so Home and every other screen
// agree on where the page starts.
const H_PADDING = pageMargin;

type HomeState =
  | { kind: "loading" }
  | { kind: "no-gateway" }
  | { kind: "ready" }
  | { kind: "error" };

/**
 * How long a resolved Home stays good enough to reuse.
 *
 * Home used to re-resolve the gateway on mount, on every focus, on every
 * vault-link event and on every doorbell — so tabbing away and back cost three
 * round trips for an answer that had not changed. Anything that genuinely
 * invalidates the screen (pull-to-refresh, a vault switch) forces past this
 * window; ordinary navigation does not.
 */
const HOME_STALE_MS = 30_000;

let homeLoadedAt = 0;
let homeInFlight: Promise<void> | undefined;

// The loader lives outside the component: it closes over nothing but the
// (stable) state setter, so it needs no `useCallback` identity dance.
async function loadHome(
  setState: (next: HomeState) => void,
  options: { force?: boolean } = {}
): Promise<void> {
  if (!options.force && Date.now() - homeLoadedAt < HOME_STALE_MS) return;
  // One screen owns this setter, so a caller that arrives mid-load wants the
  // result of the load already running, not a second copy of it.
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
    // A gateway that will not answer is a gateway fact, and the status line is
    // where gateway facts go — never a banner, and never a thrown-away grid.
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
  // The grid order is user data (the brief's State section) — hydrate it once
  // at mount, same as the appearance prefs in App.tsx.
  useEffect(() => {
    void hydratePins();
  }, []);
  // Switching / adding / forgetting a vault re-points the whole app at a new
  // vault — reload so the grid reflects the now-active vault's apps.
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
    // Springboard order first, THEN pins: the order is the default page, and a
    // pin is the member overriding it. Reversing the two would let the default
    // re-sort a pinned app back down the grid.
    () => orderByPins(orderForSpringboard(buildLauncherItems()), pins),
    [pins]
  );
  // The springboard is content: each first-party tile reads its own app's
  // replica shape. Independent of the gateway load above — the tiles fill
  // offline, and a sleeping gateway costs the grid nothing.
  const tiles = useSpringboardTiles();

  // The grading. A tile earns the grid by having something to show; an app that
  // has not becomes a first move. An app with NO tile at all is neither: it
  // keeps its place on the grid, because Home has no read that could say it is
  // empty and demoting it would be a guess.
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
      // The root stack fires the launch haptic on transitionStart (App.tsx), so
      // this handler only routes.
      switch (route.kind) {
        case "photos":
          navigation.navigate("Photos", { screen: "PhotosHome" });
          break;
        case "docs":
          navigation.navigate("Docs");
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

  /**
   * A first move has to land somewhere that can TAKE content.
   *
   * `connectors` has no mobile screen of its own — connecting an account is a
   * desktop act — so it routes to Settings, where this phone's own connection
   * to the gateway is managed and the nearest place the move can actually be
   * carried out. The app moves open the app they name, which on mobile is where
   * that app's own add control lives; there is no separate compose route to
   * send them to, and inventing one would be a destination that does not exist.
   */
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

  /** Day one's "Bring in photographs"/"Bring in documents" buttons — the SAME
   *  navigation `pickMove` uses for the identically-named first moves, found
   *  directly by app id rather than through the (day-one-only, top-3-limited)
   *  `moves` list, since day one's two buttons are fixed regardless of which
   *  three apps `firstMoves()` happens to rank first. */
  const openPhotos = useCallback((): void => {
    const item = items.find((candidate) => candidate.meta.id === "photos");
    if (item) openItem(item);
  }, [items, openItem]);
  const openDocuments = useCallback((): void => {
    const item = items.find((candidate) => candidate.meta.id === "docs");
    if (item) openItem(item);
  }, [items, openItem]);

  /**
   * "Fill it with sample content" — the demo register (#290): status, then
   * one seed POST per seedable app, then a replica pull so the tiles this
   * screen reads catch up to what just landed.
   *
   * Calls the gateway's `/centraid/_vault/demo` endpoints directly, mirroring
   * the exact contract `vaultDemoStatus`/`vaultDemoLoad`
   * (packages/client/src/gateway-client-vault.ts) already speak for desktop —
   * this file cannot import that module. `packages/client`'s only mobile-
   * reachable subpaths are `home-copy`, `capture`, `replica/native`,
   * `receipt-capture` and `version-handshake` (see that package's `exports`
   * map); the bare package barrel that carries
   * `vaultDemoLoad` also pulls in `pdfjs-dist`/`@sqlite.org/sqlite-wasm` and
   * other web-only weight Metro has no business bundling into the phone app.
   * Editing that map is outside the files this pass owns, so this speaks the
   * same wire contract instead of sharing the function. Fail-soft throughout,
   * same contract `packages/client/.../homeSample.ts` holds for desktop: a
   * partial or failed fill is recoverable (the offer stays live), never a
   * crash on the one screen every route returns to.
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
          // Sequential and per-app-caught, same as `seedHomeSample`: one
          // generator throwing is not the others' problem.
          // oxlint-disable-next-line no-await-in-loop -- ordered by contract
          await fetchJson(
            `${base}/centraid/_vault/demo/${encodeURIComponent(appId)}`,
            { headers: apiHeaders(), method: "POST" }
          );
        } catch {
          // Per-app failure is survivable — see the function comment.
        }
      }
      // Pull the seeded rows into the local replica before the tiles
      // re-read it, same ordering `syncHomeSampleReplica` enforces for
      // desktop — otherwise the tiles rebuild from the pre-seed replica and
      // day one appears to have done nothing.
      await replica.refresh?.();
    } catch {
      // A gateway that will not answer costs this offer, never the screen.
    }
    await loadHome(setState, { force: true });
  }, [replica]);

  /**
   * The eleven places (./home/places), each resolved to the nearest REAL
   * mobile screen — shared by the band (`selectBandTab`) and the All-apps
   * sheet's places half (`openPlace`), so the two never drift into naming two
   * different destinations for the same place.
   *
   * `notifs` is the Approvals inbox, which is what "waiting on a decision"
   * means here; `autos` is Automations; `conn` is Connectors, its own cover
   * since issue #765 (it used to share `settings`, which was the same lie the
   * paragraph below warns about — "What is allowed to reach outside" is not
   * the account screen); `settings` is Settings; `stats` and `gateway` both
   * land on Insights, which the nav tree's own comment already scopes as
   * "gateway health + limited usage insights" — one screen legitimately
   * holding both facts, not two labels hiding behind one wrong page.
   * `storage` is the stable id for On this phone, the local-replica-usage screen.
   * `data` and `devices` are the two net-new covers from the same issue.
   *
   * `starred` has NO mobile screen — there is no cross-app favourites view —
   * so it stays a STATED no-op rather than a guess at the nearest existing
   * screen. Routing it to a page that does not hold what the row promised
   * would be exactly the class of bug fixed elsewhere in Photos right now
   * (labelled rows that all silently opened the same wrong page); a place with
   * nowhere to go should fail loudly (by doing visibly nothing) rather than
   * lie.
   *
   * The `default` arm asserts `never` on the narrowed remainder, so a twelfth
   * place added to ./places without a case here is a typecheck failure, not a
   * silent fall-through.
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
    // Explicit `paddingTop` rather than SafeAreaView edges: edges intermittently
    // resolves to zero inside this app's cover stacks (PhotosHome carries the
    // same treatment for the same reason), which lands the vault lockup under
    // the status bar.
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

      {/* Fixed chrome, not scroll content — the handoff's mobile lockup and
          app bar are `flex:none` siblings ABOVE the scroll region, and the
          app bar carries its own hairline rule (`appBarStyle`, :5532–5533),
          which is why the prototype's scrollbar starts below that rule
          rather than under the vault lockup. */}
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
        {/* The offline banner said offline three ways in --net red for a state
            the status line already covers in one neutral clause; an offline-first
            product does not present its premise as an incident. */}
        {springboard === "first-run" ? (
          <DayOne
            // Real counts, on a vault that holds nothing: the foot is honest
            // about the zero rather than hiding it, and says what IS ready.
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
    // Bottom padding clears the status line and the flush band, so the last row
    // of the grid stays tappable.
    content: {
      paddingBottom: 24,
      paddingHorizontal: H_PADDING,
      paddingTop: 4,
    },
    screen: { backgroundColor: colors.bg, flex: 1 },
  });
