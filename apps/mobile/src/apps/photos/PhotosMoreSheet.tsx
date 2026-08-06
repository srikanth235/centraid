// The More sheet (Photos v4 handoff §3.1, §H).
//
// The band is capped at five destinations, so the shelves that do not fit live
// here: Sharing, Favorites, Places, Duplicates, Trash, Backup. Import is the
// one handoff row this sheet still does NOT carry — see the comment on
// `PHOTOS_MORE_ROWS` (photos-band.ts) for why a missing row beats a lying one,
// and why Sharing came back in issue #712 while Import did not.

import React, { useMemo } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { useReplicaQuery } from "../../kit/hooks/useReplicaQuery";
import { useShareTarget } from "../../kit/share/use-share-target";
import { borders, family, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { PHOTOS_MORE_FOOT, PHOTOS_MORE_ROWS } from "./photos-band";
import type { PhotosMoreRowKey } from "./photos-band";
import { sharedAssets } from "./photos-sharing";
import { usePhotoTimeline } from "./timeline-source";

export interface PhotosMoreSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (key: PhotosMoreRowKey) => void;
}

/**
 * Live meta counts, keyed by row (proto:4980-4983's mono column). Every
 * value here is a real, already-loaded count — never a placeholder — and a
 * row with no reliable source (Backup: the frame's Backup screen derives its
 * figures from a network round trip and a durable-queue read this sheet has no
 * business making) is simply left out of the map, so its row renders
 * label-only rather than a made-up number.
 */
function useMoreRowMeta(): Partial<Record<PhotosMoreRowKey, string>> {
  const { assets } = usePhotoTimeline();
  const places = useReplicaQuery(
    "photos",
    useMemo(() => ({ entity: "core.place" }), [])
  );
  // Sharing's count comes from the SAME loaded timeline every other row's
  // meta reads — the shelf is a filter over it, so the sheet needs no second
  // fetch to state its size. With no share target chosen the row carries no
  // meta at all: a `0` would say "nothing of yours is shared", which this
  // device cannot know when it has not been told where shares go.
  const shareTargetId = useShareTarget().target?.vaultId;
  return useMemo(() => {
    const favoritesCount = assets.filter(
      (asset) => asset.favorite && !asset.deleted
    ).length;
    const trashCount = assets.filter((asset) => asset.deleted).length;
    // Duplicate CLUSTERS, not flagged assets: group every asset carrying a
    // phash by that hash and count the groups with more than one member —
    // the same grouping `duplicateHint` is derived from (timeline-model.ts),
    // just reported as clusters instead of collapsed to a per-asset boolean.
    const phashGroups = new Map<string, number>();
    for (const asset of assets) {
      if (!asset.phash) continue;
      phashGroups.set(asset.phash, (phashGroups.get(asset.phash) ?? 0) + 1);
    }
    const clusterCount = [...phashGroups.values()].filter(
      (count) => count > 1
    ).length;
    return {
      ...(shareTargetId
        ? { sharing: String(sharedAssets(assets, shareTargetId).length) }
        : {}),
      favorites: String(favoritesCount),
      trash: `${trashCount} · purged in 30 days`,
      places: String(places.rows.length),
      duplicates: `${clusterCount} cluster${clusterCount === 1 ? "" : "s"}`,
    };
  }, [assets, places.rows.length, shareTargetId]);
}

export default function PhotosMoreSheet({
  visible,
  onClose,
  onSelect,
}: PhotosMoreSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const meta = useMoreRowMeta();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onClose}
        style={[styles.scrim, { backgroundColor: colors.scrim }]}
      />
      <View
        style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
        accessibilityViewIsModal
      >
        <View style={styles.head}>
          <Text style={styles.headTitle}>More in Photos</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={onClose}
            style={styles.closeButton}
          >
            <Icon name="X" size={16} color={colors.text} />
          </Pressable>
        </View>
        {PHOTOS_MORE_ROWS.map((row) => {
          const rowMeta = meta[row.key] ?? row.meta;
          return (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              accessibilityLabel={
                rowMeta ? `${row.label}. ${rowMeta}` : row.label
              }
              onPress={() => onSelect(row.key)}
              style={styles.row}
            >
              <Icon name={row.icon} size={16} color={colors.textFaint} />
              <Text style={styles.rowLabel}>{row.label}</Text>
              {rowMeta ? <Text style={styles.rowMeta}>{rowMeta}</Text> : null}
            </Pressable>
          );
        })}
        <Text style={styles.foot}>{PHOTOS_MORE_FOOT}</Text>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    closeButton: {
      alignItems: "center",
      borderColor: colors.line,
      borderRadius: radii.md,
      borderWidth: borders.hairline,
      height: 34,
      justifyContent: "center",
      width: 34,
    },
    foot: {
      ...t("mono"),
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      color: colors.textFaint,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    head: {
      alignItems: "center",
      flexDirection: "row",
      paddingBottom: 12,
      paddingHorizontal: 16,
    },
    headTitle: {
      ...t("smallStrong"),
      color: colors.text,
      flex: 1,
    },
    row: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: 12,
      minHeight: 44,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    rowLabel: {
      color: colors.text,
      flex: 1,
      fontFamily: family.sansRegular,
      fontSize: 13,
      lineHeight: 18,
    },
    rowMeta: { ...t("mono"), color: colors.textFaint },
    scrim: { ...StyleSheet.absoluteFill },
    sheet: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      borderWidth: borders.hairline,
      bottom: 0,
      insetInlineEnd: 0,
      insetInlineStart: 0,
      paddingTop: 10,
      position: "absolute",
    },
  });
