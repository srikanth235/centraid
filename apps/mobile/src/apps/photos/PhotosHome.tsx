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
  const {
    anchor: menuAnchorRect,
    anchorRef: menuAnchorRef,
    measureAnchor,
  } = useMenuAnchor();
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [grain, setGrain] = useState<TimelineGrain>("all");
  const [placeDay, setPlaceDay] = useState<string | undefined>(undefined);
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
  const { bandOwner } = useBandOwner("photos");

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
  const visibleSections = useMemo(
    () => filterSections(timeline.sections, libraryFilter),
    [timeline.sections, libraryFilter]
  );
  const changeGrain = useCallback(
    (next: TimelineGrain): void => {
      setPlaceDay((current) => anchorForGrain(visibleSections, next, current));
      setGrain(next);
    },
    [visibleSections]
  );
  useEffect(() => {
    if (destination === "library") return;
    queueMicrotask(() => {
      setGrain("all");
      setPlaceDay(undefined);
    });
  }, [destination]);
  const openPeriod = useCallback((period: GrainPeriod): void => {
    setPlaceDay(period.anchorDay);
    setGrain((current) => (current === "years" ? "months" : "all"));
  }, []);
  const enrichPolicies = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "enrich.policy" }), [])
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
          onDetectFaces: () => navigation.navigate("PhotosPeople"),
        },
      });
    }
    if (destination === "collections") {
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

  const selecting = selection.size > 0 && destination === "library";

  const onDestination = (key: BandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    if (key !== "library") setSelection(new Set());
    setViewOptionsOpen(false);
    setDestination(key);
  };

  const onMoreRow = (key: PhotosMoreRowKey): void => {
    setMoreOpen(false);
    const nextRoute = resolveMoreRowRoute(key);
    navigation.navigate(nextRoute.screen, nextRoute.params);
  };

  return (
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
          <PhotoAccessPanel
            state={grant.state}
            canAskAgain={grant.canAskAgain}
            readableCount={timeline.loading ? null : deviceReadable}
            onRequest={() => grant.request()}
          />
        ) : (
          <>
            {/* No toolbar row: tile size lives in the header chip's menu and in
                the grid's pinch (§4.2). The rung is still read here so the
                skeleton lands at the geometry that was showing. */}
            {timeline.loading ? (
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
                footerInset={selecting ? 0 : GRAIN_CONTROL_SLOT}
                onRefresh={() => void refreshLibrary()}
                onSelectionChange={setSelection}
                onOpen={(asset) =>
                  navigation.navigate("PhotoLightbox", { assetId: asset.id })
                }
              />
            ) : (
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
