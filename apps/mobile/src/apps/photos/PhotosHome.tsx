// Photos' home surface on the phone (v4 §3.1, §4, §14, §15). Wiring only — shaped UI lives in siblings.
//
// IT IS AN `AppPlace` NOW (#1015 Wave 2, R-B-9). It was the last Photos
// surface still drawing its own furniture: a hand-rolled header, its own
// `paddingTop: insets.top`, and — the defect that made this urgent (audit B8,
// D5) — a SECOND bar at the foot under a live band, so a tap aimed at "Trash"
// could land on a band destination and navigate away. The room now owns the
// header, the safe area, the lockup's placement and the selection mode: the
// header swaps in place to "N photographs selected · Cancel", the band is
// dimmed through leaf tokens and stops answering, and the verbs live in the
// room's ONE action row.
//
// What stays this screen's own: the destination state (Photos' band switches
// a destination in place rather than pushing, so the band is wired here and
// not through `PhotosScreen`), the anchored view-options menu, and the writes.

import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";

import { useBandOwner } from "../../kit/band/band-owner";
import AnchoredMenu, { useMenuAnchor } from "../../kit/components/AnchoredMenu";
import { useConfirmDestructive } from "../../kit/components/ConfirmSheet";
import { Text } from "../../kit/components/NativeText";
import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStateCard from "../../kit/replica/ReplicaStateCard";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { AppPlace } from "../../kit/rooms";
import type { BandState, RoomAction, RoomSelection } from "../../kit/rooms";
import { TEST_IDS } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
import { hydrateBackupConsent } from "../../kit/transfer/transfer-consent";
import type { BackupConsentRecord } from "../../kit/transfer/transfer-consent";
import { backupDeviceMedia } from "../../lib/upload/media-producer";
import type { PhotosScreenProps } from "../../navigation";
import VaultBar from "../../screens/home/VaultBar";
import CameraRollImportOffer from "./CameraRollImportOffer";
import { detectFacesFor } from "./people-model";
import { photoAccessTakesOverTimeline } from "./photo-access";
import { usePhotoEntity } from "./photo-entity-reads";
import PhotoAccessPanel, { usePhotoAccessGrant } from "./PhotoAccessPanel";
import { runBackup, useAutomaticPhotoBackup } from "./photos-backup";
import { inCloudMessage, nothingToBackUpMessage } from "./photos-backup-copy";
import { resolveMoreRowRoute } from "./photos-band";
import type { BandDestinationKey, PhotosMoreRowKey } from "./photos-band";
import { COLLECTION_SECTION_KEYS } from "./photos-collections";
import type { CollectionSectionKey } from "./photos-collections";
import { collectionsMenuGroups } from "./photos-collections-menu";
import { TRASH_KEEPS_THE_ORIGINAL } from "./photos-confirm-copy";
import {
  useOnThisDayNotice,
  usePinnedThumbnailPack,
} from "./photos-home-effects";
import { libraryMenuGroups } from "./photos-library-menu";
import type { LibraryFilter } from "./photos-library-menu";
import { PHOTOS_META } from "./photos-meta";
import { usePhotosRung } from "./photos-rung-store";
import { batchTrash, vaultAssets } from "./photos-selection-writes";
import PhotosBand from "./PhotosBand";
import PhotosChoiceSheet from "./PhotosChoiceSheet";
import PhotosCollectionsView from "./PhotosCollectionsView";
import { makeStyles } from "./PhotosHome.styles";
import PhotosLibraryBody from "./PhotosLibraryBody";
import PhotosMoreSheet from "./PhotosMoreSheet";
import { PhotosSearchView } from "./PhotosSearch";
import { anchorForGrain } from "./timeline-grains";
import type { GrainPeriod, TimelineGrain } from "./timeline-grains";
import type { PhotoSection } from "./timeline-model";
import { onThisDay } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
import TimelineGrainControl from "./TimelineGrainControl";

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
  // All / Collapse all must drive the same set the chevrons toggle, or the two
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

  const collections = usePhotoEntity("collections");
  const entries = usePhotoEntity("collectionEntries");
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
  // `detectFacesFor` is the gateway question — the rung the sweep runs on.
  const enrichPolicies = usePhotoEntity("enrichPolicies");
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
          // The People roster's empty state holds the priority ask; never
          // the enrichment write — see `photos-library-menu.ts`'s header.
          onDetectFaces: () => navigation.navigate("PhotosPeople"),
        },
      });
    }
    if (destination === "collections") {
      // Over the full fixed key set, not the rendered rows, so Collapse all
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

  usePinnedThumbnailPack(gatewayBase, timeline.assets);
  useOnThisDayNotice(memories);

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

  const [pickingAlbum, setPickingAlbum] = useState(false);
  const { confirmDestructive, confirmSheet } = useConfirmDestructive();

  // The whole list, not the six an alert would fit: this is a sheet (D4).
  const albumChoices = collections.rows.map((album) => ({
    id: String(album.collection_id),
    label: String(album.name ?? "Album"),
  }));

  const addToAlbum = (): void => {
    if (!albumChoices.length) {
      navigation.navigate("PhotosLibrary");
      return;
    }
    setPickingAlbum(true);
  };

  const addSelectionToAlbum = (albumId: string): void =>
    void (async () => {
      if (!session) return;
      const assets = timeline.assets.filter(
        (item) => selection.has(item.id) && item.assetId
      );
      try {
        // Serial by contract: `position` derives from the rows the previous
        // write landed. Parallel writes race it.
        for (const [index, asset] of assets.entries()) {
          const position =
            albumEntryCount(entries.rows, albumId, (row) => row.collection_id) +
            index;
          // oxlint-disable-next-line no-await-in-loop
          const result = await session.write("photos", {
            action: "add-to-album",
            input: { album_id: albumId, asset_id: asset.assetId!, position },
          });
          surfaceWriteOutcome(result);
        }
        setSelection(new Set());
      } catch (error) {
        surfaceWriteFailure(error, "Photos not added");
      }
    })();

  // Shared `batchTrash`. Confirmation must say the device original survives.
  const trashSelection = (): void => {
    if (!session) return;
    const targets = vaultAssets(timeline.assets, selection);
    confirmDestructive({
      body: TRASH_KEEPS_THE_ORIGINAL,
      count: selection.size,
      noun: "photograph",
      onConfirm: () => {
        void batchTrash(session, targets, surfaceWriteOutcome)
          .then(() => setSelection(new Set()))
          .catch((error: unknown) =>
            surfaceWriteFailure(error, "Photos not trashed")
          );
      },
      verb: "Trash",
    });
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

  // AN ANCHORED MENU, never a bottom sheet: the card hangs off the header's
  // own node (`trailingRef`) so the grid underneath never moves. One slot, two
  // destination-scoped menus — see `menuGroups` above; Search has no honest
  // menu, so on that destination the room's quiet verb is simply absent.
  const viewOptions: RoomAction | undefined =
    destination === "library" || destination === "collections"
      ? {
          label:
            destination === "library" ? "View options" : "Collections options",
          onPress: () => {
            // Measured on the press, never cached: a rotation between two
            // openings leaves a stale rectangle.
            measureAnchor();
            setViewOptionsOpen(true);
          },
        }
      : undefined;

  // Scoped to the Library grid, same as `selecting` (#712): on any other
  // destination this would populate `selection` with a tile the member can
  // never see checked.
  const select: RoomAction | undefined =
    destination === "library"
      ? {
          disabled: timeline.assets.length === 0,
          label: "Select",
          onPress: () => {
            const first = timeline.assets[0];
            if (first) setSelection(new Set([first.id]));
          },
          testID: TEST_IDS.photos.select,
        }
      : undefined;

  // ONE action row at the foot, and the header swapped in place above it — the
  // room's shape, not a second bar under a live band (D5). "Back up" moves
  // here off the old header: it is a verb on the selection, like the other two.
  const room: RoomSelection | undefined = selecting
    ? {
        actions: [
          {
            label: "Add to album",
            onPress: addToAlbum,
            testID: TEST_IDS.photos.selectionAlbum,
          },
          {
            disabled: backingUp,
            label: "Back up",
            onPress: () => void backupSelection(),
          },
          {
            dangerous: true,
            label: "Trash",
            onPress: trashSelection,
            testID: TEST_IDS.photos.selectionTrash,
          },
        ],
        count: selection.size,
        noun: "photograph",
        onCancel: () => setSelection(new Set()),
      }
    : undefined;

  const band = (state: BandState): React.JSX.Element => (
    <PhotosBand
      owner={bandOwner}
      destination={destination}
      dimmed={state.dimmed}
      interactive={state.interactive}
      onSelect={onDestination}
      // `popTo`, never `navigate` (RN7 PUSHES a second Home, which above a
      // `fullScreenModal` arrives as a card sheet) and never `goBack`
      // (Photos can be entered by deep link with nothing beneath, and §3.1
      // makes the way home the one thing an app may not take away).
      onHome={() => navigation.popTo("Home")}
    />
  );

  return (
    <AppPlace
      action={select}
      app={{
        color: PHOTOS_META.color,
        iconKey: PHOTOS_META.iconKey,
        title: "Photos",
      }}
      band={band}
      // The vault lockup on every route (see `VaultBar`), inside the room's
      // safe area — the app no longer draws an inset of its own.
      lockup={<VaultBar />}
      onBack={() => navigation.popTo("Home")}
      secondary={viewOptions}
      selection={room}
      trailingRef={menuAnchorRef}
    >
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
          <PhotosLibraryBody
            grain={grain}
            loading={timeline.loading}
            offline={collections.connection === "offline"}
            onOpen={(asset) =>
              navigation.navigate("PhotoLightbox", { assetId: asset.id })
            }
            onOpenPeriod={openPeriod}
            onPlaceDay={setPlaceDay}
            onRefresh={() => void refreshLibrary()}
            onSelectionChange={setSelection}
            placeDay={placeDay}
            refreshing={refreshing}
            rung={rung}
            sections={timeline.sections}
            selecting={selecting}
            selection={selection}
            styles={styles}
            visibleSections={visibleSections}
          />
        )}
        {/* PERMANENT while Library is the destination — never scroll-armed
            (`TimelineGrainControl.tsx`). These three conditions are the only
            ones it may be absent under, and none of them is a timer. */}
        {destination === "library" && !selecting && visibleSections.length ? (
          <TimelineGrainControl grain={grain} onGrain={changeGrain} />
        ) : null}
      </View>

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

      {/* A choice is a sheet and a confirm is a sheet (D4, S7); neither is an
          alert with rows in it. */}
      <PhotosChoiceSheet
        choices={albumChoices}
        onChoose={addSelectionToAlbum}
        onClose={() => setPickingAlbum(false)}
        subject={`${selection.size} selected`}
        title="Add to album"
        visible={pickingAlbum}
      />
      {confirmSheet}
    </AppPlace>
  );
}
