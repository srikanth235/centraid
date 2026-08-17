// The viewer, on the stage.
// governance: allow-repo-hygiene file-size-limit The #712 viewer coordinates one gesture/chrome state machine and is tracked as a single handoff surface.
//
// The stage is full-bleed `--stage` in BOTH themes with `--on-stage` ink and
// `--stage-line` hairlines; it covers the entire screen. Focus and selection
// affordances take their colour from those tokens rather than inheriting, or
// they vanish here (§7).
//
// The phone's arrangement, not a reduced desktop: THREE FLOATING ELEMENTS at the
// head of the stage (back chip, capture stamp, overflow chip — the top BAR is
// gone, see `PhotoLightboxChrome`), the five actions moved to a chip · capsule ·
// chip row where a thumb is, the filmstrip kept at 58px directly above that row,
// the info rail turned into a 64% sheet, and one status line inside the stage
// saying what is true about the bytes. Slideshow is a *different mode* — no
// filmstrip, no info, determinate position.

import * as MediaLibrary from "expo-media-library";
import { useNetworkState } from "expo-network";
import * as Sharing from "expo-sharing";
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
  Share,
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
import { PHOTOS_SAVED_AS_NEW } from "@centraid/blueprints/apps/photos/shared-copy";

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
import { useTheme } from "../../kit/theme";
import {
  listCommonsResidents,
  retainCommonsItem,
} from "../../lib/replica/placement-transport";
import type { PhotosScreenProps } from "../../navigation";
import { InCloudOriginalError } from "./device-media";
import { buildDismissGesture } from "./lightbox-gestures";
import { MediaPage } from "./MediaPage";
import { EDITOR_TITLE, editorMeta } from "./photo-edit-model";
import {
  resolveLocalOriginal,
  saveEditAsNewPhotograph,
} from "./photo-edit-save";
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
import type { PhotoAsset } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
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

// Gesture construction lives in lightbox-gestures.ts — see the comment there
// for why the builder chains must stay outside component render bodies.

export default function PhotoLightbox({
  route,
  navigation,
}: PhotosScreenProps<"PhotoLightbox">): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  // The stage is whatever the chrome leaves — MEASURED, never guessed. It used
  // to be `height - 200`, a magic number standing in for the top bar, status
  // line, filmstrip and toolbar; the moment any of those changed height (safe-
  // area insets, a two-line status) the page was laid out taller than its slot
  // and the photograph was clipped to a band instead of fitted. Seeded with the
  // window height so the first frame is never zero-sized.
  const [stageHeight, setStageHeight] = useState(height);
  const { session, scopes = [], gatewayBase } = useReplica();
  // Live: switching from wifi to cellular mid-session must gate the next photo.
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
  // Page by asset identity, never by raw index: this timeline is the shared,
  // still-loading instance, so device pages land after mount and shift every
  // index. `assetId` here is the timeline row id (route param).
  const [currentId, setCurrentId] = useState(route.params.assetId);
  const [infoOpen, setInfoOpen] = useState(false);
  const [slideshow, setSlideshow] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  // The `···` chip's own rectangle, measured on the press that opens the
  // menu — see `useMenuAnchor` for why `onLayout` cannot answer this instead.
  const {
    anchor: overflowAnchor,
    anchorRef: overflowAnchorRef,
    measureAnchor: measureOverflowAnchor,
  } = useMenuAnchor();
  // The editor is a MODE of this screen, never a route: keeping it in local
  // state is what stops the photograph unmounting mid-edit, and what makes
  // "nothing is written until Save" a property of one component's lifetime
  // rather than of navigation (§7.4).
  const [editing, setEditing] = useState(false);
  const [editorLine, setEditorLine] = useState("");
  const [fullQualityUnlocked, setFullQualityUnlocked] = useState(false);
  // What the stage is magnified to, reported up by the page that owns the
  // gesture — the status line has to say `240% · drag to pan · double tap
  // returns to fit` while it is zoomed, and the number has to be the live one.
  const [zoomScale, setZoomScale] = useState(1);
  // Both of those are facts about ONE photograph, so both start again at the
  // next one: consent to spend mobile data is per photograph (that is the
  // whole of the gate's promise), and a magnification carried onto a different
  // photograph would be a zoom the member never asked for. Derived during
  // render rather than in an effect so the reset lands before paint.
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
  // The scroll offset the list must open at, captured the first time the target
  // row actually exists in the data (so we never open on the wrong photo). Held
  // in state, not a ref: a ref read during render is not guaranteed to be seen
  // by the render that consumes it, and this value gates what the list mounts on.
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
  // The member's named places, as anchors for the info sheet's relative phrase
  // ("3.4 km NE of Home"). A place still labelled with its own coordinate is
  // not an anchor — `readableName` refuses it — and neither is one with no
  // geography to measure from.
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
  // Hoisted so paging does not hand the list a fresh renderer — and therefore a
  // fresh MediaPage identity, which would reset the quality ladder mid-swipe.
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

  /**
   * The same write, but it answers *why* when the vault says no. The info
   * sheet's rows need the reason to render a refusal beside the text the
   * member typed; the bottom bar does not, and drops it.
   */
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
      // `surfaceWriteOutcome` returns whether the caller may carry on — false
      // is exactly the set of outcomes the member has to read about (parked or
      // rejected), which is what the sheet's refusal panel is for. Queued and
      // in-flight are not refusals: the sentence is on its way, not lost.
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
    postStatus(
      result.status === "executed"
        ? kind === "move"
          ? "Placement complete — the target copy committed before the source was removed."
          : "Placement complete — the photo is now available in both vaults."
        : "Placement queued — it will resume when the gateway is reachable."
    );
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
   * The overflow menu's "Add to Album" — the same write the grid's selection
   * bar fires (`batchAddToAlbum`, `photos-selection-writes.ts`), aimed at a
   * selection of exactly this one photograph. The album CHOICE is a plain
   * `Alert.alert`, the same idiom `PhotosHome.tsx`'s own "Add to album" uses
   * (see that file for the pattern this parallels — it is not shared code,
   * since that file belongs to another pass right now, but it is the same
   * write and the same picker idiom). The menu row itself is disabled before
   * this ever runs when the grant or the vault row is missing — see
   * `viewer-menu.ts` — so by the time this fires, both are known to hold.
   */
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
          // The new entry lands after the album's existing ones, matching
          // `PhotoPicker.tsx`'s own count-then-append.
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

  /**
   * The overflow menu's "Make key photo" (issue #721 B5) — the same
   * `set-album-cover` write `AlbumDetail.tsx`'s selection-bar "Make cover"
   * fires, reached here without leaving the viewer. `tags` (built above for
   * the info sheet's Albums chips) already IS this photograph's album
   * membership, so it doubles as `viewer-menu.ts`'s `albums` input — the row
   * only renders when it is non-empty (see that module's header for why).
   * One album fires directly; more than one asks which, the same `Alert.alert`
   * idiom `addToAlbum` above already uses for the same kind of choice.
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
    Alert.alert("Make key photo", photographName, [
      ...tags.map((tag) => ({
        text: tag.label,
        onPress: () => setCoverFor(tag.id),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  /**
   * The overflow menu's Hide / Unhide — the same `update-asset` write the
   * toolbar's favorite heart fires, aimed at `archived` instead. The row is
   * disabled before this ever runs when the grant or the vault row is
   * missing (`viewer-menu.ts`), so both are known to hold by the time this
   * fires. `archived_at` is what the vault command actually writes
   * (`media.update_asset`, `packages/vault/src/commands/media.ts`), so the
   * optimistic upsert mirrors that column rather than a boolean, the same
   * discipline `PhotoLightboxToolbar.tsx`'s favorite write uses for
   * `favorite`. The status line says where the photograph went: hiding pulls
   * it out of `PhotosHome.tsx`'s sectioned grid (`sectionPhotoAssets` filters
   * `archived` rows) onto the "Open archived photos" shelf
   * (`PhotosLibrary.tsx`), never off the device.
   */
  const hideAsset = (): void => {
    if (!current?.assetId) return;
    const hiding = !current.archived;
    void writeReason("update-asset", {
      asset_id: current.assetId,
      archived: hiding ? 1 : 0,
    }).then((reason) => {
      if (reason) return;
      postStatus(
        hiding
          ? "Moved to the archived shelf — the device original is untouched."
          : "Back in your library."
      );
    });
  };

  // The menu's Delete row (issue 712 iOS parity — see `viewer-menu.ts` on why
  // the verb now sits in the menu as well as on the toolbar's trash chip).
  // The CONFIRM is where the safety is, and it is the toolbar's own wording
  // verbatim: two doors onto one destructive act must not describe that act
  // two different ways.
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

  const exportAsset = async (save: boolean): Promise<void> => {
    if (!current) return;
    // The same resolution the editor uses (download an http original, resolve a
    // media-store id to real bytes) — sharing and editing must not disagree
    // about which bytes ARE the original.
    const uri = await resolveLocalOriginal(current);
    if (save) await MediaLibrary.Asset.create(uri);
    else if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
    else await Share.share({ url: uri });
  };

  /**
   * The editor's ONE write. It runs the render and the enqueue, closes the
   * editor, and says what happened in the status line — the same sentence the
   * web editor gives, because it is the same promise.
   *
   * Failures are re-thrown rather than swallowed: the editor is still on screen
   * and states the reason beside its commit, which is where a member who just
   * pressed Save is looking.
   */
  const saveEdit = async (plan: EditPlan): Promise<void> => {
    if (!current) throw new Error("the photograph left the timeline");
    if (!session || !gatewayBase)
      throw new Error("this device is not paired with a gateway");
    await saveEditAsNewPhotograph({ gatewayBase, session }, current, plan);
    setEditing(false);
    postStatus(PHOTOS_SAVED_AS_NEW);
  };

  /** Export never fails quietly: an iCloud-only original says exactly that. */
  const runExport = (save: boolean): void => {
    void exportAsset(save).catch((error: unknown) => {
      postStatus(
        `${error instanceof InCloudOriginalError ? "Original is in iCloud" : "Export failed"}: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  };

  // Until the shared timeline has loaded the requested row we hold on the stage
  // rather than opening index 0 (the wrong photo). Once loaded without a match
  // the asset is genuinely gone, so the same stage stands in.
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
  // What the stage's one line says, and in what order it decides — see
  // `viewerStatus`. The bytes do not automatically win here any more: a
  // magnified photograph and a phone whose gestures nothing has taught both
  // outrank a fact with nothing to do about it.
  const status = viewerStatus({
    bytes,
    kind: current.kind,
    scale: zoomScale,
  });
  // The floating stamp says WHEN the photograph was taken, then at what time and
  // where (§7.1, proto 4510–4511, restyled for #712). The position index is NOT
  // here: it is a fact about the list, and it lives only in the slideshow's meta
  // line, the one mode where "how far through" is the question. The photograph's
  // NAME is still computed — it is the stamp's accessible name, and its visible
  // first line for a photograph that carries no capture time to show instead.
  // The stamp prints a place name only when it is one a person would recognise:
  // a place still labelled with its own coordinate has nothing to say over a
  // photograph, and printing the digits there would be the worst place in the
  // app to do it.
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
  // Why the editor's commit cannot fire, if it cannot. Computed here because
  // the vault grant and the gateway are this screen's facts, not the editor's.
  const editRefusal =
    current.canWrite === true
      ? session && gatewayBase
        ? undefined
        : "This device is not paired with a gateway, so a new photograph cannot be written."
      : READ_ONLY_VAULT_REASON;

  return (
    <GestureDetector gesture={dismiss}>
      {/* A plain View, NOT a SafeAreaView: the stage is full-bleed `--stage` and
          must run under the status bar and the home indicator, edge to edge. A
          SafeAreaView would pad the container and letterbox the stage in the
          system's own background. The CONTROLS carry the insets instead — the
          bar below and the toolbar at the foot — so nothing lands under the
          clock while the ground still covers the screen. */}
      <View style={[styles.fill, { backgroundColor: colors.stage }]}>
        {/* The editor takes the whole body: no pager arrows, no swipe target,
            no filmstrip below (proto 4518, 4599, 4606). A member mid-edit is
            never one gesture away from a different photograph.

            It is also the ONE body that does not run under the floating chrome:
            the stage is a photograph and a chip standing on it obscures nothing
            that matters, but the editor's own controls live at the top of its
            body, so it is pushed clear by exactly the chrome's height. */}
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
            <FlatList
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
            {/* Prev / next: the pointer equivalents of the swipe. Start and end,
              so they mirror under RTL rather than being pinned left/right. */}
            <Pressable
              accessibilityLabel="Previous photograph"
              accessibilityRole="button"
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

        {/* Slideshow is a different mode: no filmstrip, no info, no bar. The
            home-indicator inset therefore has to land on whichever control is
            last in each mode — the toolbar here, the status line in slideshow
            (below) — or the foot of the stage sits under the indicator. */}
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

        {/* LAST in the tree, not first: the three floating elements stand ON
            the stage, and paint order is what puts them there. `zIndex` alone
            is not enough on every Android surface. */}
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
            // Measured on the press, never cached — a rotation between two
            // openings would hang the card off a stale rectangle.
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
          // Rung 2 of the phrase ladder, when the opt-in automation has run:
          // the settlement name it recorded inside this place's own
          // `address_json`. Absent — and it is absent until a member turns the
          // automation on — the sheet's phrase falls to the relative rung.
          placeGazetteer={
            gazetteerNameFrom(
              currentPlace?.address_json == null
                ? null
                : String(currentPlace.address_json)
            ) ?? undefined
          }
          placeLat={
            Number.isFinite(Number(currentPlace?.geo_lat))
              ? Number(currentPlace?.geo_lat)
              : undefined
          }
          placeLng={
            Number.isFinite(Number(currentPlace?.geo_lng))
              ? Number(currentPlace?.geo_lng)
              : undefined
          }
          placeName={
            currentPlace ? String(currentPlace.name ?? "Place") : undefined
          }
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
            onDownload: () => runExport(true),
            onHide: hideAsset,
            onMakeKeyPhoto: makeKeyPhoto,
            onSendCopy: () => runExport(false),
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
      </View>
    </GestureDetector>
  );
}
