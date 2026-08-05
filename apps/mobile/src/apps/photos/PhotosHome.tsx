// Photos' home surface on the phone (v4 handoff §3.1, §4, §14, §15).
// governance: allow-repo-hygiene file-size-limit #711 Photos v4 home wiring remains a cohesive interaction module.
//
// The screen is now the wiring: state, data and routing. Everything with a
// shape of its own moved out to a file that can be read — and tested — on its
// own terms:
//
//   photos-band.ts     the band's rules (five + More, the capsule, the ground)
//   PhotosBand.tsx     the band, rendered on OPAQUE paper
//   PhotosToolbar.tsx  the tile-size stepper (the pinch's pointer equivalent)
//   photos-rungs.ts    the four rungs, and pinch == stepper
//   justify.ts         justified packing from real aspect ratios
//   timeline-rows.ts   month/day grouping and the row list
//   PhotoTile.tsx      the tile and its four overlay slots
//   ScrubRail.tsx      the overlay rail and its month bubble
//   photos-backup.ts   the serial backup run
//   photos-vaults.ts   vault facts, keyed by id, `kind` never by name

import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
import { pageMargin, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
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
import {
  inCloudMessage,
  runBackup,
  useAutomaticPhotoBackup,
} from "./photos-backup";
import {
  DEFAULT_BAND_OWNER,
  bandOwnerKey,
  resolveMoreRowRoute,
} from "./photos-band";
import type {
  BandDestinationKey,
  BandOwner,
  PhotosMoreRowKey,
} from "./photos-band";
import { usePhotosRung } from "./photos-rung-store";
import { rungHeight } from "./photos-rungs";
import type { Rung } from "./photos-rungs";
import PhotosBand from "./PhotosBand";
import PhotosCollectionsView from "./PhotosCollectionsView";
import PhotosMoreSheet from "./PhotosMoreSheet";
import PhotosPeopleView from "./PhotosPeopleView";
import { PhotosSearchView } from "./PhotosSearch";
import PhotosToolbar from "./PhotosToolbar";
import PhotoTimeline from "./PhotoTimeline";
import {
  pinnedThumbnailCandidates,
  pinnedThumbnailSignature,
} from "./pinned-thumbnails";
import { skeletonRows, skeletonTileCount } from "./skeleton-rows";
import { onThisDay } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";

export default function PhotosHome({
  navigation,
  route,
}: PhotosScreenProps<"PhotosHome">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { session, gatewayBase, vaultId, refresh } = useReplica();
  const timeline = usePhotoTimeline();

  // The band on a PUSHED Photos screen (PhotosScreen) navigates here with the
  // destination it wants rather than pushing a second copy of Home. React
  // Navigation updates params on a mounted screen WITHOUT remounting it, so
  // the initial state alone would silently ignore every tap after the first —
  // the effect is what makes the band work from a pushed screen at all.
  const [destination, setDestination] = useState<BandDestinationKey>(
    route.params?.destination ?? "library"
  );
  const routeDestination = route.params?.destination;
  useEffect(() => {
    if (routeDestination)
      queueMicrotask(() => setDestination(routeDestination));
  }, [routeDestination]);
  const [moreOpen, setMoreOpen] = useState(false);
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
  const [rung, changeRung] = usePhotosRung();
  const [bandOwner, setBandOwner] = useState<BandOwner>(DEFAULT_BAND_OWNER);
  useEffect(() => {
    void Store.hydrate(bandOwnerKey("photos"), DEFAULT_BAND_OWNER).then(
      (stored) => setBandOwner(stored === "host" ? "host" : "app")
    );
  }, []);

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
                  entries.rows.filter(
                    (row) => String(row.collection_id) === albumId
                  ).length + index;
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

  const selecting = selection.size > 0;

  const onDestination = (key: BandDestinationKey): void => {
    if (key === "more") {
      setMoreOpen(true);
      return;
    }
    // Search is a DESTINATION, not a push (proto:4953-4954). `appBandOn`
    // excludes only the viewer, zoom, video, slideshow and the editor — Search
    // is none of those, so the band must stay up with Search current and the
    // frame's Home capsule still reachable. Pushing `PhotosSearch` gave it a
    // back chevron and no band at all, which is the rule this line now keeps.
    setDestination(key);
  };

  const onMoreRow = (key: PhotosMoreRowKey): void => {
    setMoreOpen(false);
    const nextRoute = resolveMoreRowRoute(key);
    if (nextRoute.screen === "PhotoStateView")
      navigation.navigate("PhotoStateView", nextRoute.params);
    else navigation.navigate(nextRoute.screen);
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
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={() => setSelection(new Set())}
            style={styles.headerBtn}
          >
            <Icon name="x" size={23} color={colors.text} />
          </Pressable>
          <Text style={styles.selectionCount}>{selection.size} selected</Text>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add to album"
              onPress={addToAlbum}
              style={styles.headerBtn}
            >
              <Icon name="folder-plus" size={21} color={colors.text} />
            </Pressable>
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Select"
            onPress={() => {
              const first = timeline.assets[0];
              if (first) setSelection(new Set([first.id]));
            }}
            style={styles.headerBtn}
          >
            <Icon name="check" size={22} color={colors.text} />
          </Pressable>
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
        {destination === "albums" ? (
          <PhotosCollectionsView navigation={navigation} />
        ) : destination === "people" ? (
          <PhotosPeopleView navigation={navigation} />
        ) : destination === "search" ? (
          <PhotosSearchView navigation={navigation} />
        ) : (
          <>
            {/* The toolbar stays up while the library opens (§14): the rung is
                a member preference that exists before the photographs do, and a
                control that appears once the data lands is a control that
                moves. */}
            {selecting ? null : (
              <PhotosToolbar
                rung={rung}
                onRungChange={changeRung}
                total={timeline.assets.length}
              />
            )}

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
            ) : (
              <PhotoTimeline
                sections={timeline.sections}
                selection={selection}
                refreshing={refreshing}
                // The one surface that holds the connection signal, so the one
                // surface that can honestly tell a tile the gateway is down.
                unreachable={
                  collections.connection === "offline" ||
                  collections.connection === "unavailable"
                }
                onRefresh={() => void refreshLibrary()}
                onSelectionChange={setSelection}
                onOpen={(asset) =>
                  navigation.navigate("PhotoLightbox", { assetId: asset.id })
                }
              />
            )}
          </>
        )}
      </View>

      {/* Exactly ONE band. Photos has claimed it, so the frame's own band does
          not render; the frame is represented by the capsule inside this one.

          A FLEX SIBLING of the content slot, never an overlay on top of it
          (handoff `appBandStyle` :4955 — `flex:none` in the frame's column,
          below the scroll region). It used to be an absolutely positioned slot
          at `bottom:0`, with each scroll surface padding its own content by the
          band's height to compensate. Padding only guarantees the END of the
          content clears the band; mid-scroll a day header and a tile caption
          still passed underneath it. Sibling layout makes the scroll viewport
          genuinely shorter, so there is no "under" to pass through. */}
      <PhotosBand
        owner={bandOwner}
        current={destination}
        onSelect={onDestination}
        // `popTo`, not `navigate` and not `goBack`. React Navigation 7's
        // `navigate` no longer returns to a route already in the stack — it
        // PUSHES a second copy (StackRouter's NAVIGATE only reuses a route
        // when the action carries `pop`, which is what `popTo` sets). A screen
        // pushed above a `fullScreenModal` is presented modally by UIKit, so
        // Home arrived as an inset card sheet over Photos instead of Photos
        // dismissing. `goBack` is wrong too: Photos can be entered by deep
        // link (deep-links.ts), where there is nothing to go back TO — and
        // §3.1 makes the way home the one thing an app may never take away.
        // `popTo` covers both: it pops to Home when Home is beneath, and
        // REPLACES the cover with Home when it is not.
        onHome={() => navigation.popTo("Home")}
      />

      <PhotosMoreSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        onSelect={onMoreRow}
      />
    </View>
  );
}

/**
 * The library, opening. Packed by `justify()` at the member's own rung from a
 * FIXED aspect sequence (`skeleton-rows.ts`), painted in `--skel`. No shimmer
 * and no randomness: motion in a placeholder says something is happening when
 * nothing is, and a grid that repacks itself on every render is the reflow §14
 * exists to forbid.
 *
 * Deliberately not a `FlashList` — there is nothing to virtualise, and one
 * screenful is all that is ever drawn.
 */
function PhotosGridSkeleton({ rung }: { rung: Rung }): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width, height } = useWindowDimensions();
  const target = rungHeight(rung, "phone");
  // The window's full height, not the slot's: the slot is now genuinely shorter
  // than the window (the band is a sibling that takes its own room), so this
  // packs at most a row or two more than fit — and `styles.skeleton` clips
  // them. Overshooting a placeholder is invisible; undershooting leaves a bare
  // strip above the band while the library opens.
  const rows = useMemo(
    () => skeletonRows(width, target, skeletonTileCount(width, target, height)),
    [height, target, width]
  );

  return (
    <View
      accessibilityLabel="Opening your library"
      accessibilityRole="progressbar"
      style={styles.skeleton}
      pointerEvents="none"
    >
      {rows.map((row, index) => (
        // Row index is the only identity a placeholder row has, and the list is
        // fixed for the life of the loading state.
        <View key={`skeleton-row-${index}`} style={styles.skeletonRow}>
          {row.map((tile) => (
            <View
              key={tile.asset.id}
              style={[
                styles.skeletonTile,
                {
                  backgroundColor: colors.skel,
                  height: tile.height,
                  width: tile.width,
                },
              ]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // The scroll region takes what is left after the head and the band; the
    // band takes its own height. No absolute slot, and so nothing to reserve.
    body: { flex: 1 },
    bodyText: {
      ...t("body"),
      color: colors.textSoft,
      marginTop: 12,
      maxWidth: 290,
      textAlign: "center",
    },
    center: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: 28,
    },
    emptyTitle: { ...t("display"), color: colors.text },
    header: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      // 56px (handoff `appBarStyle` :5533's `min-height:56px`).
      minHeight: 56,
      paddingHorizontal: pageMargin,
    },
    headerActions: { flexDirection: "row" },
    headerBtn: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    safe: { flex: 1 },
    selectionCount: { ...t("mono"), color: colors.text },
    // The same 2px gutter the real grid uses, on both axes — the placeholder
    // and the photographs occupy identical boxes.
    skeleton: { flex: 1, overflow: "hidden" },
    skeletonRow: { flexDirection: "row", gap: 2, marginBottom: 2 },
    skeletonTile: { borderRadius: 2 },
    // The title starts at the page margin now that no ☰ occupies the leading
    // slot; `header`'s own `paddingHorizontal: pageMargin` is that margin, so
    // the title needs no margin of its own — it used to add `spacing[2]` on
    // top of a header padding that was only an approximation (`10`) of the
    // page margin, which happened to sum to 18; now that `header` carries the
    // real token, adding `spacing[2]` again would push the title past it.
    title: { ...t("title"), color: colors.text },
    uploadFill: { borderRadius: 999, height: "100%" },
    uploadProgress: { gap: 5, paddingHorizontal: 16, paddingVertical: 8 },
    uploadProgressText: { ...t("mono"), color: colors.textSoft },
    uploadTrack: {
      backgroundColor: colors.line,
      borderRadius: 999,
      height: 5,
      overflow: "hidden",
    },
  });
