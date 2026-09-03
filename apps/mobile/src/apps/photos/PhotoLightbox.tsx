// governance: allow-repo-hygiene file-size-limit The #712 viewer coordinates one gesture/chrome state machine and is tracked as a single handoff surface.

import { useNetworkState } from "expo-network";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  FlatList,
  Pressable,
  View,
  useWindowDimensions,
} from "react-native";
import type { ListRenderItemInfo } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SAVED_TO_MY_VAULT } from "@centraid/blueprints/apps/_shared/shared-copy";
import { readableName } from "@centraid/blueprints/apps/photos/place-map";
import { gazetteerNameFrom } from "@centraid/blueprints/apps/photos/place-phrase";
import type { NamedPlace } from "@centraid/blueprints/apps/photos/place-phrase";
import type { SharePlaceInput } from "@centraid/blueprints/apps/photos/share-place";
import {
  PHOTOS_SAVED_AS_NEW,
  photosArchiveMoved,
} from "@centraid/blueprints/apps/photos/shared-copy";

import AnchoredMenu, { useMenuAnchor } from "../../kit/components/AnchoredMenu";
import Icon from "../../kit/components/Icon";
import OptionSheet from "../../kit/components/OptionSheet";
import { postStatus } from "../../kit/components/status-line";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { TEST_IDS } from "../../kit/test-ids";
import { useTheme } from "../../kit/theme";
import type { PlacementRecord } from "../../lib/replica/multi-vault-reader";
import {
  listCommonsResidents,
  retainCommonsItem,
} from "../../lib/replica/placement-transport";
import type { PhotosScreenProps } from "../../navigation";
import { buildDismissGesture } from "./lightbox-gestures";
import { MediaPage } from "./MediaPage";
import { EDITOR_TITLE, editorMeta } from "./photo-edit-model";
import { saveEditAsNewPhotograph } from "./photo-edit-save";
import type { EditPlan } from "./photo-edit-save";
import { PhotoEditor } from "./PhotoEditor";
import { PhotoFilmstrip } from "./PhotoFilmstrip";
import { PhotoInfoSheet } from "./PhotoInfoSheet";
import type { InfoChip } from "./PhotoInfoSheet";
import { styles } from "./PhotoLightbox.styles";
import { ViewerStatusLine, ViewerTopChrome } from "./PhotoLightboxChrome";
import { PhotoLightboxToolbar } from "./PhotoLightboxToolbar";
import { batchAddToAlbum } from "./photos-selection-writes";
import type { VaultAsset } from "./photos-selection-writes";
import { PhotoShareChoice } from "./PhotoShareChoice";
import type { PhotoAsset } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
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
  captureStamp,
  originalStatus,
  resolveOriginalPlacement,
  slideshowMeta,
  viewerChromeHeight,
  viewerStatus,
  viewerTitle,
} from "./viewer-model";

function placementLine(
  status: PlacementRecord["status"],
  kind: "add" | "move"
): string {
  switch (status) {
    case "executed":
      return kind === "move"
        ? "Placement complete — the target copy committed before the source was removed."
        : "Placement complete — the photo is now available in both vaults.";
    case "denied":
      return "Placement denied — permission changed before it could be applied.";
    case "failed":
      return "Placement could not be applied — Pending changes has the reason.";
    case "parked":
      return "Placement needs attention — answer it in Pending changes.";
    case "in-flight":
      return "Placement is being applied right now.";
    case "queued":
      return "Placement queued — it will resume when the gateway is reachable.";
  }
}

export default function PhotoLightbox({
  route,
  navigation,
}: PhotosScreenProps<"PhotoLightbox">): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [stageHeight, setStageHeight] = useState(height);
  const { session, scopes = [], gatewayBase } = useReplica();
  const networkType = useNetworkState().type;
  const { assets } = usePhotoTimeline();
  const collections = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection" }), [])
  );
  const entries = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.collection_entry" }), [])
  );
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.place" }), [])
  );
  const faces = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.face_region" }), [])
  );
  const parties = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.party" }), [])
  );
  const [currentId, setCurrentId] = useState(route.params.assetId);
  const [infoOpen, setInfoOpen] = useState(false);
  const [slideshow, setSlideshow] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const {
    anchor: overflowAnchor,
    anchorRef: overflowAnchorRef,
    measureAnchor: measureOverflowAnchor,
  } = useMenuAnchor();
  const [editing, setEditing] = useState(false);
  const [editorLine, setEditorLine] = useState("");
  const [fullQualityUnlocked, setFullQualityUnlocked] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [stateAssetId, setStateAssetId] = useState(currentId);
  if (stateAssetId !== currentId) {
    setStateAssetId(currentId);
    setFullQualityUnlocked(false);
    setZoomScale(1);
  }
  const [placementKind, setPlacementKind] = useState<"add" | "move">();
  const list = useRef<FlatList<PhotoAsset>>(null);
  const index = assets.findIndex((asset) => asset.id === currentId);
  const current = index >= 0 ? assets[index] : undefined;
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
  const dismiss = buildDismissGesture(navigation.goBack, openInfo);
  const renderPage = useCallback(
    ({ item }: ListRenderItemInfo<PhotoAsset>) => (
      <MediaPage
        asset={item}
        companionUri={item.liveVideoUri}
        networkType={networkType}
        onZoom={setZoomScale}
        originalRequested={fullQualityUnlocked}
        width={width}
        height={stageHeight}
      />
    ),
    [fullQualityUnlocked, networkType, stageHeight, width]
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
    },
    [assets]
  );

  const write = async (
    action: string,
    input: Record<string, string | number>
  ): Promise<void> => {
    await writeReason(action, input);
  };

  const writeReason = async (
    action: string,
    input: Record<string, string | number>
  ): Promise<string | undefined> => {
    if (!session || !current)
      return "This photograph has no vault to write to.";
    if (current.canWrite !== true) return READ_ONLY_VAULT_REASON;
    const sourceVaultId = current.sourceVaultId;
    if (!sourceVaultId) return "This photograph is not in a vault yet.";
    try {
      const result = await session.writeTo(sourceVaultId, "photos", {
        action,
        input,
      });
      const proceed = surfaceWriteOutcome(result, {
        onParked: () =>
          navigation.navigate("Settings", { screen: "Approvals" }),
      });
      return proceed
        ? undefined
        : "reason" in result && typeof result.reason === "string"
          ? result.reason
          : "The vault rejected this change.";
    } catch (error) {
      surfaceWriteFailure(error, "Photo change not saved");
      return error instanceof Error ? error.message : "The write did not land.";
    }
  };

  const place = async (targetVaultId: string): Promise<void> => {
    const kind = placementKind;
    setPlacementKind(undefined);
    const sourceVaultId = current?.sourceVaultId;
    if (!session || !kind || !current?.assetId || !sourceVaultId) return;
    const result = await session.place({
      kind,
      itemType: "media.asset",
      itemId: current.assetId,
      sourceVaultId,
      targetVaultId,
    });
    postStatus(placementLine(result.status, kind));
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

  const addToAlbum = (): void => {
    if (!session || !current || !current.assetId) return;
    const asset = current as VaultAsset;
    const albums = collections.rows;
    if (!albums.length) {
      navigation.navigate("PhotosLibrary");
      return;
    }
    Alert.alert("Add to Album", photographName, [
      ...albums.map((album) => ({
        text: String(album.name ?? "Album"),
        onPress: () => {
          const albumId = String(album.collection_id);
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
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

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
    Alert.alert("Make key photo", photographName, [
      ...tags.map((tag) => ({
        text: tag.label,
        onPress: () => setCoverFor(tag.id),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

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

  const trashAsset = (): void => {
    if (!current?.assetId) return;
    const assetId = current.assetId;
    Alert.alert(
      "Move to trash?",
      "The device original is never deleted by this action.",
      [
        { text: "Cancel" },
        {
          text: "Trash",
          style: "destructive",
          onPress: () =>
            void writeReason("delete-asset", { asset_id: assetId }),
        },
      ]
    );
  };

  const saveEdit = async (plan: EditPlan): Promise<void> => {
    if (!current) throw new Error("the photograph left the timeline");
    if (!session || !gatewayBase)
      throw new Error("this device is not paired with a gateway");
    await saveEditAsNewPhotograph({ gatewayBase, session }, current, plan);
    setEditing(false);
    postStatus(PHOTOS_SAVED_AS_NEW);
  };

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
  const status = viewerStatus({
    bytes,
    kind: current.kind,
    scale: zoomScale,
  });
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
            style={styles.fill}
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
              }}
              renderItem={renderPage}
              showsHorizontalScrollIndicator={false}
            />
            {/* Start and end, so they mirror under RTL. */}
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
                color={index <= 0 ? colors.textDisabled : colors.onStage}
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
                    ? colors.textDisabled
                    : colors.onStage
                }
              />
            </Pressable>
          </View>
        )}

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

        {/* The home-indicator inset must land on whichever control is last in
            each mode, or the foot of the stage sits under the indicator. */}
        {slideshow || editing ? (
          <View style={{ height: insets.bottom }} />
        ) : (
          <>
            <PhotoFilmstrip
              assets={assets}
              currentId={currentId}
              onSelect={(assetId) =>
                goTo(assets.findIndex((asset) => asset.id === assetId))
              }
            />
            <View style={{ paddingBottom: insets.bottom }}>
              <PhotoLightboxToolbar
                asset={current}
                onEdit={() => setEditing(true)}
                onInfo={openInfo}
                onPlacement={setPlacementKind}
                {...(commonsResident
                  ? { onSaveToMyVault: () => void saveToMyVault() }
                  : {})}
                onWrite={write}
              />
            </View>
          </>
        )}

        {/* LAST in the tree: paint order is what puts these on the stage, and
            `zIndex` alone is not enough on every Android surface. */}
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
            measureOverflowAnchor();
            setOverflowOpen(true);
          }}
          overflowRef={overflowAnchorRef}
        />

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
            onSendCopy: () => setShareOpen(true),
            onSlideshow: () => setSlideshow(true),
          })}
          onClose={() => setOverflowOpen(false)}
        />

        <OptionSheet
          visible={placementKind !== undefined}
          title={`${placementKind === "move" ? "Move" : "Copy"} to…`}
          options={scopes
            .filter(
              (scope) =>
                scope.canWrite && !current.scopeIds?.includes(scope.vaultId)
            )
            .map((scope) => ({
              id: scope.vaultId,
              label: scope.label,
              detail:
                placementKind === "move"
                  ? "Target commits before source removal"
                  : "Keep in both vaults",
            }))}
          onSelect={(vaultId) => void place(vaultId)}
          onClose={() => setPlacementKind(undefined)}
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
      </View>
    </GestureDetector>
  );
}
