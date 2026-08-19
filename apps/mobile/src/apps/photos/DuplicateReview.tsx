// The Duplicates shelf, phone-shaped (Photos v4 handoff §4.4, §D). Same tile
// grammar as the library grid — a candidate is a tile, not a row — because a
// dHash hint on an asset is still a photograph first.
//
// The write is the same one the desktop Duplicates view takes (see
// `duplicates-actions.ts`'s `trashDuplicateAssets`): a "duplicate" is not a
// distinct kind of delete, just a different way of arriving at the asset id.
// There is no separate "dismiss" write here because the hint itself is
// derived at read time (`timeline-model.ts`), never stored — nothing to
// un-set. Selecting the tiles the member does not want and trashing them
// answers the same question a merge would.

import React, { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import { useReplicaRefresh } from "../../kit/replica/useReplicaRefresh";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import GrantSheet from "../../kit/share/GrantSheet";
import { spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { NativeWriteResult } from "../../lib/replica/native-session";
import type { PhotosScreenProps } from "../../navigation";
import {
  NO_DOWNLOAD_REASON,
  batchFavorite,
  vaultAssets,
} from "./photos-selection-writes";
import PhotosScreen from "./PhotosScreen";
import PhotoTimeline from "./PhotoTimeline";
import { sectionPhotoAssets } from "./timeline-model";
import type { PhotoAsset } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
import { usePhotoSelectionShare } from "./use-photo-selection-share";
import { READ_ONLY_VAULT_REASON } from "./viewer-model";

export default function DuplicateReview({
  navigation,
}: PhotosScreenProps<"DuplicateReview">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { session } = useReplica();
  const timeline = usePhotoTimeline();
  const { refreshing, refreshNow } = useReplicaRefresh();
  const [selection, setSelection] = useState(new Set<string>());
  const [trashing, setTrashing] = useState(false);
  const hints = useMemo(
    () => timeline.assets.filter((asset) => asset.duplicateHint),
    [timeline.assets]
  );
  const sections = useMemo(() => sectionPhotoAssets(hints), [hints]);
  const selecting = selection.size > 0;

  const trashSelected = (): void => {
    const targets = hints.filter(
      (asset): asset is PhotoAsset & { assetId: string } =>
        selection.has(asset.id) && Boolean(asset.assetId)
    );
    if (targets.length === 0) return;
    Alert.alert(
      `Trash ${targets.length} duplicate${targets.length === 1 ? "" : "s"}?`,
      "The device original is never deleted by this action.",
      [
        { text: "Cancel" },
        {
          onPress: () => void runTrash(targets),
          style: "destructive",
          text: "Trash",
        },
      ]
    );
  };
  const runTrash = async (
    targets: readonly (PhotoAsset & { assetId: string })[]
  ): Promise<void> => {
    if (!session) return;
    setTrashing(true);
    const trashNext = async (index: number): Promise<void> => {
      const asset = targets[index];
      if (!asset) return;
      const result = await session.write("photos", {
        action: "delete-asset",
        input: { asset_id: asset.assetId },
      });
      surfaceWriteOutcome(result);
      return trashNext(index + 1);
    };
    try {
      await trashNext(0);
      setSelection(new Set());
    } catch (error) {
      surfaceWriteFailure(error, "Duplicates not trashed");
    } finally {
      setTrashing(false);
    }
  };

  const emit = (result: NativeWriteResult): void => {
    surfaceWriteOutcome(result);
  };
  const selected = vaultAssets(hints, selection);
  // One handler for the third selection target, shared by every Photos shelf
  // (`use-photo-selection-share.ts`) so the grant sheet's moment and the
  // refusal grammar cannot drift between them.
  const share = usePhotoSelectionShare(
    () => selected,
    () => setSelection(new Set())
  );
  const writeBlockedReason = session
    ? selected.some((asset) => asset.canWrite === false)
      ? READ_ONLY_VAULT_REASON
      : null
    : "Not connected to a gateway, so nothing can be written here.";
  const selectionBar = {
    count: selection.size,
    shelf: "normal" as const,
    copyLabel: share.copyLabel,
    readOnlyReason: writeBlockedReason,
    favorite: writeBlockedReason
      ? { unavailableReason: writeBlockedReason }
      : {
          run: () => {
            void batchFavorite(session!, selected, emit)
              .then(() => setSelection(new Set()))
              .catch((error: unknown) =>
                surfaceWriteFailure(error, "Photos not favorited")
              );
          },
        },
    addToAlbum: {
      unavailableReason: "Add to album from the library, where the albums are.",
    },
    // Share is one standing grant over one photograph, through the one kit.
    share: share.handler,
    download: { unavailableReason: NO_DOWNLOAD_REASON },
    // The shelf's whole verb. Same confirm the head's control asks for, so
    // the two ways to reach it cannot mean two different things.
    trash: writeBlockedReason
      ? { unavailableReason: writeBlockedReason }
      : trashing
        ? { unavailableReason: "Trashing the last selection is still running." }
        : { run: trashSelected },
  };
  return (
    // Duplicates is a genuine CHILD of the More sheet's row, so it keeps a
    // back affordance — and it now also carries the band, so the way out of
    // Photos is no harder to reach than the app's own tabs (§F).
    <PhotosScreen current="more" selection={selectionBar}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel={selecting ? "Clear selection" : "Back to Photos"}
          accessibilityRole="button"
          onPress={() =>
            selecting ? setSelection(new Set()) : navigation.goBack()
          }
        >
          <Icon
            name={selecting ? "x" : "chevron-left"}
            size={selecting ? 22 : 26}
            color={colors.text}
          />
        </Pressable>
        {selecting ? (
          <Text style={styles.selectionCount} numberOfLines={1}>
            {selection.size} selected
          </Text>
        ) : (
          <View style={styles.copy}>
            <Text style={styles.title} numberOfLines={1}>
              Duplicates review
            </Text>
            {/* The second line is GONE. It said "Similarity
                only—nothing is auto-merged." — invented copy, and an unspaced
                em dash against the system's `·` separator grammar (§18). The
                count already sits at the trailing edge of this row, and what
                a hint is belongs in the shelf's own note, not under its
                title. */}
          </View>
        )}
        {/* Trash moved to the selection bar at the foot (§6), where it is one
            of five named 56px targets instead of a lone control in the head —
            so the head keeps the count and nothing else. */}
        {selecting ? null : (
          <Text style={styles.count} numberOfLines={1}>
            {hints.length}
          </Text>
        )}
      </View>
      <ReplicaStatusBar />
      {sections.length ? (
        <PhotoTimeline
          sections={sections}
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
          {/* The web's own empty copy, verbatim — "dHash" is the name of an
              algorithm, not something a member ever asked about. */}
          <Text style={styles.meta}>
            No near-identical clusters in your library.
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

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    copy: { flex: 1, marginLeft: spacing[2] },
    count: { ...t("mono"), color: colors.textSoft },
    empty: { alignItems: "center", flex: 1, justifyContent: "center" },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      minHeight: 56,
      paddingHorizontal: spacing[4] - 2,
    },
    meta: { ...t("control"), color: colors.textSoft, marginTop: 2 },
    selectionCount: { ...t("mono"), color: colors.text, flex: 1 },
    title: { ...t("bodyStrong"), color: colors.text },
  });
