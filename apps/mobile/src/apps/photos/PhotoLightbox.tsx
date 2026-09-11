// The viewer, on the stage.
//
// Full-bleed `--stage` in BOTH themes: focus and selection affordances must
// take their colour from `--on-stage`/`--stage-line` or they vanish here (§7).
//
// The phone's arrangement, not a reduced desktop: three floating elements at
// the stage head (no top bar), the five actions in a chip · capsule · chip row
// where a thumb is, a 58px filmstrip above it, the info rail as a 64% sheet,
// and one status line. Slideshow is a different MODE — no filmstrip, no info.
//
// IMAGE FIRST (#1011). The pager is an ABSOLUTE layer running the full window,
// and every other piece is chrome floating on top of it — so a square
// photograph is centred in 402×874 rather than squeezed into whatever a column
// of stacked bars happened to leave. It was leaving 313pt: the filmstrip's
// `ScrollView` carries `flexGrow: 1` of its own and was absorbing half the free
// height into a band of black. Nothing here may go back to stacking the
// photograph and the controls in one flex column.

import { useNetworkState } from "expo-network";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FlatList, Pressable, View, useWindowDimensions } from "react-native";
import type { ListRenderItemInfo } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SAVED_TO_MY_VAULT } from "@centraid/blueprints/apps/_shared/shared-copy";
import { readableName } from "@centraid/blueprints/apps/photos/place-map";
import { gazetteerNameFrom } from "@centraid/blueprints/apps/photos/place-phrase";
import type { NamedPlace } from "@centraid/blueprints/apps/photos/place-phrase";
import type { SharePlaceInput } from "@centraid/blueprints/apps/photos/share-place";
import {
  PHOTOS_ERROR_WRITE_NOT_SAVED,
  PHOTOS_SAVED_AS_NEW,
  photosArchiveMoved,
} from "@centraid/blueprints/apps/photos/shared-copy";
import { RETRY_ACTION } from "@centraid/client/surface-copy";

import AnchoredMenu, { useMenuAnchor } from "../../kit/components/AnchoredMenu";
import { useConfirmDestructive } from "../../kit/components/ConfirmSheet";
import Icon from "../../kit/components/Icon";
import { postStatus } from "../../kit/components/status-line";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { TEST_IDS } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
import {
  listCommonsResidents,
  retainCommonsItem,
} from "../../lib/replica/commons-transport";
import type { PhotosScreenProps } from "../../navigation";
import { buildDismissGesture } from "./lightbox-gestures";
import { MediaPage } from "./MediaPage";
import { EDITOR_TITLE, editorMeta } from "./photo-edit-model";
import { saveEditAsNewPhotograph } from "./photo-edit-save";
import type { EditPlan } from "./photo-edit-save";
import { usePhotoEntity } from "./photo-entity-reads";
import { PhotoEditor } from "./PhotoEditor";
import { PhotoFilmstrip } from "./PhotoFilmstrip";
import { PhotoInfoSheet } from "./PhotoInfoSheet";
import type { InfoChip } from "./PhotoInfoSheet";
import { styles } from "./PhotoLightbox.styles";
import { ViewerStatusLine, ViewerTopChrome } from "./PhotoLightboxChrome";
import { PhotoLightboxToolbar } from "./PhotoLightboxToolbar";
import { TRASH_KEEPS_THE_ORIGINAL } from "./photos-confirm-copy";
import { batchAddToAlbum } from "./photos-selection-writes";
import type { VaultAsset } from "./photos-selection-writes";
import PhotosChoiceSheet from "./PhotosChoiceSheet";
import type { PhotosChoice } from "./PhotosChoiceSheet";
import { PhotoShareChoice } from "./PhotoShareChoice";
import type { PhotoAsset } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
import { useScreenReader } from "./use-screen-reader";
import {
  saveToCameraRoll,
  sendCopy,
  surfaceExportFailure,
} from "./viewer-export";
import { viewerOverflowMenuGroups } from "./viewer-menu";
import {
  READ_ONLY_VAULT_REASON,
  SLIDESHOW_INTERVAL_MS,
  SLIDESHOW_TITLE,
  VIEWER_CHROME_INSET,
  captureStamp,
  originalStatus,
  resolveOriginalPlacement,
  slideshowMeta,
  viewerChromeHeight,
  viewerChromeVisible,
  viewerStatus,
  viewerTitle,
  viewerWriteRefusal,
} from "./viewer-model";

// Gesture construction lives in lightbox-gestures.ts — see the comment there
// for why the builder chains must stay outside component render bodies.

export default function PhotoLightbox({
  route,
  navigation,
}: PhotosScreenProps<"PhotoLightbox">): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // Whatever the chrome leaves — MEASURED, never guessed: a constant goes stale
  // the moment any chrome changes height and clips the photograph to a band.
  // Seeded with the window height so the first frame is never zero-sized.
  const [stageHeight, setStageHeight] = useState(height);
  const { session, scopes = [], gatewayBase } = useReplica();
  // Live: switching from wifi to cellular mid-session must gate the next photo.
  const networkType = useNetworkState().type;
  const { assets } = usePhotoTimeline();
  const collections = usePhotoEntity("collections");
  const entries = usePhotoEntity("collectionEntries");
  const places = usePhotoEntity("places");
  const faces = usePhotoEntity("faceRegions");
  const parties = usePhotoEntity("parties");
  // By asset identity, never raw index: this timeline is still loading, so
  // device pages land after mount and shift every index.
  const [currentId, setCurrentId] = useState(route.params.assetId);
  const [infoOpen, setInfoOpen] = useState(false);
  // Drawn on open (`CHROME_VISIBLE_ON_OPEN`): a photograph that arrives bare is
  // a screen with no visible way back. A tap hides it, a tap brings it back.
  const [chromeHidden, setChromeHidden] = useState(false);
  const screenReader = useScreenReader();
  const [slideshow, setSlideshow] = useState(false);
  // The place-precision sheet, not the OS share sheet: what a copy says about
  // where it was taken is decided before any bytes leave (#816).
  const [shareOpen, setShareOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // Measured on the press — see `useMenuAnchor` for why `onLayout` cannot.
  const {
    anchor: overflowAnchor,
    anchorRef: overflowAnchorRef,
    measureAnchor: measureOverflowAnchor,
  } = useMenuAnchor();
  // A MODE, never a route: local state is what stops the photograph unmounting
  // mid-edit and makes "nothing is written until Save" a lifetime property
  // rather than a navigation one (§7.4).
  const [editing, setEditing] = useState(false);
  const [editorLine, setEditorLine] = useState("");
  const [fullQualityUnlocked, setFullQualityUnlocked] = useState(false);
  // Reported up by the page owning the gesture: the status line prints the
  // live magnification, so it cannot be inferred here.
  const [zoomScale, setZoomScale] = useState(1);
  // Both are facts about ONE photograph and must restart at the next: consent
  // to spend mobile data is per photograph, and a carried-over magnification is
  // a zoom nobody asked for. Derived in render so the reset lands before paint.
  const [stateAssetId, setStateAssetId] = useState(currentId);
  if (stateAssetId !== currentId) {
    setStateAssetId(currentId);
    setFullQualityUnlocked(false);
    setZoomScale(1);
  }
  const list = useRef<FlatList<PhotoAsset>>(null);
  const index = assets.findIndex((asset) => asset.id === currentId);
  const current = index >= 0 ? assets[index] : undefined;
  // Captured the first time the target row exists, so the list never opens on
  // the wrong photo. State, not a ref: a ref written during render is not
  // guaranteed to be seen by the render that consumes it.
  const [initialIndex, setInitialIndex] = useState<number | null>(null);
  if (index >= 0 && initialIndex === null) setInitialIndex(index);
  const albumIds = new Set(
    entries.rows
      .filter((row) => row.target_id === current?.assetId)
      .map((row) => String(row.collection_id))
  );
  const tags: InfoChip[] = collections.rows
    .filter((row) => albumIds.has(String(row.collection_id)))
    .map((row) => ({
      id: String(row.collection_id),
      label: String(row.name ?? "Album"),
    }));
  const partyNames = new Map(
    parties.rows.map((row) => [
      String(row.party_id),
      String(row.display_name ?? row.name ?? "Someone"),
    ])
  );
  const people: InfoChip[] = faces.rows
    .filter((row) => row.asset_id === current?.assetId && row.party_id)
    .map((row) => ({
      id: String(row.region_id),
      label: partyNames.get(String(row.party_id)) ?? "Unnamed person",
    }));
  const currentPlace = places.rows.find(
    (row) => row.place_id === current?.placeId
  );
  // Anchors for the info sheet's relative phrase. A place labelled with its own
  // coordinate is not an anchor, and neither is one with no geography.
  const namedPlaces = useMemo<NamedPlace[]>(
    () =>
      places.rows.flatMap((row) => {
        const name = readableName(row.name == null ? null : String(row.name));
        const lat = Number(row.geo_lat);
        const lng = Number(row.geo_lng);
        if (name === null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
          return [];
        }
        return [
          {
            key: String(row.place_id),
            name,
            lat,
            lng,
            isHome: row.kind === "home",
          },
        ];
      }),
    [places.rows]
  );
  // Read once because two surfaces ask: the info sheet phrases it `"private"`,
  // the share choice `"shared"` — and never a relative rung.
  const placeGazetteer =
    gazetteerNameFrom(
      currentPlace?.address_json == null
        ? null
        : String(currentPlace.address_json)
    ) ?? undefined;
  const placeCoord = (column: "geo_lat" | "geo_lng"): number | undefined =>
    Number.isFinite(Number(currentPlace?.[column]))
      ? Number(currentPlace?.[column])
      : undefined;
  const placeRowName = currentPlace
    ? String(currentPlace.name ?? "Place")
    : undefined;
  const sharePlace: SharePlaceInput = {
    gazetteerName: placeGazetteer,
    lat: placeCoord("geo_lat"),
    lng: placeCoord("geo_lng"),
    namedPlaces,
    placeName: placeRowName,
  };
  const currentScope = scopes.find(
    (scope) => scope.vaultId === current?.sourceVaultId
  );
  const [residentAssetId, setResidentAssetId] = useState<string>();
  /** A CHOICE IS A SHEET (D4): which album, or which album's key photo. */
  const [coverPick, setCoverPick] = useState<{
    choices: readonly PhotosChoice[];
    onChoose: (id: string) => void;
    title: string;
  } | null>(null);
  const { confirmDestructive, confirmSheet } = useConfirmDestructive();
  const commonsResident = Boolean(
    current?.assetId && residentAssetId === current.assetId
  );
  useEffect(() => {
    let active = true;
    const actorVaultId = current?.sourceVaultId;
    const itemId = current?.assetId;
    if (!gatewayBase || !actorVaultId || !itemId) return;
    void listCommonsResidents(gatewayBase, actorVaultId)
      .then((items) => {
        if (active)
          setResidentAssetId(
            items.some(
              (item) =>
                item.itemType === "media.asset" && item.itemId === itemId
            )
              ? itemId
              : undefined
          );
      })
      .catch(() => {
        if (active) setResidentAssetId(undefined);
      });
    return () => {
      active = false;
    };
  }, [current?.assetId, current?.sourceVaultId, gatewayBase]);
  const openInfo = useCallback(() => setInfoOpen(true), []);
  const toggleChrome = useCallback(
    () => setChromeHidden((hidden) => !hidden),
    []
  );
  const dismiss = buildDismissGesture(navigation.goBack, openInfo);
  // Hoisted: a fresh renderer means a fresh MediaPage identity, which resets
  // the quality ladder mid-swipe.
  const renderPage = useCallback(
    ({ item }: ListRenderItemInfo<PhotoAsset>) => (
      <MediaPage
        asset={item}
        companionUri={item.liveVideoUri}
        networkType={networkType}
        onZoom={setZoomScale}
        onSingleTap={toggleChrome}
        originalRequested={fullQualityUnlocked}
        width={width}
        height={stageHeight}
      />
    ),
    [fullQualityUnlocked, networkType, stageHeight, toggleChrome, width]
  );

  useEffect(() => {
    if (!slideshow || assets.length < 2) return;
    const timer = setInterval(() => {
      setCurrentId((activeId) => {
        const activeIndex = assets.findIndex((asset) => asset.id === activeId);
        const next = (activeIndex + 1) % assets.length;
        list.current?.scrollToIndex({ index: next, animated: true });
        return assets[next]?.id ?? activeId;
      });
    }, SLIDESHOW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [assets, slideshow]);

  const goTo = useCallback(
    (nextIndex: number): void => {
      const target = assets[nextIndex];
      if (!target) return;
      list.current?.scrollToIndex({ animated: true, index: nextIndex });
      setCurrentId(target.id);
      // Navigation always brings the controls back: a member stepping through
      // photographs is never carried further into a bare screen.
      setChromeHidden(false);
    },
    [assets]
  );

  const write = async (
    action: string,
    input: Record<string, string | number>
  ): Promise<void> => {
    await writeReason(action, input);
  };

  /** Answers *why* when the vault says no: the info sheet renders that refusal
   *  beside the text the member typed. */
  const writeReason = async (
    action: string,
    input: Record<string, string | number>
  ): Promise<string | undefined> => {
    if (!session || !current)
      return "This photograph has no vault to write to.";
    const refusal = viewerWriteRefusal({
      writable: current.canWrite === true,
      hasVaultAsset: Boolean(current.sourceVaultId),
    });
    if (refusal) return refusal;
    try {
      // One open vault, so one write target (#996 wave 3). `canWrite` above
      // is still the gate — it is the row's own answer.
      const result = await session.write("photos", { action, input });
      // `false` is exactly the set the member must read about (parked or
      // rejected). Queued and in-flight are not refusals.
      const proceed = surfaceWriteOutcome(result, {
        onParked: () => navigation.navigate("Settings", { screen: "NeedsYou" }),
      });
      return proceed
        ? undefined
        : "reason" in result && typeof result.reason === "string"
          ? result.reason
          : "The vault rejected this change.";
    } catch (error) {
      surfaceWriteFailure(error, PHOTOS_ERROR_WRITE_NOT_SAVED);
      return `${PHOTOS_ERROR_WRITE_NOT_SAVED} ${RETRY_ACTION}`;
    }
  };

  const saveToMyVault = async (): Promise<void> => {
    const actorVaultId = current?.sourceVaultId;
    if (!gatewayBase || !current?.assetId || !actorVaultId || !commonsResident)
      return;
    try {
      await retainCommonsItem(gatewayBase, {
        actorVaultId,
        itemType: "media.asset",
        itemId: current.assetId,
      });
      setResidentAssetId(undefined);
      postStatus(SAVED_TO_MY_VAULT);
    } catch (error) {
      surfaceWriteFailure(error, "Photo not saved to your vault");
    }
  };

  /**
   * The same write `batchAddToAlbum` fires, over a selection of one. The row is
   * disabled by `viewer-menu.ts` when the grant or vault row is missing, so
   * both hold by the time this runs.
   */
  const addToAlbum = (): void => {
    if (!session || !current || !current.assetId) return;
    const asset = current as VaultAsset;
    const albums = collections.rows;
    if (!albums.length) {
      navigation.navigate("PhotosLibrary");
      return;
    }
    setCoverPick({
      choices: albums.map((album) => ({
        id: String(album.collection_id),
        label: String(album.name ?? "Album"),
      })),
      onChoose: (albumId) => {
        // Count-then-append, matching `PhotoPicker.tsx`.
        const firstPosition = entries.rows.filter(
          (row) => String(row.collection_id) === albumId
        ).length;
        void batchAddToAlbum(
          session,
          [asset],
          albumId,
          firstPosition,
          surfaceWriteOutcome
        ).catch((error: unknown) =>
          surfaceWriteFailure(error, "Photo not added")
        );
      },
      title: "Add to album",
    });
  };

  /**
   * The same `set-album-cover` write `AlbumDetail.tsx` fires (#721). `tags`
   * already IS this photograph's album membership, so it doubles as
   * `viewer-menu.ts`'s `albums` input.
   */
  const makeKeyPhoto = (): void => {
    if (!session || !current?.assetId || !current.contentId) return;
    const setCoverFor = (albumId: string): void => {
      const album = collections.rows.find(
        (row) => String(row.collection_id) === albumId
      );
      if (!album) return;
      void session
        .write("photos", {
          action: "set-album-cover",
          input: { album_id: albumId, asset_id: current.assetId! },
        })
        .then(surfaceWriteOutcome)
        .catch((error: unknown) =>
          surfaceWriteFailure(error, "Album cover not changed")
        );
    };
    if (tags.length === 1) {
      setCoverFor(tags[0]!.id);
      return;
    }
    setCoverPick({
      choices: tags.map((tag) => ({ id: tag.id, label: tag.label })),
      onChoose: setCoverFor,
      title: "Make key photo",
    });
  };

  /**
   * The favorite heart's `update-asset` write, aimed at `archived`. The
   * optimistic upsert must mirror `archived_at` — the column `media.update_asset`
   * actually writes — not a boolean. Hiding moves the photograph to the archived
   * shelf, never off the device, and the status line says so.
   */
  const hideAsset = (): void => {
    if (!current?.assetId) return;
    const hiding = !current.archived;
    void writeReason("update-asset", {
      asset_id: current.assetId,
      archived: hiding ? 1 : 0,
    }).then((reason) => {
      if (reason) return;
      postStatus(photosArchiveMoved(hiding));
    });
  };

  // The CONFIRM is where the safety is, and it is the toolbar's wording
  // verbatim: two doors onto one destructive act must not describe it twice.
  const trashAsset = (): void => {
    if (!current?.assetId) return;
    const assetId = current.assetId;
    confirmDestructive({
      body: TRASH_KEEPS_THE_ORIGINAL,
      noun: "photograph",
      onConfirm: () => void writeReason("delete-asset", { asset_id: assetId }),
      verb: "Trash",
    });
  };

  /**
   * The editor's ONE write, reporting the same sentence the web editor gives.
   * Failures are re-thrown, not swallowed: the editor is still on screen and
   * states the reason beside its commit, where the member is looking.
   */
  const saveEdit = async (plan: EditPlan): Promise<void> => {
    if (!current) throw new Error("the photograph left the timeline");
    if (!session || !gatewayBase)
      throw new Error("this device is not paired with a gateway");
    await saveEditAsNewPhotograph({ gatewayBase, session }, current, plan);
    setEditing(false);
    postStatus(PHOTOS_SAVED_AS_NEW);
  };

  // Hold on the stage rather than opening index 0 (the wrong photo). Once
  // loaded without a match the asset is genuinely gone, so this stands in.
  if (!current || initialIndex === null)
    return <View style={[styles.fill, { backgroundColor: colors.stage }]} />;

  const gatewayName = gatewayBase
    ? new URL(gatewayBase).hostname
    : "your gateway";
  const bytes = originalStatus(
    resolveOriginalPlacement({
      hasDeviceOriginal: Boolean(current.localId ?? current.localIds?.length),
      networkType,
      offloaded: current.backupState === "remote-only",
      unlocked: fullQualityUnlocked,
    }),
    gatewayName
  );
  // The bytes do not automatically win: a magnified photograph and an untaught
  // gesture both outrank a fact with nothing to do about it.
  const status = viewerStatus({
    bytes,
    kind: current.kind,
    scale: zoomScale,
  });
  // The stamp says WHEN, then at what time and where (§7.1). The position index
  // is NOT here — it is a fact about the list, and belongs to slideshow's meta
  // line alone. The NAME is still computed: it is the accessible name, and the
  // visible first line when there is no capture time. A place prints only when
  // a person would recognise it, never as coordinates.
  const placeName =
    readableName(currentPlace ? String(currentPlace.name ?? "") : null) ??
    undefined;
  const photographName = viewerTitle({
    caption: current.filename,
    filename: current.filename,
  });
  const stamp = captureStamp({ capturedAt: current.capturedAt, placeName });
  const stampTitle = editing
    ? EDITOR_TITLE
    : slideshow
      ? SLIDESHOW_TITLE
      : stamp.date || photographName;
  const stampMeta = editing
    ? editorMeta(current.capturedAt)
    : slideshow
      ? slideshowMeta(index, assets.length)
      : stamp.time;
  // The one answer to "is the chrome on the stage" — never a bare `!hidden`,
  // because the screen-reader and mode guards live with the rule (§15).
  const chromeVisible = viewerChromeVisible({
    hidden: chromeHidden,
    mode: editing ? "editor" : slideshow ? "slideshow" : "viewer",
    screenReader,
  });
  // Here, not in the editor: the vault grant and the gateway are this screen's
  // facts.
  const editRefusal =
    current.canWrite === true
      ? session && gatewayBase
        ? undefined
        : "This device is not paired with a gateway, so a new photograph cannot be written."
      : READ_ONLY_VAULT_REASON;

  return (
    <GestureDetector gesture={dismiss}>
      {/* A plain View, NOT a SafeAreaView: the stage is full-bleed and must run
          edge to edge, which a SafeAreaView would letterbox. The CONTROLS carry
          the insets instead. */}
      <View
        style={[styles.fill, { backgroundColor: colors.stage }]}
        testID={TEST_IDS.photos.viewer}
      >
        {/* The editor takes the whole body — no pager, no swipe target, no
            filmstrip: a member mid-edit is never one gesture from a different
            photograph. It is also the ONE body pushed clear of the floating
            chrome, because its own controls sit at the top of it. */}
        {editing ? (
          <View style={styles.fill}>
            <View style={{ height: viewerChromeHeight(insets.top) }} />
            <PhotoEditor
              asset={current}
              onCancel={() => setEditing(false)}
              onSave={saveEdit}
              onStatus={setEditorLine}
              saveDisabledReason={editRefusal}
              width={width}
            />
          </View>
        ) : (
          <View
            style={styles.stageLayer}
            onLayout={(event) =>
              setStageHeight(event.nativeEvent.layout.height)
            }
          >
            {/* THE SWIPE TARGET. `flows/photos-viewer.mjs` paged this list with
                `start: "80%,30%"` because it had no handle; a Maestro `swipe`
                anchored on `from: { id }` survives every layout change. */}
            <FlatList
              testID={TEST_IDS.photos.viewerPager}
              ref={list}
              data={assets}
              horizontal
              pagingEnabled
              initialScrollIndex={initialIndex}
              getItemLayout={(_, itemIndex) => ({
                length: width,
                offset: width * itemIndex,
                index: itemIndex,
              })}
              keyExtractor={(asset) => asset.id}
              onMomentumScrollEnd={(event) => {
                const nextIndex = Math.round(
                  event.nativeEvent.contentOffset.x / width
                );
                setCurrentId((activeId) => assets[nextIndex]?.id ?? activeId);
                // A swipe is navigation too: the controls come back with the
                // next photograph.
                setChromeHidden(false);
              }}
              renderItem={renderPage}
              showsHorizontalScrollIndicator={false}
            />
            {/* Start and end, so they mirror under RTL. The pointer
                equivalents of the swipe (§15) — they go away with the rest of
                the chrome, and one tap on the photograph brings them back. */}
            {chromeVisible ? (
              <>
                <Pressable
                  accessibilityLabel="Previous photograph"
                  accessibilityRole="button"
                  testID={TEST_IDS.photos.viewerPrev}
                  accessibilityState={{ disabled: index <= 0 }}
                  disabled={index <= 0}
                  onPress={() => goTo(index - 1)}
                  style={[
                    styles.pager,
                    styles.pagerPrev,
                    { borderColor: colors.stageLine },
                  ]}
                >
                  <Icon
                    name="chevron-left"
                    size={20}
                    // `--on-stage-soft`, like every other disabled control on
                    // the stage: page-ramp `textDisabled` vanishes here, so the
                    // circle would read as absent rather than as refused.
                    color={index <= 0 ? colors.onStageSoft : colors.onStage}
                  />
                </Pressable>
                <Pressable
                  accessibilityLabel="Next photograph"
                  accessibilityRole="button"
                  testID={TEST_IDS.photos.viewerNext}
                  accessibilityState={{ disabled: index >= assets.length - 1 }}
                  disabled={index >= assets.length - 1}
                  onPress={() => goTo(index + 1)}
                  style={[
                    styles.pager,
                    styles.pagerNext,
                    { borderColor: colors.stageLine },
                  ]}
                >
                  <Icon
                    name="chevron-right"
                    size={20}
                    color={
                      index >= assets.length - 1
                        ? colors.onStageSoft
                        : colors.onStage
                    }
                  />
                </Pressable>
              </>
            ) : null}
          </View>
        )}

        {/* THE FOOT OF THE STAGE — one overlay, `box-none`, so the whole
            window under it is still the photograph's to receive. */}
        <View
          pointerEvents="box-none"
          style={[
            styles.chromeBottom,
            { paddingBottom: insets.bottom + VIEWER_CHROME_INSET },
          ]}
        >
          {/* The line goes away with the rest of the chrome — it is a plate on
              the photograph, not a band under it. */}
          {chromeVisible ? (
            <ViewerStatusLine
              colors={colors}
              text={
                editing
                  ? editorLine
                  : slideshow
                    ? "Leaving the slideshow keeps the photograph you stopped on"
                    : status.text
              }
              actionLabel={
                !slideshow && !editing && status.action ? status.action : null
              }
              onAction={() => setFullQualityUnlocked(true)}
            />
          ) : null}

          {/* The filmstrip sits DIRECTLY above the action row, both floating on
              the photograph; the home-indicator inset is the overlay's, so it
              lands under whichever control is last in each mode. */}
          {chromeVisible && !slideshow && !editing ? (
            <>
              <PhotoFilmstrip
                assets={assets}
                currentId={currentId}
                onSelect={(assetId) =>
                  goTo(assets.findIndex((asset) => asset.id === assetId))
                }
              />
              <PhotoLightboxToolbar
                asset={current}
                onEdit={() => setEditing(true)}
                onInfo={openInfo}
                {...(commonsResident
                  ? { onSaveToMyVault: () => void saveToMyVault() }
                  : {})}
                onWrite={write}
              />
            </>
          ) : null}
        </View>

        {/* LAST in the tree: paint order is what puts these on the stage, and
            `zIndex` alone is not enough on every Android surface. */}
        {chromeVisible ? (
          <ViewerTopChrome
            colors={colors}
            insets={insets}
            title={stampTitle}
            meta={stampMeta}
            name={photographName}
            editing={editing}
            slideshow={slideshow}
            onClose={() => navigation.goBack()}
            onLeaveSlideshow={() => setSlideshow(false)}
            onOverflow={() => {
              // Never cached: a rotation between openings would hang the card off
              // a stale rectangle.
              measureOverflowAnchor();
              setOverflowOpen(true);
            }}
            overflowRef={overflowAnchorRef}
          />
        ) : null}

        <PhotoInfoSheet
          asset={current}
          fullQualityUnlocked={fullQualityUnlocked}
          gatewayName={gatewayName}
          networkType={networkType}
          onAddTag={(label) =>
            writeReason("tag-asset", { asset_id: current.assetId!, label })
          }
          onCaption={(caption) =>
            writeReason("update-asset", {
              asset_id: current.assetId!,
              title: caption,
            })
          }
          onClose={() => setInfoOpen(false)}
          onRemovePlace={() =>
            void writeReason("set-place", { asset_id: current.assetId! })
          }
          namedPlaces={namedPlaces}
          people={people}
          // Rung 2 of the phrase ladder, present only once the opt-in
          // automation has run; absent, the phrase falls to the relative rung.
          placeGazetteer={placeGazetteer}
          placeLat={sharePlace.lat ?? undefined}
          placeLng={sharePlace.lng ?? undefined}
          placeName={placeRowName}
          placeSetByYou={currentPlace?.source === "member"}
          screenHeight={height}
          tags={tags}
          vaultPersonal={currentScope?.personal}
          vaultLabel={currentScope?.label ?? "This vault"}
          visible={infoOpen}
        />

        <AnchoredMenu
          visible={overflowOpen}
          anchor={overflowAnchor}
          groups={viewerOverflowMenuGroups({
            albums: tags,
            archived: current.archived,
            hasVaultAsset: Boolean(current.assetId),
            writable: current.canWrite === true,
            onAddToAlbum: addToAlbum,
            onAdjustLocation: openInfo,
            onDelete: trashAsset,
            onDownload: () =>
              void saveToCameraRoll(current).catch(surfaceExportFailure),
            onHide: hideAsset,
            onMakeKeyPhoto: makeKeyPhoto,
            // Sending asks first — see the sheet at the foot of this tree.
            onSendCopy: () => setShareOpen(true),
            onSlideshow: () => setSlideshow(true),
          })}
          onClose={() => setOverflowOpen(false)}
        />

        {/* Asked once per share, BEFORE any bytes leave. */}
        <PhotoShareChoice
          visible={shareOpen}
          place={sharePlace}
          onChoose={(precision) =>
            void sendCopy(current, precision, sharePlace).catch(
              surfaceExportFailure
            )
          }
          onClose={() => setShareOpen(false)}
        />

        <PhotosChoiceSheet
          choices={coverPick?.choices ?? []}
          onChoose={(id: string) => coverPick?.onChoose(id)}
          onClose={() => setCoverPick(null)}
          subject={photographName}
          title={coverPick?.title ?? ""}
          visible={coverPick !== null}
        />
        {confirmSheet}
      </View>
    </GestureDetector>
  );
}
