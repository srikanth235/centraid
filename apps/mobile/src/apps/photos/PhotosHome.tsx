// Photos' home surface on the phone (v4 handoff §3.1, §4, §14, §15).
// governance: allow-repo-hygiene file-size-limit The #712 screen intentionally retains its cohesive data/routing orchestration; #716 extracts only independently testable UI bodies.
//
// The screen is now the wiring: state, data and routing. Everything with a
// shape of its own moved out to a file that can be read — and tested — on its
// own terms:
//
//   photos-band.ts     the band's rules (five + More, the capsule, the ground)
//   PhotosBand.tsx     the band, rendered on OPAQUE paper
//   photos-rungs.ts    the four rungs, and pinch == stepper
//   justify.ts         justified packing from real aspect ratios
//   timeline-rows.ts   month/day grouping and the row list
//   PhotoTile.tsx      the tile and its four overlay slots
//   ScrubRail.tsx      the overlay rail and its month bubble
//   photos-backup.ts   the serial backup run
//   photos-vaults.ts   vault facts, keyed by id, `kind` never by name
//   photos-library-menu.ts  the Library chip's menu model — filter, tile size
//   photos-collections-menu.ts  the Collections chip's menu model — Show
//                                All / Collapse All

import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BAND_INSET } from "../../kit/band-surface";
import { useBandOwner } from "../../kit/band/band-owner";
import AnchoredMenu, { useMenuAnchor } from "../../kit/components/AnchoredMenu";
import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { useTheme } from "../../kit/theme";
import { hydrateBackupConsent } from "../../kit/transfer/transfer-consent";
import type { BackupConsentRecord } from "../../kit/transfer/transfer-consent";
import {
  optimisticRowId,
  optimisticValues,
} from "../../lib/replica/optimistic";
import { refreshPinnedThumbnailPack } from "../../lib/replica/thumbnail-pack";
import { backupDeviceMedia } from "../../lib/upload/media-producer";
import type { PhotosScreenProps } from "../../navigation";
import { Store } from "../../storage";
import { photoAccessTakesOverTimeline } from "./photo-access";
import PhotoAccessPanel, { usePhotoAccessGrant } from "./PhotoAccessPanel";
import PhotoPeriodGrid from "./PhotoPeriodGrid";
import { runBackup, useAutomaticPhotoBackup } from "./photos-backup";
import { inCloudMessage, nothingToBackUpMessage } from "./photos-backup-copy";
import { resolveMoreRowRoute } from "./photos-band";
import type { BandDestinationKey, PhotosMoreRowKey } from "./photos-band";
import { COLLECTION_SECTION_KEYS } from "./photos-collections";
import type { CollectionSectionKey } from "./photos-collections";
import { collectionsMenuGroups } from "./photos-collections-menu";
import { libraryMenuGroups } from "./photos-library-menu";
import type { LibraryFilter } from "./photos-library-menu";
import { usePhotosRung } from "./photos-rung-store";
import { batchTrash, vaultAssets } from "./photos-selection-writes";
import { drillInto } from "./photos-zoom";
import type { PeriodGroup, TimelineZoom } from "./photos-zoom";
import PhotosBand from "./PhotosBand";
import PhotosCollectionsView from "./PhotosCollectionsView";
import PhotosGridSkeleton from "./PhotosGridSkeleton";
import { makeStyles } from "./PhotosHome.styles";
import PhotosMoreSheet from "./PhotosMoreSheet";
import { PhotosSearchView } from "./PhotosSearch";
import PhotosSelectChip from "./PhotosSelectChip";
import PhotoTimeline from "./PhotoTimeline";
import {
  pinnedThumbnailCandidates,
  pinnedThumbnailSignature,
} from "./pinned-thumbnails";
import type { PhotoSection } from "./timeline-model";
import { onThisDay } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
import TimelineZoomDrawer from "./TimelineZoomDrawer";

/** `favorites` over the section list, dropping any day that empties out —
 *  the same shape iOS' own Favorites filter takes, and cheap enough to run on
 *  every render because a member's own library rarely runs past a few
 *  thousand rows on a phone. */
function filterSections(
  sections: readonly PhotoSection[],
  filter: LibraryFilter
): PhotoSection[] {
  if (filter !== "favorites") return sections as PhotoSection[];
  return sections
    .map((section) => ({
      ...section,
      assets: section.assets.filter((asset) => asset.favorite),
    }))
    .filter((section) => section.assets.length > 0);
}

/** The selection bar's centre plate, worded exactly as iOS Photos words its
 *  own (observed on simulator, issue #712): "Select Items" before anything is
 *  picked, then a bold count. `count === 0` is unreachable from this screen
 *  today — `selecting` only turns true once the first tile is preselected —
 *  but the label still handles it honestly rather than assuming a caller
 *  never will. */
function selectionCountLabel(count: number): string {
  if (count === 0) return "Select Items";
  return `${count} ${count === 1 ? "Photo" : "Photos"} Selected`;
}

function albumEntryCount<T>(
  rows: readonly T[],
  albumId: string,
  collectionId: (row: T) => unknown
): number {
  return rows.filter((row) => String(collectionId(row)) === albumId).length;
}

export default function PhotosHome({
  navigation,
  route,
}: PhotosScreenProps<"PhotosHome">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { session, gatewayBase, vaultId, refresh } = useReplica();
  const timeline = usePhotoTimeline();
  // §13 / P13. The OS grant, read HERE rather than on a screen a member has to
  // go and find: the timeline is the surface that goes blank when the grant is
  // refused, so the timeline is the surface that has to say why.
  const grant = usePhotoAccessGrant();
  const deviceReadable = timeline.assets.filter(
    (asset) => asset.source !== "replica"
  ).length;
  const accessTakeover = photoAccessTakesOverTimeline({
    state: grant.state,
    deviceReadableCount: deviceReadable,
    vaultReadableCount: timeline.assets.length - deviceReadable,
    loading: timeline.loading,
  });

  // The band on a PUSHED Photos screen (PhotosScreen) navigates here with the
  // destination it wants rather than pushing a second copy of Home. React
  // Navigation updates params on a mounted screen WITHOUT remounting it, so
  // the initial state alone would silently ignore every tap after the first —
  // the effect is what makes the band work from a pushed screen at all.
  // COLLECTIONS IS THE LANDING, not the timeline. Opening Photos onto a wall
  // of every photograph you own answers a question a member rarely has —
  // "show me everything, newest first" — while the shelves that answer the
  // questions they do have (which album, which person, which place) were a
  // tab away and, for five of the eight, behind a sheet. iOS Photos made the
  // same move for the same reason. Library is one tap away and is still where
  // the band starts you if you ask for it by name.
  const [destination, setDestination] = useState<BandDestinationKey>(
    route.params?.destination ?? "collections"
  );
  const routeDestination = route.params?.destination;
  useEffect(() => {
    if (routeDestination)
      queueMicrotask(() => setDestination(routeDestination));
  }, [routeDestination]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);
  // The header chip's own frame, measured on the press that opens the menu —
  // the card hangs off THAT rectangle rather than off a guessed corner. See
  // `useMenuAnchor` for why `onLayout` cannot answer this.
  // Destructured, never held as one object: `menuAnchorRef` goes to a `ref`
  // prop, and react-compiler rightly treats anything reachable through a
  // ref-carrying value as a ref — reading `.anchor` off the same object during
  // render then reads as a ref access.
  const {
    anchor: menuAnchorRect,
    anchorRef: menuAnchorRef,
    measureAnchor,
  } = useMenuAnchor();
  // Session-scoped, unlike the rung below: iOS resets its own Library filter
  // between visits too, and — see `photos-library-menu.ts`'s header — this
  // repo has no member-preference plane to persist a THIRD device-local key
  // in beyond `bandOwner` and the rung, both of which already stretch that
  // reality about as far as it should go.
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  // THE TEMPORAL GRAIN (issue #712 iOS parity, `photos-zoom.ts`). Session
  // state, for the same reason the filter above is: this repo has no
  // member-preference plane to spend a third device-local key in, and iOS
  // itself returns to All between visits.
  const [zoom, setZoom] = useState<TimelineZoom>("all");
  // The day All was told to land on by the grain above it. Held here rather
  // than passed through the drawer because it outlives the tap: the grid
  // mounts after the grain changes, and the value has to still be there when
  // it does.
  const [landingDay, setLandingDay] = useState<string | undefined>(undefined);
  // A counter, not a flag — see `TimelineZoomDrawer`'s own prop comment for
  // why a boolean cannot re-arm a hide timer.
  const [scrollActivity, setScrollActivity] = useState(0);
  const noteScroll = useCallback(
    (): void => setScrollActivity((count) => count + 1),
    []
  );
  const openPeriod = useCallback((period: PeriodGroup): void => {
    setLandingDay(period.anchorDay);
    // `drillInto` IS the updater: Years → Months → All, read off the grain
    // actually on screen rather than off a captured copy of it.
    setZoom(drillInto);
  }, []);
  // Collections' own fold state, LIFTED here from `PhotosCollectionsView.tsx`
  // (issue #712): the header's trailing chip is now the ONE place Show All /
  // Collapse All live, so it has to drive the same set the per-section
  // chevrons on that page toggle — two owners of one fold would let a member
  // watch the chip say "folded" while a chevron underneath still says open.
  // Session state, not a member preference — see
  // `photos-collections-menu.ts`'s header for the same argument about why
  // this repo has no third device-local key to spend on it.
  const [collapsedSections, setCollapsedSections] = useState<
    ReadonlySet<CollectionSectionKey>
  >(() => new Set());
  const toggleCollectionSection = useCallback(
    (key: CollectionSectionKey): void => {
      setCollapsedSections((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    []
  );
  const [selection, setSelection] = useState(new Set<string>());
  const [backingUp, setBackingUp] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    completed: number;
    total: number;
  }>();
  const [refreshing, setRefreshing] = useState(false);

  // Tile size is a MEMBER preference shared by every shelf, so it lives in one
  // store rather than in this screen. There is no server-side member-preference
  // plane in this repo, and the shipped web shell persists `bandOwner` per
  // device for exactly that reason — so both persist per device here, matching
  // that reality rather than inventing a sync path.
  // Read here for the skeleton's geometry, and WRITTEN from the header menu's
  // View Options rows (photos-library-menu.ts) — the same store the pinch
  // gesture on the grid moves, so the two can never disagree.
  const [rung, setRung] = usePhotosRung();
  // The FRAME's latch, not Photos' (issue #712 E3). The hydrate-into-state
  // dance this replaced lived in two Photos screens under a Photos-owned key;
  // it is one hook in `kit/band/band-owner.ts` now, on the same
  // `shell.bandOwner.<appId>` key the web shell already used, and the member's
  // answer is WRITTEN from frame Settings rather than only read.
  const { bandOwner } = useBandOwner("photos");

  // The automatic sweep (#711 S4) belongs HERE, not on the Backup screen: the
  // enqueue it performs is over newly-taken camera-roll photographs, and the
  // walk that finds them runs wherever Photos is on screen. Mounted only on the
  // Backup screen it swept only while a member was looking at backup settings,
  // which is the one moment the photographs are already accounted for.
  //
  // Consent is the gate and the only gate: `useAutomaticPhotoBackup` derives
  // its candidates through `automaticTransferAllowed`, so an unanswered or
  // `not-now` latch yields an empty set and nothing is ever enqueued. Hydrated
  // exactly as `BackupHealth.tsx` hydrates it — one device-local latch, read,
  // never written from here.
  const [backupConsent, setBackupConsent] = useState<BackupConsentRecord>();
  useEffect(() => {
    void hydrateBackupConsent().then(setBackupConsent);
  }, []);
  useAutomaticPhotoBackup(backupConsent);

  const collections = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection" }), [])
  );
  const entries = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection_entry" }), [])
  );
  const memories = useMemo(() => onThisDay(timeline.assets), [timeline.assets]);
  // The one place the Library's filter actually acts (the header menu,
  // issue #712): Collections, People and Search are each their own shelf
  // already, over their own queries, so a filter meant for "what the grid of
  // every photograph shows" has no honest meaning there.
  const visibleSections = useMemo(
    () => filterSections(timeline.sections, libraryFilter),
    [timeline.sections, libraryFilter]
  );
  // THE ONE TRAILING CONTROL, DESTINATION-SCOPED (issue #712). iOS Photos
  // carries exactly one options chip on its title row, and its contents
  // change per page — never a control that stays put while the surface under
  // it changes out from under it. Library's Sliders menu acts on a grid that
  // only Library draws; Collections' `···` menu acts on the fold state of a
  // stack of rails that only Collections draws. A chip that opened either
  // menu on a destination it cannot act on would still be present, still
  // tappable, and would still do nothing the member could see happen — a
  // control that cannot act on what is on screen is worse than no control,
  // because it claims capability the screen does not have. Search has no
  // honest menu of its own (verified: the file wires no AnchoredMenu today),
  // so the chip is simply absent there rather than opening onto an empty card.
  const menuGroups = useMemo(() => {
    if (destination === "library") {
      return libraryMenuGroups({
        filter: libraryFilter,
        onFilter: setLibraryFilter,
        onRung: setRung,
        rung,
        zoom,
      });
    }
    if (destination === "collections") {
      // Show All / Collapse All set every one of the eight fixed sections at
      // once (`COLLECTION_SECTION_KEYS`, `photos-collections.ts`) — the same
      // full set `buildCollectionSections` always returns, so Collapse All
      // folds the whole page even before its replica queries have answered.
      return collectionsMenuGroups({
        onCollapseAll: () =>
          setCollapsedSections(new Set(COLLECTION_SECTION_KEYS)),
        onShowAll: () => setCollapsedSections(new Set()),
      });
    }
    return [];
  }, [destination, libraryFilter, rung, setRung, zoom]);

  const refreshLibrary = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refresh?.();
    } finally {
      setRefreshing(false);
    }
  };

  // The pack refresh stats every pinned file and downloads the missing ones, so
  // it must not ride every timeline snapshot — the engine republishes on each
  // replica tick, and the candidate set is unchanged in almost all of them.
  const packSignature = useRef<string | undefined>(undefined);
  const packRun = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    if (!gatewayBase) return;
    const assets = timeline.assets;
    const signature = pinnedThumbnailSignature(gatewayBase, assets);
    if (signature === packSignature.current) return;
    packSignature.current = signature;
    packRun.current = (packRun.current ?? Promise.resolve())
      .then(() =>
        refreshPinnedThumbnailPack(
          pinnedThumbnailCandidates(gatewayBase, assets)
        )
      )
      // Forgetting the signature is the recovery: a failed pack refresh leaves
      // thumbnails to be fetched on demand (degraded, not broken), and the next
      // snapshot retries instead of being skipped as "already done".
      .catch(() => {
        packSignature.current = undefined;
      });
  }, [gatewayBase, timeline.assets]);

  useEffect(() => {
    if (memories.length === 0) return;
    const key = `photos.onThisDay.${new Date().toISOString().slice(0, 10)}`;
    void Store.hydrate(key, false).then(async (scheduled) => {
      if (scheduled) return;
      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted) return;
      const fireAt = new Date();
      fireAt.setHours(18, 0, 0, 0);
      if (fireAt <= new Date()) fireAt.setTime(Date.now() + 60_000);
      await Notifications.scheduleNotificationAsync({
        content: {
          title: "On this day",
          body: `${memories.length} moments from years past`,
          data: { route: "Photos" },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireAt,
        },
      });
      Store.set(key, true);
    });
  }, [memories]);

  const backupSelection = async (): Promise<void> => {
    if (!session || !gatewayBase) {
      postStatus(
        "Desktop unavailable — pair or reconnect a gateway before backup."
      );
      return;
    }
    const selected = timeline.assets.filter(
      (asset) => selection.has(asset.id) && asset.localId
    );
    // Nothing to send is an ANSWER, not a success — see
    // `nothingToBackUpMessage` for why this branch exists at all.
    if (!selected.length) {
      postStatus(nothingToBackUpMessage(selection.size));
      return;
    }
    setBackingUp(true);
    try {
      const outcome = await runBackup(selected, {
        onProgress: setUploadProgress,
        upload: (input) =>
          backupDeviceMedia(session, gatewayBase, {
            ...input,
            ...(vaultId ? { targetVaultId: vaultId } : {}),
          }),
      });
      setSelection(outcome.inCloud);
      if (outcome.paused) postStatus(outcome.paused);
      else if (outcome.inCloud.size)
        postStatus(inCloudMessage(outcome.inCloud.size));
      else
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success
        );
    } finally {
      setBackingUp(false);
      setUploadProgress(undefined);
    }
  };

  const addToAlbum = (): void => {
    const albums = collections.rows.slice(0, 6);
    if (!albums.length) {
      navigation.navigate("PhotosLibrary");
      return;
    }
    Alert.alert("Add to album", `${selection.size} selected`, [
      ...albums.map((album) => ({
        text: String(album.name ?? "Album"),
        onPress: () =>
          void (async () => {
            if (!session) return;
            const assets = timeline.assets.filter(
              (item) => selection.has(item.id) && item.assetId
            );
            try {
              // Serial by contract: each entry's `position` is derived from
              // the rows the previous write just landed, and the ledger keeps
              // the member's selection order. Parallel writes would race both.
              for (const [index, asset] of assets.entries()) {
                const albumId = String(album.collection_id);
                const entryId = optimisticRowId("album-entry");
                const position =
                  albumEntryCount(
                    entries.rows,
                    albumId,
                    (row) => row.collection_id
                  ) + index;
                // oxlint-disable-next-line no-await-in-loop
                const result = await session.write("photos", {
                  action: "add-to-album",
                  input: { album_id: albumId, asset_id: asset.assetId! },
                  optimistic: [
                    {
                      op: "upsert",
                      entity: "core.collection_entry",
                      rowId: entryId,
                      values: {
                        entry_id: entryId,
                        collection_id: albumId,
                        target_type: "media.media_asset",
                        target_id: asset.assetId!,
                        position,
                        added_at: new Date().toISOString(),
                      },
                    },
                    ...(album.cover_content_id == null && asset.contentId
                      ? [
                          {
                            op: "upsert" as const,
                            entity: "core.collection",
                            rowId: albumId,
                            values: optimisticValues(album, {
                              cover_content_id: asset.contentId,
                            }),
                          },
                        ]
                      : []),
                  ],
                });
                surfaceWriteOutcome(result);
              }
              setSelection(new Set());
            } catch (error) {
              surfaceWriteFailure(error, "Photos not added");
            }
          })(),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  // TRASH, ON THE RIGHT (issue #712 — iOS parity). `batchTrash` already
  // exists as the shared selection write (`photos-selection-writes.ts`,
  // exercised today from AlbumDetail's and the Duplicates shelf's own
  // selection bars) — the Library grid gets the same write rather than a
  // second implementation, which is what earns Trash the right-hand chip
  // instead of a second Backup. The confirmation copy matches AlbumDetail's
  // trash target word for word: the device original surviving this action is
  // the one fact a member cannot infer from "Trash" alone.
  const trashSelection = (): void => {
    if (!session) return;
    const targets = vaultAssets(timeline.assets, selection);
    Alert.alert(
      `Move ${selection.size} to trash?`,
      "The device original is never deleted by this action.",
      [
        { text: "Cancel" },
        {
          text: "Trash",
          style: "destructive",
          onPress: () => {
            void batchTrash(session, targets, surfaceWriteOutcome)
              .then(() => setSelection(new Set()))
              .catch((error: unknown) =>
                surfaceWriteFailure(error, "Photos not trashed")
              );
          },
        },
      ]
    );
  };

  // SCOPED TO THE LIBRARY GRID (issue #712). `selection` is state PhotosHome
  // owns, but it is only ever MUTATED by the timeline's own
  // `onSelectionChange` — `PhotoTimeline`, rendered on the "library"
  // destination alone; Collections, People and Search never touch it. Gating
  // on `destination` too, rather than on `selection.size` alone, keeps the
  // header and the selection bar honest for the one render where a member has
  // switched destinations with a residual selection still in state and the
  // effect below has not yet cleared it.
  const selecting = selection.size > 0 && destination === "library";

  const onDestination = (key: BandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    // The residual-selection case (issue #712): a member selects on Library,
    // then taps another band destination WITHOUT pressing ✕ first. Nothing
    // else in this screen clears `selection` on a destination change — it
    // otherwise only empties when a target's own write or Done fires — so
    // without this line a selection would sit in state, invisible while
    // `selecting`'s own `destination === "library"` guard hides it elsewhere,
    // and then reappear with its stale tiles still checked the moment
    // Library is current again. Cleared HERE, synchronously with the
    // destination change that leaves it stale, rather than from an effect —
    // an effect that calls `setSelection` off its own dependency is exactly
    // the cascading-render shape `react-compiler` flags.
    if (key !== "library") setSelection(new Set());
    // Same reasoning, one control over (issue #712): the trailing chip's own
    // menu is destination-scoped, so a card left open across a destination
    // change would either hang off a chip that just vanished (People,
    // Search) or silently swap its rows for the new destination's answer
    // under a card the member never asked to reopen. Closed HERE for the
    // same synchronous reason `selection` is cleared above rather than from
    // an effect.
    setViewOptionsOpen(false);
    // Search is a DESTINATION, not a push (proto:4953-4954). `appBandOn`
    // excludes only the viewer, zoom, video, slideshow and the editor — Search
    // is none of those, so the band must stay up with Search current and the
    // frame's Home capsule still reachable. Pushing `PhotosSearch` gave it a
    // back chevron and no band at all, which is the rule this line now keeps.
    setDestination(key);
  };

  const onMoreRow = (key: PhotosMoreRowKey): void => {
    setMoreOpen(false);
    // Still routed through `resolveMoreRowRoute` rather than inlined, even
    // now that the sheet carries one row: the router is what makes an unwired
    // row fail to typecheck instead of silently landing on Library, and the
    // day a second row is added is exactly the day that guard earns its keep.
    //
    // The one row is CROSS-STACK (B2): Backup health is a frame screen, so
    // this leaves the Photos cover for the Settings cover rather than pushing
    // a Photos route that does not exist.
    const nextRoute = resolveMoreRowRoute(key);
    navigation.navigate(nextRoute.screen, nextRoute.params);
  };

  return (
    // Photos' declared surface tone is "mat" (freedom table, DESIGN.md) —
    // only the page moves; every other role still reads from the shared ramp.
    // Explicit inset, not SafeAreaView-with-edges: inside the fullScreenModal
    // cover this stack presents, the edges variant intermittently resolves a
    // zero top inset while `useSafeAreaInsets()` stays correct (the viewer
    // relies on the same hook for the same reason).
    <View
      style={[
        styles.safe,
        { backgroundColor: colors.toneMat, paddingTop: insets.top },
      ]}
    >
      {selecting ? (
        // iOS PARITY (issue #712, observed on simulator). Entering Select
        // keeps the header's own page title — this is still Photos, not a new
        // surface — and moves everything else to the RIGHT: the leftover
        // action plus a round ✕ chip that exits. The count and the two verbs
        // iOS puts at the thumb (Add to album, Trash) move to the bar at the
        // foot instead (see the band-swap render site below) — a header row
        // is not where a member's thumb rests, and iOS does not put them
        // there either. Backup has no iOS analogue and nowhere on the bar's
        // three plates to sit once Add to album and Trash take the outer two,
        // so it stays up here as the one action that did not fit the bar.
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            Photos
          </Text>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back up to the gateway"
              accessibilityState={{ disabled: backingUp }}
              disabled={backingUp}
              onPress={() => void backupSelection()}
              style={styles.headerBtn}
            >
              <Icon
                name="upload-cloud"
                size={22}
                color={backingUp ? colors.textDisabled : colors.text}
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done"
              onPress={() => setSelection(new Set())}
              style={styles.headerBtn}
            >
              <Icon name="x" size={23} color={colors.text} />
            </Pressable>
          </View>
        </View>
      ) : (
        // No ☰. The claimed band is the ONE navigation on the phone (§F/§3.1):
        // a drawer behind a menu button would be a second way to the same five
        // destinations, and the frame's own destinations (identity, vault
        // switching, Settings) belong to the frame — reached through the band's
        // Home capsule, never mirrored inside the app.
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            Photos
          </Text>
          <View style={styles.headerActions}>
            {/* The chip iOS' own Library header carries — Sort (omitted, see
                photos-library-menu.ts), Filter and View Options (tile size)
                live behind it now instead of a permanent toolbar row or a
                buried More-sheet stepper. It opens an ANCHORED MENU, not a
                bottom sheet: the chip stays where it is and the card hangs off
                it, so the grid underneath never moves out from under the
                member who pressed it. On Collections the SAME slot carries
                iOS' own `···` (Show All / Collapse All) instead — see the
                `menuGroups` comment above for why one destination never gets
                the other's menu, and why People/Search get neither. */}
            {destination === "library" || destination === "collections" ? (
              <Pressable
                ref={menuAnchorRef}
                accessibilityRole="button"
                accessibilityLabel={
                  destination === "library"
                    ? "View options"
                    : "Collections options"
                }
                onPress={() => {
                  // Measured on the press, never cached: a rotation or a
                  // dynamic-type change between two openings would leave a
                  // stale rectangle and hang the card off nothing.
                  measureAnchor();
                  setViewOptionsOpen(true);
                }}
                style={styles.headerBtn}
              >
                <Icon
                  name={
                    destination === "library" ? "Sliders" : "more-horizontal"
                  }
                  size={22}
                  color={colors.text}
                />
              </Pressable>
            ) : null}
            {/* SCOPED TO THE LIBRARY GRID, same as `selecting` below (issue
                #712). Select's own entry point used to render on every
                destination — pressing it on Collections silently populated
                `selection` with a tile the member could never see checked,
                because `selecting`'s own `destination === "library"` guard
                already hid the bar it would have opened. That is the exact
                inert-control shape this pass removes the Sliders chip for
                elsewhere, so Select gets the same scoping rather than a
                second control that appears to do nothing. */}
            {destination === "library" ? (
              <PhotosSelectChip
                disabled={timeline.assets.length === 0}
                onPress={() => {
                  const first = timeline.assets[0];
                  if (first) setSelection(new Set([first.id]));
                }}
              />
            ) : null}
          </View>
        </View>
      )}

      <ReplicaStatusBar />

      {backingUp && uploadProgress ? (
        // Determinate, with exact counts. Never a spinner (§18).
        <View
          accessibilityLabel={`Uploading ${uploadProgress.completed} of ${uploadProgress.total}`}
          accessibilityRole="progressbar"
          accessibilityValue={{
            min: 0,
            max: uploadProgress.total,
            now: uploadProgress.completed,
          }}
          style={styles.uploadProgress}
        >
          <Text style={styles.uploadProgressText}>
            Uploading {uploadProgress.completed} of {uploadProgress.total}
          </Text>
          <View style={styles.uploadTrack}>
            <View
              style={[
                styles.uploadFill,
                {
                  backgroundColor: colors.text,
                  width: `${Math.round(
                    (uploadProgress.completed /
                      Math.max(uploadProgress.total, 1)) *
                      100
                  )}%`,
                },
              ]}
            />
          </View>
        </View>
      ) : null}

      <ReplicaStateCard
        connection={collections.connection}
        error={collections.error ?? timeline.error}
        unavailableReason={collections.unavailableReason}
        noun="Photo vault"
        onRetry={() => void refreshLibrary()}
      />

      <View style={styles.body}>
        {destination === "collections" ? (
          <PhotosCollectionsView
            navigation={navigation}
            collapsed={collapsedSections}
            onToggleSection={toggleCollectionSection}
          />
        ) : destination === "search" ? (
          <PhotosSearchView navigation={navigation} />
        ) : accessTakeover && grant.state ? (
          // THE TAKEOVER (§13, P13). The grid's own slot carries the refusal
          // grammar — what was tried, why it was refused, what to do — instead
          // of an empty grid with no sentence and no way back. The band below
          // is untouched: the way out of Photos is never what a refusal takes
          // away. No toolbar either: a tile-size stepper over no tiles is a
          // control for a thing that is not there.
          <PhotoAccessPanel
            state={grant.state}
            canAskAgain={grant.canAskAgain}
            // Only the limited state prints it, and only once the walk has
            // finished: a count read mid-walk is true for a second and wrong
            // after.
            readableCount={timeline.loading ? null : deviceReadable}
            onRequest={() => grant.request()}
          />
        ) : (
          <>
            {/* No toolbar row. The tile-size stepper it existed to hold now
                lives in the header chip's anchored menu (photos-library-menu.ts,
                drawn by kit/components/AnchoredMenu.tsx) — the grid takes the
                same preference by pinch (§4.2), and 44 permanent points above
                the first photograph is a high rent for a control a member
                touches a handful of times. The rung itself is still read
                here, and still governs the skeleton, so the geometry that
                lands is the geometry that was showing. */}
            {timeline.loading ? (
              // The grid IS the loading state (§14, proto:3993-4033): packed
              // placeholder tiles at the exact geometry the real rows will
              // take, so nothing reflows when the bytes land. Never a message
              // the grid then replaces, and never a spinner (§18).
              <PhotosGridSkeleton rung={rung} />
            ) : timeline.sections.length === 0 ? (
              <View style={styles.center}>
                <Text style={styles.emptyTitle}>
                  {collections.connection === "offline"
                    ? "No cached vault photographs"
                    : "Your library starts here"}
                </Text>
                <Text style={styles.bodyText}>
                  {collections.connection === "offline"
                    ? "Camera-roll photographs remain available. Reconnect to check the vault."
                    : "Camera-roll photographs appear instantly; hold any one to back it up."}
                </Text>
              </View>
            ) : visibleSections.length === 0 ? (
              // The FILTER emptied the grid, not the library — a different
              // fact from the one above, so it gets its own sentence rather
              // than reusing "Your library starts here" over a library that
              // plainly is not empty.
              <View style={styles.center}>
                <Text style={styles.emptyTitle}>No favorites yet</Text>
                <Text style={styles.bodyText}>
                  Photographs you mark as a favorite appear here.
                </Text>
              </View>
            ) : zoom === "all" ? (
              <PhotoTimeline
                sections={visibleSections}
                selection={selection}
                refreshing={refreshing}
                // The one surface that holds the connection signal, so the one
                // surface that can honestly tell a tile the gateway is down.
                unreachable={
                  collections.connection === "offline" ||
                  collections.connection === "unavailable"
                }
                scrollToDay={landingDay}
                onScrollActivity={noteScroll}
                onRefresh={() => void refreshLibrary()}
                onSelectionChange={setSelection}
                onOpen={(asset) =>
                  navigation.navigate("PhotoLightbox", { assetId: asset.id })
                }
              />
            ) : (
              // A SUMMARY GRAIN. The same sections the grid above would draw,
              // grouped into periods — never a different query, so the two
              // grains cannot disagree about what the library holds.
              <PhotoPeriodGrid
                sections={visibleSections}
                grain={zoom}
                refreshing={refreshing}
                onRefresh={() => void refreshLibrary()}
                onScrollActivity={noteScroll}
                onOpenPeriod={openPeriod}
              />
            )}
          </>
        )}
        {/* THE ZOOM DRAWER (issue #712 iOS parity). Inside the grid's own slot
            rather than beside the band, because it belongs to the Library
            surface: it moves between grains of THAT list, and it must vanish
            with it. Hidden while a selection is live — the selection bar has
            already taken the foot, and two floating controls stacked there
            would be two answers to "what does the bottom of this screen do".
            Hidden on an empty library too: three grains of nothing is three
            doors onto the same blank page. */}
        {destination === "library" && !selecting && visibleSections.length ? (
          <TimelineZoomDrawer
            level={zoom}
            onLevel={setZoom}
            activity={scrollActivity}
          />
        ) : null}
      </View>

      {/* Exactly ONE thing at the foot: the band, or — while a selection is
          live on the Library grid (issue #712 iOS parity) — the selection
          bar that takes its place. Never both, and never the bar anywhere
          Search, Collections or People are current: `selecting` above is
          already scoped to `destination === "library"`, so this ternary
          cannot show the bar over a shelf that has no selection to act on.

          THE BAR'S OWN ANATOMY, not a new one: three plates in the SAME
          transparent row the band itself draws (`PhotosBand.tsx`'s header
          comment — opaque `bgElev`/`lineStrong` plates, `BAND_RADIUS`
          corners, `BAND_INSET` off the stage, never glass or blur). Left and
          right are round-ish chips at the capsule's own 52pt; the centre is a
          `flex:1` plate carrying the bold count, mirroring how the band's own
          capsule and tab-group plates share the row. It replaces the band
          rather than sitting inside `styles.header` (where the count and
          every action used to live) because the band's own foot is where a
          member's thumb already is mid-selection — iOS puts Select's own
          verbs there for the same reason, not in the navigation bar. */}
      {selecting ? (
        <View
          style={[
            styles.selectionBarRow,
            { paddingBottom: BAND_INSET + insets.bottom },
          ]}
        >
          {/* Left chip — Add to album. The nearest verb this grid has to
              iOS' own Share position: the phone has no OS share sheet to
              hand a multi-select OUT of the grid to, and inventing one here
              would be the exact defect `NO_DOWNLOAD_REASON`
              (`photos-selection-writes.ts`) exists to name honestly rather
              than paper over. Add to album is the write this grid already
              performs over a selection, so it takes the position instead of
              a dead Share glyph. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add to album"
            onPress={addToAlbum}
            style={styles.selectionChip}
          >
            <Icon name="folder-plus" size={20} color={colors.text} />
          </Pressable>

          {/* Centre plate — the count, and only the count (§ above): "Select
              Items" is unreachable today since `selecting` requires at least
              one tile, but the label still knows the word for zero rather
              than assuming a future caller of `setSelection` never passes an
              empty set while `destination` is "library". */}
          <View style={styles.selectionCountPlate}>
            <Text style={styles.selectionCountText} numberOfLines={1}>
              {selectionCountLabel(selection.size)}
            </Text>
          </View>

          {/* Right chip — Trash. `batchTrash` already exists as the shared
              selection write, exercised today from AlbumDetail's and the
              Duplicates shelf's own bars, so the Library grid takes the SAME
              write rather than a second implementation — which is what earns
              Trash the position iOS gives it here instead of a second Backup
              chip. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Move to trash"
            onPress={trashSelection}
            style={styles.selectionChip}
          >
            <Icon name="trash-2" size={20} color={colors.danger} />
          </Pressable>
        </View>
      ) : (
        <PhotosBand
          owner={bandOwner}
          current={destination}
          onSelect={onDestination}
          // `popTo`, not `navigate` and not `goBack`. React Navigation 7's
          // `navigate` no longer returns to a route already in the stack — it
          // PUSHES a second copy (StackRouter's NAVIGATE only reuses a route
          // when the action carries `pop`, which is what `popTo` sets). A
          // screen pushed above a `fullScreenModal` is presented modally by
          // UIKit, so Home arrived as an inset card sheet over Photos instead
          // of Photos dismissing. `goBack` is wrong too: Photos can be
          // entered by deep link (deep-links.ts), where there is nothing to
          // go back TO — and §3.1 makes the way home the one thing an app may
          // never take away. `popTo` covers both: it pops to Home when Home
          // is beneath, and REPLACES the cover with Home when it is not.
          onHome={() => navigation.popTo("Home")}
        />
      )}

      <PhotosMoreSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        onSelect={onMoreRow}
      />

      <AnchoredMenu
        visible={viewOptionsOpen}
        anchor={menuAnchorRect}
        groups={menuGroups}
        onClose={() => setViewOptionsOpen(false)}
      />
    </View>
  );
}
