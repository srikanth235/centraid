// The viewer, on the stage.
// governance: allow-repo-hygiene file-size-limit #711 Photos v4 viewer surface remains a cohesive interaction module.
//
// The stage is full-bleed `--stage` in BOTH themes with `--on-stage` ink and
// `--stage-line` hairlines; it covers the entire screen. Focus and selection
// affordances take their colour from those tokens rather than inheriting, or
// they vanish here (§7).
//
// The phone's arrangement, not a reduced desktop: a 52px top bar carrying the
// exit and the overflow only, the five actions moved to a bottom bar where a
// thumb is, the filmstrip kept at 58px, the info rail turned into a 64% sheet,
// and one status line inside the stage saying what is true about the bytes.
// Slideshow is a *different mode* — no filmstrip, no info, determinate position.

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
  FlatList,
  Pressable,
  Share,
  View,
  useWindowDimensions,
} from "react-native";
import type { ListRenderItemInfo } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import OptionSheet from "../../kit/components/OptionSheet";
import { postStatus } from "../../kit/components/status-line";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import { useTheme } from "../../kit/theme";
import type { NativeOptimisticMutation } from "../../lib/replica/native-session";
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
import { PhotoLightboxToolbar } from "./PhotoLightboxToolbar";
import type { PhotoAsset } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
import {
  LOAD_THE_ORIGINAL,
  READ_ONLY_VAULT_REASON,
  SLIDESHOW_ACTION,
  SLIDESHOW_INTERVAL_MS,
  SLIDESHOW_TITLE,
  VIEWER_TOP_BAR_HEIGHT,
  captureLine,
  originalStatus,
  resolveOriginalPlacement,
  slideshowMeta,
  viewerStatus,
  viewerTitle,
} from "./viewer-model";

// Gesture construction lives in lightbox-gestures.ts — see the comment there
// for why the builder chains must stay outside component render bodies.

/** What the top bar's overflow carries — everything not in the five. */
const OVERFLOW_OPTIONS = [
  { id: "slideshow", label: "Slideshow" },
  { id: "download", label: "Download" },
  { id: "export", label: "Send a copy" },
] as const;

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
  const currentScope = scopes.find(
    (scope) => scope.vaultId === current?.sourceVaultId
  );
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
    input: Record<string, string | number>,
    optimistic?: NativeOptimisticMutation[]
  ): Promise<void> => {
    await writeReason(action, input, optimistic);
  };

  /**
   * The same write, but it answers *why* when the vault says no. The info
   * sheet's rows need the reason to render a refusal beside the text the
   * member typed; the bottom bar does not, and drops it.
   */
  const writeReason = async (
    action: string,
    input: Record<string, string | number>,
    optimistic?: NativeOptimisticMutation[]
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
        ...(optimistic ? { optimistic } : {}),
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
      itemType: "media.media_asset",
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
    postStatus("Saved as a new photograph — the original is not touched.");
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
  // The top bar says what the photograph IS, then when and where it was taken
  // (§7.1, proto 4510–4511). The position index is NOT here any more: it is a
  // fact about the list, and it now lives only in the slideshow's meta line,
  // which is the one mode where "how far through" is the question.
  const placeName = currentPlace ? String(currentPlace.name ?? "") : undefined;
  const barTitle = editing
    ? EDITOR_TITLE
    : slideshow
      ? SLIDESHOW_TITLE
      : viewerTitle({ caption: current.filename, filename: current.filename });
  const barMeta = editing
    ? editorMeta(current.capturedAt)
    : slideshow
      ? slideshowMeta(index, assets.length)
      : captureLine({ capturedAt: current.capturedAt, placeName });
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
        {/* 52px, exit and overflow only — the five actions live below. */}
        <View
          style={[
            styles.topbar,
            {
              borderBottomColor: colors.stageLine,
              height: VIEWER_TOP_BAR_HEIGHT + insets.top,
              paddingTop: insets.top,
            },
          ]}
        >
          <Pressable
            accessibilityLabel="Close photo viewer"
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => navigation.goBack()}
          >
            {/* ✕, not a chevron (proto 2601). A chevron-down describes the
                swipe-down dismissal, which still works — but the CONTROL is a
                close, and a mark that describes the gesture beside it rather
                than its own effect is a mark pointing at the wrong thing. */}
            <Icon name="x" size={26} color={colors.onStage} />
          </Pressable>
          <View style={styles.topbarTitle}>
            <Text numberOfLines={1} style={{ color: colors.onStage }}>
              {barTitle}
            </Text>
            {/* `--on-stage-soft`, never `--text-soft`: the stage is one
                colour in BOTH themes, so a token that softens against the
                page's background lands at 2.85:1 here in light mode. This is
                the token that exists to be soft ON the stage and still clear
                AA. Same for the status line below. */}
            <Text
              numberOfLines={1}
              style={[styles.topbarCapture, { color: colors.onStageSoft }]}
            >
              {barMeta}
            </Text>
          </View>
          {/* The slideshow's ONE action, LABELLED. It used to wear a pause
              glyph and exit the slideshow — a control whose mark promised one
              thing and whose press did another. Label and effect are now read
              from the same value (`SLIDESHOW_ACTION`), so they cannot drift
              apart again; the missing transport is a recorded non-goal, stated
              beside that value. The editor suppresses this slot entirely: its
              way out is `Cancel`, beside the commit it is the alternative to. */}
          {editing ? null : slideshow ? (
            <Pressable
              accessibilityLabel={SLIDESHOW_ACTION.label}
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => {
                if (SLIDESHOW_ACTION.effect === "leave") setSlideshow(false);
              }}
            >
              <Text style={[styles.statusAction, { color: colors.onStage }]}>
                {SLIDESHOW_ACTION.label}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel="More actions"
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => setOverflowOpen(true)}
            >
              <Icon name="more-vertical" size={22} color={colors.onStage} />
            </Pressable>
          )}
        </View>

        {/* The editor takes the whole body: no pager arrows, no swipe target,
            no filmstrip below (proto 4518, 4599, 4606). A member mid-edit is
            never one gesture away from a different photograph. */}
        {editing ? (
          <View style={styles.fill}>
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

        {/* One status line inside the stage: what is true about the bytes,
            with the single inline action. No toast, no spinner. While the
            editor is open it carries the editor's live sentence instead —
            `Crop 3 : 2 · rotation −2° · nothing written yet` — which is the
            promise the whole mode rests on (proto 4632–4645). */}
        <View style={[styles.statusLine, { borderTopColor: colors.stageLine }]}>
          <Text
            numberOfLines={2}
            style={[styles.statusText, { color: colors.onStageSoft }]}
          >
            {editing
              ? editorLine
              : slideshow
                ? "Leaving the slideshow keeps the photograph you stopped on"
                : status.text}
          </Text>
          {/* The ONE offer to spend the bytes lives here (proto 4645). The
              page used to render a second `Load the original` chip over the
              photograph; two controls for one fetch is two states to keep in
              step, and they did not stay in step. This tap unlocks the gate
              AND climbs the page's quality ladder, which is exactly what the
              chip did — the stated choice is unchanged, it just has one
              home. */}
          {!slideshow && !editing && status.action ? (
            <Pressable
              accessibilityLabel={LOAD_THE_ORIGINAL}
              accessibilityRole="button"
              hitSlop={10}
              onPress={() => setFullQualityUnlocked(true)}
            >
              <Text style={[styles.statusAction, { color: colors.link }]}>
                {status.action}
              </Text>
            </Pressable>
          ) : null}
        </View>

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
                onWrite={write}
              />
            </View>
          </>
        )}

        <PhotoInfoSheet
          asset={current}
          fullQualityUnlocked={fullQualityUnlocked}
          gatewayName={gatewayName}
          networkType={networkType}
          onAddTag={(label) =>
            writeReason("tag-asset", { asset_id: current.assetId!, label })
          }
          onCaption={(caption) =>
            writeReason(
              "update-asset",
              { asset_id: current.assetId!, title: caption },
              [
                {
                  op: "upsert",
                  entity: "media.media_asset",
                  rowId: current.assetId!,
                  values: { title: caption },
                },
              ]
            )
          }
          onClose={() => setInfoOpen(false)}
          onRemovePlace={() =>
            void writeReason("set-place", { asset_id: current.assetId! }, [
              {
                op: "upsert",
                entity: "media.media_asset",
                rowId: current.assetId!,
                values: { place_id: null },
              },
            ])
          }
          people={people}
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

        <OptionSheet
          visible={overflowOpen}
          title="More"
          options={OVERFLOW_OPTIONS.map((option) => ({ ...option }))}
          onSelect={(id) => {
            setOverflowOpen(false);
            if (id === "slideshow") setSlideshow(true);
            else runExport(id === "download");
          }}
          onClose={() => setOverflowOpen(false)}
        />

        <OptionSheet
          visible={placementKind !== undefined}
          title={`${placementKind === "move" ? "Move" : "Copy"} to…`}
          options={scopes
            .filter(
              (scope) =>
                scope.role !== "read" &&
                !current.scopeIds?.includes(scope.vaultId)
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
