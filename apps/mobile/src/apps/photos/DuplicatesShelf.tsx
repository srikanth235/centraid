// The Duplicates SHELF, phone-shaped (Photos v4 handoff §5, proto:4436-4442).
//
// WHAT WAS MISSING. The More sheet's `Duplicates` row landed straight on
// `DuplicateReview` — a flat grid of every photograph carrying a hash hint,
// with no clusters in it. That grid answers "which photographs are suspect";
// the question the member has is "which of THESE copies do I keep", and it is
// unanswerable when the copies are scattered across a timeline. The prototype's
// shelf is the missing half: one labelled row per cluster
// (`Cluster 1 · 3 near-identical` / `within 2 seconds · 4.1 MB each`), the
// shelf's own note above them, and `Review duplicates` as the way into the
// cluster-at-a-time flow (proto:4800-4803 — the shelf's primary action IS the
// review).
//
// SAME TILE, SAME SELECTION (CHANGELOG §"a shelf is the same timeline under a
// filter"): a cluster row is `justify()`'d exactly as a timeline day-row is,
// and every box is the shared `PhotoTile`, at the rung the member chose — a
// shelf that pinned its own tile size would be a fifth size nobody asked for.
//
// The note's wording is imported from the web app rather than restated, so the
// two clients cannot drift on what selecting a copy means.

import React, { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";

import { duplicatesLede } from "@centraid/blueprints/apps/photos/shared-copy";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import ShareTargetPicker from "../../kit/share/ShareTargetPicker";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import type { NativeWriteResult } from "../../lib/replica/native-session";
import type { PhotosScreenProps } from "../../navigation";
import {
  clusterLabel,
  clusterMeta,
  duplicateClusters,
} from "./duplicate-clusters";
import type { DuplicateCluster } from "./duplicate-clusters";
import { justify } from "./justify";
import { usePhotosRung } from "./photos-rung-store";
import { rungHeight } from "./photos-rungs";
import {
  NO_DOWNLOAD_REASON,
  batchFavorite,
  batchTrash,
  vaultAssets,
} from "./photos-selection-writes";
import { useVaultFacts } from "./photos-vaults";
import PhotosScreen from "./PhotosScreen";
import PhotoTile from "./PhotoTile";
import type { PhotoAsset } from "./timeline-model";
import { usePhotoTimeline } from "./timeline-source";
import { useCopyToSharing } from "./use-copy-to-sharing";
import { READ_ONLY_VAULT_REASON } from "./viewer-model";

/** The shelf's copy when there is nothing to review. The web's own sentence
 *  (`EMPTY_COPY[DUPLICATES]`), matched by `DuplicateReview.tsx`. */
const NOTHING_TO_REVIEW = "No near-identical clusters in your library.";

export default function DuplicatesShelf({
  navigation,
}: PhotosScreenProps<"DuplicatesShelf">): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { session } = useReplica();
  const timeline = usePhotoTimeline();
  const [selection, setSelection] = useState(new Set<string>());
  const clusters = useMemo(
    () => duplicateClusters(timeline.assets),
    [timeline.assets]
  );
  // Every photograph the shelf is showing, so a selection can be resolved
  // without walking the clusters again per action.
  const shown = useMemo(
    () => clusters.flatMap((cluster) => cluster.assets),
    [clusters]
  );
  const selecting = selection.size > 0;

  const emit = (result: NativeWriteResult): void => {
    surfaceWriteOutcome(result);
  };
  const selected = vaultAssets(shown, selection);
  // One handler for the third selection target, shared by every Photos shelf
  // (`use-copy-to-sharing.ts`) so the picker moment and the refusal grammar
  // cannot drift between them.
  const sharing = useCopyToSharing(
    () => selected,
    () => setSelection(new Set())
  );
  const writeBlockedReason = session
    ? selected.some((asset) => asset.canWrite === false)
      ? READ_ONLY_VAULT_REASON
      : null
    : "Not connected to a gateway, so nothing can be written here.";
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

  const selectionBar = {
    count: selection.size,
    shelf: "normal" as const,
    readOnlyReason: writeBlockedReason,
    favorite: writeBlockedReason
      ? { unavailableReason: writeBlockedReason }
      : {
          run: runSelection(
            () => batchFavorite(session!, selected, emit),
            "Photos not favorited"
          ),
        },
    addToAlbum: {
      unavailableReason: "Add to album from the library, where the albums are.",
    },
    // The real thing since issue #712 A5: a live control that places
    // `media.media_asset` into the member's share target — or, when they
    // have not chosen one yet, asks at the moment of intent (A3).
    share: sharing.handler,
    download: { unavailableReason: NO_DOWNLOAD_REASON },
    // The shelf's own verb (proto:4437 — "selecting a copy marks it for
    // trash"). Same confirm the rest of Photos asks for, so the two ways to
    // reach a trash cannot mean two different things.
    trash: writeBlockedReason
      ? { unavailableReason: writeBlockedReason }
      : {
          run: () =>
            Alert.alert(
              `Move ${selection.size} to trash?`,
              "The copy you keep stays in every album it is already in. The device original is never deleted by this action.",
              [
                { text: "Cancel" },
                {
                  text: "Trash",
                  style: "destructive" as const,
                  onPress: runSelection(
                    () => batchTrash(session!, selected, emit),
                    "Photos not trashed"
                  ),
                },
              ]
            ),
        },
  };

  return (
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
        <Text style={styles.title} numberOfLines={1}>
          {selecting ? `${selection.size} selected` : "Duplicates"}
        </Text>
        {/* The shelf's primary (proto:4800-4803): the way into the
            cluster-at-a-time review. Hidden while a selection is live, because
            the foot is the selection bar then and a second primary would
            compete with it. */}
        {selecting || clusters.length === 0 ? null : (
          <Pressable
            accessibilityLabel="Review duplicates"
            accessibilityRole="button"
            onPress={() => navigation.navigate("DuplicateReview")}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>Review duplicates</Text>
          </Pressable>
        )}
      </View>
      <ReplicaStatusBar />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.note}>
          {clusters.length === 0
            ? NOTHING_TO_REVIEW
            : duplicatesLede(clusters.length)}
        </Text>
        {clusters.map((cluster, index) => (
          <ClusterBlock
            key={cluster.key}
            cluster={cluster}
            index={index}
            selection={selection}
            onToggle={(asset) =>
              setSelection((current) => {
                const next = new Set(current);
                if (next.has(asset.id)) next.delete(asset.id);
                else next.add(asset.id);
                return next;
              })
            }
          />
        ))}
      </ScrollView>
      <ShareTargetPicker
        visible={sharing.picking}
        candidates={sharing.candidates}
        onChoose={(vaultId) => sharing.choose(vaultId)}
        onClose={() => sharing.dismiss()}
      />
    </PhotosScreen>
  );
}

function ClusterBlock({
  cluster,
  index,
  selection,
  onToggle,
}: {
  cluster: DuplicateCluster;
  /** Position among the loaded clusters — the ordinal the header reads
   *  (`Cluster 1`), never a stable id (proto:4439). */
  index: number;
  selection: Set<string>;
  onToggle: (asset: PhotoAsset) => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [rung] = usePhotosRung();
  const vaults = useVaultFacts();
  const { width } = useWindowDimensions();
  // The shelf's own gutters come out of the packing width, so a cluster row
  // fills the stage exactly rather than overflowing it by the padding.
  const content = width - spacing[4] * 2;
  const rows = useMemo(
    () => justify(cluster.assets, content, rungHeight(rung, "phone")),
    [cluster.assets, content, rung]
  );
  const meta = clusterMeta(cluster);
  return (
    <View style={styles.cluster}>
      <View style={styles.clusterHead}>
        <Text style={styles.clusterName} numberOfLines={1}>
          {clusterLabel(cluster, index)}
        </Text>
        {meta ? (
          <Text style={styles.clusterMeta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {rows.map((tiles, rowIndex) => (
        <View
          // Rows are re-packed from the same ordered list on every render, so a
          // row's position IS its identity — same key the timeline's own packed
          // rows carry.
          key={`${cluster.key}-${rowIndex}`}
          style={styles.clusterRow}
        >
          {tiles.map((tile) => (
            <PhotoTile
              key={tile.asset.id}
              asset={tile.asset}
              width={tile.width}
              height={tile.height}
              rung={rung}
              selected={selection.has(tile.asset.id)}
              // A cluster is a decision, not a browse: the shelf is
              // permanently in select mode, and a tap on a tile picks the copy
              // to trash rather than opening it.
              selecting
              vaults={vaults}
              onOpen={onToggle}
              onSelect={onToggle}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: { paddingBottom: spacing[5], paddingHorizontal: spacing[4] },
    cluster: { marginTop: spacing[5] },
    clusterHead: {
      alignItems: "baseline",
      flexDirection: "row",
      gap: spacing[2],
      marginBottom: spacing[2],
    },
    clusterMeta: { ...t("mono"), color: colors.textFaint },
    clusterName: { ...t("smallStrong"), color: colors.text, flex: 1 },
    clusterRow: { flexDirection: "row", gap: 2, marginBottom: 2 },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: spacing[2],
      minHeight: 56,
      paddingHorizontal: spacing[4] - 2,
    },
    note: { ...t("small"), color: colors.textSoft, marginTop: spacing[3] },
    primary: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: 8,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: 34,
      paddingHorizontal: spacing[3],
    },
    primaryText: { ...t("control"), color: colors.text },
    title: { ...t("bodyStrong"), color: colors.text, flex: 1 },
  });
