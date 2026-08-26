// Duplicates SHELF, phone-shaped (Photos v4 handoff §5, proto:4436-4442). A
// flat grid cannot answer "which of THESE copies do I keep"; this shelf gives
// one labelled row per cluster (`Cluster 1 · …`) with `Review duplicates` as
// the way into the cluster-at-a-time flow (proto:4800-4803). SAME TILE, SAME
// SELECTION: rows are `justify()`'d like timeline day-rows, tiles are the
// shared `PhotoTile` at the member's rung; note wording is imported from web
// so clients cannot drift.

import React, { useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";

import {
  duplicatesLede,
  PHOTOS_EMPTY_DUPLICATES,
} from "@centraid/blueprints/apps/photos/shared-copy";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplica } from "../../kit/replica/ReplicaProvider";
import ReplicaStatusBar from "../../kit/replica/ReplicaStatusBar";
import {
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import GrantSheet from "../../kit/share/GrantSheet";
import { borders, spacing, t, useTheme, radii } from "../../kit/theme";
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
import { usePhotoSelectionShare } from "./use-photo-selection-share";
import { READ_ONLY_VAULT_REASON } from "./viewer-model";

/** The web's own `EMPTY_COPY[DUPLICATES]` sentence, from its owning module. */
const NOTHING_TO_REVIEW = PHOTOS_EMPTY_DUPLICATES;

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
  // Every photograph shown, so a selection resolves without re-walking clusters.
  const shown = useMemo(
    () => clusters.flatMap((cluster) => cluster.assets),
    [clusters]
  );
  const selecting = selection.size > 0;

  const emit = (result: NativeWriteResult): void => {
    surfaceWriteOutcome(result);
  };
  const selected = vaultAssets(shown, selection);
  // Shared third selection target across Photos shelves (grant moment/refusal
  // grammar must not drift).
  const share = usePhotoSelectionShare(
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
    copyLabel: share.copyLabel,
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
    // Share is one standing grant over one photograph, via the kit.
    share: share.handler,
    download: { unavailableReason: NO_DOWNLOAD_REASON },
    // The shelf's own verb (proto:4437 — "selecting a copy marks it for
    // trash"), with the same confirm as the rest of Photos.
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
        {/* Primary (proto:4800-4803): into the cluster-at-a-time review.
            Hidden while a selection is live — the foot is then the bar. */}
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
      <GrantSheet
        visible={share.visible}
        onClose={() => share.dismiss()}
        {...share.sheetProps}
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
  /** Ordinal the header reads (`Cluster 1`), never a stable id (proto:4439). */
  index: number;
  selection: Set<string>;
  onToggle: (asset: PhotoAsset) => void;
}): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [rung] = usePhotosRung();
  const vaults = useVaultFacts();
  const { width } = useWindowDimensions();
  // Gutters come out of the packing width so a cluster row fills the stage.
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
          // Re-packed from the same ordered list each render: position IS
          // identity — same key as the timeline's packed rows.
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
              // A cluster is a decision, not a browse: tap picks the copy
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
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      justifyContent: "center",
      minHeight: 34,
      paddingHorizontal: spacing[3],
    },
    primaryText: { ...t("control"), color: colors.text },
    title: { ...t("bodyStrong"), color: colors.text, flex: 1 },
  });
