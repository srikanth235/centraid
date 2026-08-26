// One filtered shelf (Favorites / Archive / Trash / person): the same `PhotoTimeline` under a filter. Reached from More, so `more` is current — the band is the way out, not a back chevron.

import React, { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";

import {
  PHOTOS_ARCHIVE_EMPTY,
  PHOTOS_EMPTY_FAVORITES,
} from "@centraid/blueprints/apps/photos/shared-copy";

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
import GrantSheet from "../../kit/share/GrantSheet";
import { borders, spacing, t, useTheme, radii } from "../../kit/theme";
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
import { usePhotoSelectionShare } from "./use-photo-selection-share";
import { READ_ONLY_VAULT_REASON } from "./viewer-model";

/**
 * `purge-asset` (#711) destroys the row NOW and hands bytes to the next storage sweep. No undo grammar — safety is the native confirm before the first write leaves the device.
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
  // Person mode: confirmed faces, not an asset flag — same join FaceReview/PhotosCollectionsView use; one call site, kept local.
  const faces = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "media.face_region" }), [])
  );
  // Lineage for purge ORDER only (#711): timeline has no `source_asset_id`; vault refuses a source while a copy still names it.
  const trashedRows = useReplicaQuery(
    "photos",
    useMemo(
      () => ({
        entity: "media.asset",
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
  // Trash meta is count PLUS the purge window (proto:3945) — the window is what makes the count trustworthy.
  const meta =
    mode === "trash"
      ? `${assets.length} in trash · purged 30 days after deletion`
      : `${assets.length} ${noun}`;
  const emptyCopy =
    mode === "favorites"
      ? PHOTOS_EMPTY_FAVORITES
      : mode === "archive"
        ? PHOTOS_ARCHIVE_EMPTY
        : mode === "videos"
          ? "Videos you capture or import collect here."
          : mode === "person"
            ? `No photographs of ${params.personName} yet.`
            : "Trash is empty.";
  const emit = (result: NativeWriteResult): void => {
    surfaceWriteOutcome(result);
  };
  const selected = vaultAssets(assets, selection);
  const share = usePhotoSelectionShare(
    () => selected,
    () => setSelection(new Set())
  );
  // Empty trash acts on the WHOLE shelf, not the selection — different question, own refusal.
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
  // A non-writable shelf still SHOWS every target (§6); the sentence below the bar is why nothing will fire.
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
    // Trash swaps the fifth target for Restore (§6).
    shelf: mode === "trash" ? ("trash" as const) : ("normal" as const),
    copyLabel: share.copyLabel,
    readOnlyReason: writeBlockedReason,
    favorite: canWrite
      ? {
          run: runSelection(
            () => batchFavorite(session!, selected, emit, mode !== "favorites"),
            `${title} change not saved`
          ),
        }
      : blocked,
    // No album picker here — inventing a second one would be a second answer. Library is where it lives.
    addToAlbum: {
      unavailableReason: canWrite
        ? "Add to album from the library, where the albums are."
        : writeBlockedReason!,
    },
    share: share.handler,
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
    // People is off the band (#712) — `more` is current for every mode, including person (`PlacesView`/`FaceReview`).
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
        {/* Head: count + way out of selection. Five actions live in the foot bar (§6). */}
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
              // OUTLINED `--net`, never filled (proto:4800-4803) — the irreversible control must not look louder than Import. Press opens confirm; only confirm destroys.
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
          {/* Restore promise once here, not folded into the meta line (proto:4445). */}
          <Text style={[styles.note, { color: colors.textSoft }]}>
            Deleted photographs stay here for 30 days, then they are purged.
          </Text>
          {/* Head control's cost, or the refusal in its place — a greyed control with nothing to read is the defect. */}
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
      <GrantSheet
        visible={share.visible}
        onClose={() => share.dismiss()}
        {...share.sheetProps}
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
    borderRadius: radii.pill,
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
