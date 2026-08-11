// One shelf, filtered (Photos v4 handoff §5): Favorites, Archive, Trash, or
// one person's photographs. A shelf is the SAME timeline under a filter — the
// grid below is `PhotoTimeline`, exactly as the library's is — and it carries
// the app's band like every other Photos surface (§F): this screen is reached
// from the More sheet, so `more` is the destination marked current, and the
// old back chevron is gone because the band is the way out now.

import React, { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";

import { Text } from "../../kit/components/NativeText";
import SelectChip from "../../kit/components/SelectChip";
import { postStatus } from "../../kit/components/status-line";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import ShareSheet from "../../kit/share/ShareSheet";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { NativeWriteResult } from "../../lib/replica/native-session";
import type { PhotosScreenProps } from "../../navigation";
import {
  NO_DOWNLOAD_REASON,
  batchFavorite,
  batchPurge,
  batchRestore,
  batchTrash,
  vaultAssets,
} from "./photos-selection-writes";
import {
  EMPTY_TRASH_CONFIRM,
  emptyTrashOrder,
  emptyTrashSummary,
} from "./photos-trash";
import PhotosScreen from "./PhotosScreen";
import PhotoTimeline from "./PhotoTimeline";
import { sectionPhotoAssets } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
import { useCopyToVault } from "./use-copy-to-vault";
import { READ_ONLY_VAULT_REASON } from "./viewer-model";

/**
 * What `Empty trash` does, and what it costs. The control fires the `purge-asset`
 * action (`media.purge_asset`, issue #711), which destroys the asset row, its
 * faces, tags, annotations and album membership NOW and hands the bytes to the
 * gateway's next storage sweep — instead of waiting out the 30-day window.
 *
 * Nothing here may use the undo grammar. `surfaceWriteOutcome` and the status
 * line both stay in their news register; the safety is the native confirm
 * below, which names the exact number and says plainly that it cannot be
 * undone BEFORE the first write leaves the device.
 */
export const EMPTY_TRASH_NOTE =
  "Deleting forever frees the space these hold. It cannot be undone.";

export default function PhotoStateView({
  route,
  navigation,
}: PhotosScreenProps<"PhotoStateView">): React.JSX.Element {
  const { colors } = useTheme();
  const { session } = useReplica();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const timeline = usePhotoTimeline();
  const [selection, setSelection] = useState(new Set<string>());
  const params = route.params;
  const mode = params.mode;
  // Person mode filters by a party's confirmed faces rather than by an asset
  // flag — the same join FaceReview/PhotosCollectionsView use, just kept
  // local to this view instead of a shared hook (one call site).
  const faces = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.face_region" }), [])
  );
  // Edit lineage, for the purge ORDER alone (issue #711). The timeline model
  // carries no `source_asset_id`, and the vault refuses to destroy a
  // photograph an edited copy still names as its source, so the shelf reads
  // the lineage column straight off the trashed rows — bounded by the same
  // `deleted_at not-null` filter the shelf itself is.
  const trashedRows = useReplicaQuery(
    "photos",
    useMemo(
      () => ({
        entity: "media.media_asset",
        where: [{ column: "deleted_at", op: "not-null" as const }],
      }),
      []
    )
  );
  const sourceOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of trashedRows.rows) {
      if (row.asset_id && row.source_asset_id)
        map.set(String(row.asset_id), String(row.source_asset_id));
    }
    return (assetId: string): string | undefined => map.get(assetId);
  }, [trashedRows.rows]);
  const partyId = mode === "person" ? params.partyId : undefined;
  const personAssetIds = useMemo(() => {
    if (!partyId) return undefined;
    const ids = new Set<string>();
    for (const face of faces.rows) {
      const pid = face.confirmed_by_party_id ?? face.party_id;
      if (pid && String(pid) === partyId && face.asset_id)
        ids.add(String(face.asset_id));
    }
    return ids;
  }, [faces.rows, partyId]);
  const assets = useMemo(
    () =>
      timeline.assets.filter((asset) => {
        if (mode === "favorites") return asset.favorite && !asset.deleted;
        if (mode === "archive") return asset.archived && !asset.deleted;
        // Issue #721 B3 — Collections' Videos shelf, opened here: the same
        // `PhotoAsset.kind` fact `photos-collections.ts` filters on.
        if (mode === "videos") return asset.kind === "video" && !asset.deleted;
        if (mode === "person")
          return (
            !asset.deleted &&
            Boolean(asset.assetId && personAssetIds?.has(asset.assetId))
          );
        return asset.deleted;
      }),
    [mode, personAssetIds, timeline.assets]
  );
  const title =
    mode === "favorites"
      ? "Favorites"
      : mode === "archive"
        ? "Archive"
        : mode === "videos"
          ? "Videos"
          : mode === "person"
            ? params.personName
            : "Trash";
  const noun = assets.length === 1 ? "photograph" : "photographs";
  // Trash's meta is the fuller status sentence (proto:3945) — count PLUS the
  // purge window — because that window is the one fact a member needs before
  // trusting the count. Every other mode is just the count and the noun.
  const meta =
    mode === "trash"
      ? `${assets.length} in trash · purged 30 days after deletion`
      : `${assets.length} ${noun}`;
  const emptyCopy =
    mode === "favorites"
      ? // The web shell's string (packages/blueprints), so the empty state
        // reads the same no matter which surface a member is on.
        "No favorites yet — tap the heart on any photograph."
      : mode === "archive"
        ? "Archive is empty."
        : mode === "videos"
          ? "Videos you capture or import collect here."
          : mode === "person"
            ? `No photographs of ${params.personName} yet.`
            : "Trash is empty.";
  const emit = (result: NativeWriteResult): void => {
    surfaceWriteOutcome(result);
  };
  const selected = vaultAssets(assets, selection);
  // One handler for the third selection target, shared by every Photos shelf
  // (`use-copy-to-vault.ts`) so the picker moment and the refusal grammar
  // cannot drift between them.
  const copyToVault = useCopyToVault(
    () => selected,
    () => setSelection(new Set())
  );
  // Empty trash acts on the WHOLE shelf rather than the selection, so it gets
  // its own targets and its own refusal — the selection bar's answer is about
  // whatever happens to be ticked, which is a different question.
  const purgeTargets = vaultAssets(
    assets,
    new Set(assets.map((asset) => asset.id))
  );
  const emptyTrashReason = session
    ? purgeTargets.some((asset) => asset.canWrite === false)
      ? READ_ONLY_VAULT_REASON
      : null
    : "Not connected to a gateway, so nothing can be deleted here.";
  const runEmptyTrash = (): void => {
    const count = purgeTargets.length;
    if (count === 0) return;
    // The confirmation is the whole safety story: it names the exact number
    // and says plainly that it cannot be undone, BEFORE anything is written.
    // `destructive` is the platform's own styling for exactly this.
    Alert.alert(
      EMPTY_TRASH_CONFIRM.title(count),
      EMPTY_TRASH_CONFIRM.body(count),
      [
        { text: EMPTY_TRASH_CONFIRM.cancel, style: "cancel" },
        {
          text: EMPTY_TRASH_CONFIRM.confirm(count),
          style: "destructive",
          onPress: () => {
            let purged = 0;
            const tally = (result: NativeWriteResult): void => {
              if (result.status === "executed") purged += 1;
              surfaceWriteOutcome(result);
            };
            void batchPurge(
              session!,
              emptyTrashOrder(purgeTargets, sourceOf),
              tally
            )
              .then(() => {
                setSelection(new Set());
                // No undo affordance rides this — there is nothing to undo.
                postStatus(emptyTrashSummary({ purged, kept: count - purged }));
                return refreshNow();
              })
              .catch((error: unknown) =>
                surfaceWriteFailure(error, "Trash not emptied")
              );
          },
        },
      ]
    );
  };
  // A shelf a member may not write into still SHOWS every target (§6); the
  // sentence below the bar is what tells them why nothing will fire.
  const writeBlockedReason = session
    ? selected.some((asset) => asset.canWrite === false)
      ? READ_ONLY_VAULT_REASON
      : null
    : "Not connected to a gateway, so nothing can be written here.";
  const canWrite = writeBlockedReason === null;
  const runSelection = (
    run: () => Promise<void>,
    failure: string
  ): (() => void) => {
    return () => {
      void run()
        .then(() => setSelection(new Set()))
        .catch((error: unknown) => surfaceWriteFailure(error, failure));
    };
  };
  const blocked = { unavailableReason: writeBlockedReason ?? "" };
  const selectionBar = {
    count: selection.size,
    // Trash swaps the fifth target for Restore (§6). Every other shelf here
    // carries the base five untouched.
    shelf: mode === "trash" ? ("trash" as const) : ("normal" as const),
    copyLabel: copyToVault.copyLabel,
    readOnlyReason: writeBlockedReason,
    favorite: canWrite
      ? {
          run: runSelection(
            () =>
              // On the Favorites shelf the only thing this target can mean is
              // "take these off it" — the write the shelf's old head control
              // performed, now where the handoff puts it.
              batchFavorite(session!, selected, emit, mode !== "favorites"),
            `${title} change not saved`
          ),
        }
      : blocked,
    // Adding to an album is a library action; this shelf has no album picker
    // and inventing a second one here would be a second answer to the same
    // question. The Library index is where it lives.
    addToAlbum: {
      unavailableReason: canWrite
        ? "Add to album from the library, where the albums are."
        : writeBlockedReason!,
    },
    // Share uses the same ceremony-free commons destination list everywhere.
    share: copyToVault.handler,
    download: { unavailableReason: NO_DOWNLOAD_REASON },
    trash: canWrite
      ? {
          run:
            mode === "trash"
              ? runSelection(
                  () => batchRestore(session!, selected, emit),
                  "Photos not restored"
                )
              : runSelection(
                  () => batchTrash(session!, selected, emit),
                  "Photos not trashed"
                ),
        }
      : blocked,
  };
  return (
    // People is off the band (issue #712): a person's shelf is reached from
    // Collections or the Library shelf list, never from the band itself, so
    // `more` is the destination marked current for every mode this screen
    // takes — including "person" — same as `PlacesView`/`FaceReview`.
    <PhotosScreen current="more" selection={selectionBar}>
      <View style={styles.header}>
        <View style={styles.copy}>
          <Text
            style={[styles.title, { color: colors.text }]}
            numberOfLines={1}
          >
            {title}
          </Text>
          <Text
            style={[styles.meta, { color: colors.textSoft }]}
            numberOfLines={1}
          >
            {meta}
          </Text>
        </View>
        {/* The head keeps the COUNT and the way out of selection; the five
            actions live in the bar at the foot, where a thumb is (§6). */}
        {selection.size ? (
          <Pressable
            accessibilityLabel="Done selecting"
            accessibilityRole="button"
            onPress={() => setSelection(new Set())}
            style={styles.headerBtn}
          >
            <Text style={[styles.action, { color: colors.text }]}>Done</Text>
          </Pressable>
        ) : assets.length ? (
          <View style={styles.headerActions}>
            {mode === "trash" ? (
              // OUTLINED `--net`, never filled (proto:4800-4803) — the one
              // irreversible control in the app must not look louder than Import.
              // Pressing it opens the confirm; only the confirm destroys anything.
              <Pressable
                accessibilityLabel="Empty trash"
                accessibilityRole="button"
                accessibilityState={{ disabled: emptyTrashReason !== null }}
                accessibilityHint={emptyTrashReason ?? EMPTY_TRASH_NOTE}
                disabled={emptyTrashReason !== null}
                onPress={runEmptyTrash}
                style={[
                  styles.emptyTrash,
                  {
                    borderColor:
                      emptyTrashReason === null
                        ? colors.net
                        : colors.textDisabled,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.action,
                    {
                      color:
                        emptyTrashReason === null
                          ? colors.net
                          : colors.textDisabled,
                    },
                  ]}
                >
                  Empty trash
                </Text>
              </Pressable>
            ) : null}
            <SelectChip
              disabled={false}
              onPress={() => {
                const first = assets[0];
                if (first) setSelection(new Set([first.id]));
              }}
            />
          </View>
        ) : null}
      </View>
      <ReplicaStatusBar />
      {mode === "trash" ? (
        <>
          {/* proto:4445, verbatim — the restore promise lives here, once,
              rather than folded into the meta line where it would compete
              with the count for the same breath. */}
          <Text style={[styles.note, { color: colors.textSoft }]}>
            Deleted photographs stay here for 30 days, then they are purged.
            Anything restored goes back to the day it was taken.
          </Text>
          {/* What the head's control does, said once, where the promise
              above it is — and the refusal in its place when it cannot fire,
              since a greyed control with nothing to read is the defect. */}
          {assets.length ? (
            <Text style={[styles.note, { color: colors.net }]}>
              {emptyTrashReason ?? EMPTY_TRASH_NOTE}
            </Text>
          ) : null}
        </>
      ) : null}
      {assets.length ? (
        <PhotoTimeline
          sections={sectionPhotoAssets(
            assets.map((asset) => ({
              ...asset,
              archived: false,
              deleted: false,
            }))
          )}
          selection={selection}
          onSelectionChange={setSelection}
          onOpen={(asset) =>
            navigation.navigate("PhotoLightbox", { assetId: asset.id })
          }
          refreshing={refreshing}
          onRefresh={refreshNow}
        />
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.meta, { color: colors.textSoft }]}>
            {emptyCopy}
          </Text>
        </View>
      )}
      <ShareSheet
        visible={copyToVault.picking}
        onClose={() => copyToVault.dismiss()}
        {...copyToVault.sheetProps}
      />
    </PhotosScreen>
  );
}

const styles = StyleSheet.create({
  action: t("control"),
  copy: { flex: 1, marginLeft: spacing[2] + 2 },
  empty: { alignItems: "center", flex: 1, justifyContent: "center" },
  emptyTrash: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: borders.hairline,
    justifyContent: "center",
    minHeight: 34,
    paddingHorizontal: spacing[3],
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    minHeight: 56,
    paddingHorizontal: spacing[4] - 2,
  },
  headerBtn: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    minWidth: 44,
  },
  headerActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  meta: { ...t("control"), marginTop: 2 },
  note: {
    ...t("small"),
    paddingBottom: spacing[2],
    paddingHorizontal: spacing[4] - 2,
  },
  title: t("bodyStrong"),
});
