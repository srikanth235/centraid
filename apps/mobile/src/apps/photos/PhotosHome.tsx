// Photos' home surface on the phone (v4 §3.1, §4, §14, §15). Wiring only — shaped UI lives in siblings.
// governance: allow-repo-hygiene file-size-limit The #712 screen intentionally retains its cohesive data/routing orchestration; #716 extracts only independently testable UI bodies.

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
import SelectChip from "../../kit/components/SelectChip";
import { postStatus } from "../../kit/components/status-line";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { TEST_IDS } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
import { hydrateBackupConsent } from "../../kit/transfer/transfer-consent";
import type { BackupConsentRecord } from "../../kit/transfer/transfer-consent";
import { refreshPinnedThumbnailPack } from "../../lib/replica/thumbnail-pack";
import { backupDeviceMedia } from "../../lib/upload/media-producer";
import type { PhotosScreenProps } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import { Store } from "../../storage";
import CameraRollImportOffer from "./CameraRollImportOffer";
import { detectFacesFor } from "./people-model";
import { photoAccessTakesOverTimeline } from "./photo-access";
import { PHOTO_ENTITY_READS } from "./photo-entity-reads";
import PhotoAccessPanel, { usePhotoAccessGrant } from "./PhotoAccessPanel";
import PhotoGrainView from "./PhotoGrainView";
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
import PhotosBand from "./PhotosBand";
import PhotosCollectionsView from "./PhotosCollectionsView";
import PhotosGridSkeleton from "./PhotosGridSkeleton";
import { makeStyles } from "./PhotosHome.styles";
import PhotosMoreSheet from "./PhotosMoreSheet";
import { PhotosSearchView } from "./PhotosSearch";
import PhotoTimeline from "./PhotoTimeline";
import {
  pinnedThumbnailCandidates,
  pinnedThumbnailSignature,
} from "./pinned-thumbnails";
import { anchorForGrain } from "./timeline-grains";
import type { GrainPeriod, TimelineGrain } from "./timeline-grains";
import type { PhotoSection } from "./timeline-model";
import { onThisDay } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
import TimelineGrainControl, {
  GRAIN_CONTROL_SLOT,
} from "./TimelineGrainControl";

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

/** iOS Photos wording (#712). Keep the `count === 0` branch — do not assume no caller. */
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
  // §13 / P13: read here — the timeline goes blank when the grant is refused, so it must say why.
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

  // Collections is the landing. Effect is load-bearing: Navigation updates params without remounting.
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
  // Destructure; never hold as one object — react-compiler treats a ref-carrying value as a ref.
  const {
    anchor: menuAnchorRect,
    anchorRef: menuAnchorRef,
    measureAnchor,
  } = useMenuAnchor();
  // Filter, grain, place and fold state stay SESSION-scoped: this repo has no
  // member-preference plane, and `bandOwner` plus the rung already stretch
  // device-local storage as far as it should go.
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [grain, setGrain] = useState<TimelineGrain>("all");
  // A `PhotoSection.day` — the one vocabulary all three grains speak. Held here,
  // not in a grain's view: it must outlive the view across a switch.
  const [placeDay, setPlaceDay] = useState<string | undefined>(undefined);
  // Lifted out of `PhotosCollectionsView` (#712): the header chip's Show
  // All / Collapse All must drive the same set the chevrons toggle, or the two
  // can disagree.
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

  const [rung, setRung] = usePhotosRung();
  // Frame latch, not Photos' (#712): `shell.bandOwner.<appId>`.
  const { bandOwner } = useBandOwner("photos");

  // Automatic sweep (#711) mounts here — must walk wherever Photos is on screen. Consent is the only gate.
  const [backupConsent, setBackupConsent] = useState<BackupConsentRecord>();
  useEffect(() => {
    void hydrateBackupConsent().then(setBackupConsent);
  }, []);
  useAutomaticPhotoBackup(backupConsent);

  const collections = useReplicaQuery("photos", PHOTO_ENTITY_READS.collections);
  const entries = useReplicaQuery(
    "photos",
    PHOTO_ENTITY_READS.collectionEntries
  );
  const memories = useMemo(() => onThisDay(timeline.assets), [timeline.assets]);
  const visibleSections = useMemo(
    () => filterSections(timeline.sections, libraryFilter),
    [timeline.sections, libraryFilter]
  );
  // Re-express the current place as a day the target grain can land on — switching up a grain must not dump the scroll.
  const changeGrain = useCallback(
    (next: TimelineGrain): void => {
      setPlaceDay((current) => anchorForGrain(visibleSections, next, current));
      setGrain(next);
    },
    [visibleSections]
  );
  // Leaving Library resets grain and place. Deferred: sync setState in the effect is the shape react-compiler rejects.
  useEffect(() => {
    if (destination === "library") return;
    queueMicrotask(() => {
      setGrain("all");
      setPlaceDay(undefined);
    });
  }, [destination]);
  // A card tap: one grain narrower, at that period's first day.
  const openPeriod = useCallback((period: GrainPeriod): void => {
    setPlaceDay(period.anchorDay);
    // Off the grain on screen, never a captured copy.
    setGrain((current) => (current === "years" ? "months" : "all"));
  }, []);
  // Trailing control is destination-scoped (#712). Search has no honest menu.
  // `detectFacesFor` is the gateway question, not `deviceAnswerFor` (#724).
  const enrichPolicies = useReplicaQuery(
    "photos",
    useMemo(() => ({ acceptTruncation: true, entity: "enrich.policy" }), [])
  );
  const detectFacesAvailability = detectFacesFor(
    enrichPolicies.loading
      ? null
      : ((enrichPolicies.rows.find((row) => row.domain === "photos")?.tier as
          | string
          | undefined) ?? "off")
  );

  const menuGroups = useMemo(() => {
    if (destination === "library") {
      return libraryMenuGroups({
        filter: libraryFilter,
        onFilter: setLibraryFilter,
        onRung: setRung,
        rung,
        grain,
        detectFaces: {
          availability: detectFacesAvailability,
          // The consent gate (the People roster's empty state), never the
          // enrichment write — see `photos-library-menu.ts`'s header.
          onDetectFaces: () => navigation.navigate("PhotosPeople"),
        },
      });
    }
    if (destination === "collections") {
      // Over the full fixed key set, not the rendered rows, so Collapse All
      // folds the page before its replica queries have answered.
      return collectionsMenuGroups({
        onCollapseAll: () =>
          setCollapsedSections(new Set(COLLECTION_SECTION_KEYS)),
        onShowAll: () => setCollapsedSections(new Set()),
      });
    }
    return [];
  }, [
    destination,
    detectFacesAvailability,
    grain,
    libraryFilter,
    navigation,
    rung,
    setRung,
  ]);

  const refreshLibrary = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refresh?.();
    } finally {
      setRefreshing(false);
    }
  };

  // The pack refresh stats every pinned file, so it must not ride every timeline
  // snapshot — the engine republishes on each replica tick with the candidate
  // set almost always unchanged. Hence the signature gate.
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
      // Forgetting the signature is the recovery: the next snapshot retries
      // instead of being skipped as "already done".
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
    // Nothing to send is an answer, not a success (`nothingToBackUpMessage`).
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
              // Serial by contract: `position` derives from the rows the
              // previous write landed. Parallel writes race it.
              for (const [index, asset] of assets.entries()) {
                const albumId = String(album.collection_id);
                const position =
                  albumEntryCount(
                    entries.rows,
                    albumId,
                    (row) => row.collection_id
                  ) + index;
                // oxlint-disable-next-line no-await-in-loop
                const result = await session.write("photos", {
                  action: "add-to-album",
                  input: {
                    album_id: albumId,
                    asset_id: asset.assetId!,
                    position,
                  },
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

  // Shared `batchTrash`. Confirmation must say the device original survives.
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

  // Destination + size (#712): residual selection must not outlive a destination change.
  const selecting = selection.size > 0 && destination === "library";

  const onDestination = (key: BandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    // Clear selection synchronously — an effect keyed on `destination` is the cascading-render shape react-compiler flags (#712).
    if (key !== "library") setSelection(new Set());
    setViewOptionsOpen(false);
    // Search is a destination, not a push — the band must stay up.
    setDestination(key);
  };

  const onMoreRow = (key: PhotosMoreRowKey): void => {
    setMoreOpen(false);
    const nextRoute = resolveMoreRowRoute(key);
    navigation.navigate(nextRoute.screen, nextRoute.params);
  };

  return (
    // `colors.bg` verbatim. Explicit inset — SafeAreaView-with-edges can resolve a zero top inset in this fullScreenModal.
    <View
      style={[
        styles.safe,
        { backgroundColor: colors.bg, paddingTop: insets.top },
      ]}
    >
      {/* The vault lockup on every route (see `VaultBar`). This surface hosts
          its own band rather than a shared frame, so it mounts the bar. */}
      <VaultBar />
      {selecting ? (
        // iOS parity (#712): Select keeps the page title. Count/verbs live on the foot bar.
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
        // No ☰. The claimed band is the ONE navigation on the phone (§F/§3.1);
        // frame destinations are reached through its Home capsule, never
        // mirrored inside the app.
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            Photos
          </Text>
          <View style={styles.headerActions}>
            {/* An ANCHORED MENU, never a bottom sheet: the card hangs off the
                chip so the grid underneath never moves. One slot, two
                destination-scoped menus — see `menuGroups` above. */}
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
                  // Measured on the press, never cached: a rotation between two
                  // openings leaves a stale rectangle.
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
            {/* Scoped to the Library grid, same as `selecting` (#712): on any
                other destination this chip would populate `selection` with a
                tile the member can never see checked. */}
            {destination === "library" ? (
              <SelectChip
                testID={TEST_IDS.photos.select}
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

      {/* The first-run staged-import offer (#724). Self-contained: it reads
          nothing from this screen's state and returns null when there is
          nothing local-only left, so keep it stateless here. */}
      {accessTakeover ? null : (
        <CameraRollImportOffer
          assets={timeline.assets}
          gatewayBase={gatewayBase}
        />
      )}

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
          // The takeover (§13, P13) fills the GRID's slot only. The band below
          // stays: a refusal never takes away the way out of Photos.
          <PhotoAccessPanel
            state={grant.state}
            canAskAgain={grant.canAskAgain}
            // Withheld mid-walk: a count read then is true for a second only.
            readableCount={timeline.loading ? null : deviceReadable}
            onRequest={() => grant.request()}
          />
        ) : (
          <>
            {/* No toolbar row: tile size lives in the header chip's menu and in
                the grid's pinch (§4.2). The rung is still read here so the
                skeleton lands at the geometry that was showing. */}
            {timeline.loading ? (
              // The grid IS the loading state (§14, proto:3993-4033): skeleton
              // tiles at the rung's real geometry, so nothing reflows when the
              // bytes land. Never a message, never a spinner (§18).
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
                    ? "Camera-roll photographs remain available — reconnect to check the vault."
                    : "Camera-roll photographs appear instantly; hold any one to back it up."}
                </Text>
              </View>
            ) : visibleSections.length === 0 ? (
              // The filter emptied the grid, not the library — its own sentence,
              // never the empty-library copy above.
              <View style={styles.center}>
                <Text style={styles.emptyTitle}>No favorites yet</Text>
                <Text style={styles.bodyText}>
                  Photographs you mark as a favorite appear here.
                </Text>
              </View>
            ) : grain === "all" ? (
              <PhotoTimeline
                sections={visibleSections}
                selection={selection}
                refreshing={refreshing}
                scrollToDay={placeDay}
                onVisibleDay={setPlaceDay}
                // Room for the floating grain control, on the same condition it
                // mounts under below.
                footerInset={selecting ? 0 : GRAIN_CONTROL_SLOT}
                onRefresh={() => void refreshLibrary()}
                onSelectionChange={setSelection}
                onOpen={(asset) =>
                  navigation.navigate("PhotoLightbox", { assetId: asset.id })
                }
              />
            ) : (
              // The same sections the grid above draws, grouped into periods —
              // never a second query, or the grains could disagree.
              <PhotoGrainView
                sections={visibleSections}
                grain={grain}
                focusDay={placeDay}
                refreshing={refreshing}
                onRefresh={() => void refreshLibrary()}
                onOpenPeriod={openPeriod}
              />
            )}
          </>
        )}
        {/* PERMANENT while Library is the destination — never scroll-armed
            (`TimelineGrainControl.tsx`). These three conditions are the only
            ones it may be absent under, and none of them is a timer. */}
        {destination === "library" && !selecting && visibleSections.length ? (
          <TimelineGrainControl grain={grain} onGrain={changeGrain} />
        ) : null}
      </View>

      {/* Exactly ONE thing at the foot: the band, or the selection bar that
          replaces it (#712). The bar borrows the band's own anatomy — opaque
          `bgElev`/`lineStrong` plates, `BAND_RADIUS`, `BAND_INSET`, never glass
          or blur (`PhotosBand.tsx`) — and replaces the band rather than sitting
          in the header, because the foot is where the thumb is. */}
      {selecting ? (
        <View
          style={[
            styles.selectionBarRow,
            { paddingBottom: BAND_INSET + insets.bottom },
          ]}
        >
          {/* Add to album holds iOS' Share position because there is no OS
              share sheet to hand a multi-select out to; drawing one anyway
              would be a control that cannot keep its word. (This bar is three
              slots by design and carries no Download — the shelves' five-slot
              bar is where that verb lives, and since #883 C6 it is live.) */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add to album"
            onPress={addToAlbum}
            style={styles.selectionChip}
            testID={TEST_IDS.photos.selectionAlbum}
          >
            <Icon name="folder-plus" size={20} color={colors.text} />
          </Pressable>

          {/* The count, and only the count. */}
          <View style={styles.selectionCountPlate}>
            <Text style={styles.selectionCountText} numberOfLines={1}>
              {selectionCountLabel(selection.size)}
            </Text>
          </View>

          {/* Trash takes iOS' right-hand position; `batchTrash` is the shared
              write, never a second implementation. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Move to trash"
            onPress={trashSelection}
            style={styles.selectionChip}
            testID={TEST_IDS.photos.selectionTrash}
          >
            <Icon name="trash-2" size={20} color={colors.danger} />
          </Pressable>
        </View>
      ) : (
        <PhotosBand
          owner={bandOwner}
          current={destination}
          onSelect={onDestination}
          // `popTo`, never `navigate` (RN7 PUSHES a second Home, which above a
          // `fullScreenModal` arrives as a card sheet) and never `goBack`
          // (Photos can be entered by deep link with nothing beneath, and §3.1
          // makes the way home the one thing an app may not take away).
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
