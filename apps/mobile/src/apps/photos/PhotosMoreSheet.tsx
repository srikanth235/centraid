// The More sheet (Photos v4 handoff §3.1, §H).
//
// The band is capped at five destinations, so the shelves that do not fit live
// here: Sharing, Favorites, Places, Duplicates, Trash, Backup. Import is the
// one handoff row this sheet still does NOT carry — see the comment on
// `PHOTOS_MORE_ROWS` (photos-band.ts) for why a missing row beats a lying one,
// and why Sharing came back in issue #712 while Import did not.
//
// It no longer carries **Tile size**. That stepper passed through here on its
// way from a permanent toolbar row (44 points over the timeline, for a
// preference a member sets rarely) to its present home — the Library's own
// header menu (`photos-library-menu.ts`, drawn as an anchored card by
// `kit/components/AnchoredMenu.tsx`), opened from the round control beside
// Select on `PhotosHome`'s header, iOS-Photos-style. It sits there now beside
// the other things that shape what the grid shows (the filter), which this
// sheet has no opinion about at all. This sheet is left with exactly one job:
// Backup, a cross-stack link that menu has no reason to carry.

import React, { useMemo } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, family, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { PHOTOS_MORE_FOOT, PHOTOS_MORE_ROWS } from "./photos-band";
import type { PhotosMoreRowKey } from "./photos-band";

export interface PhotosMoreSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (key: PhotosMoreRowKey) => void;
}

/*
 * NO META MAP HERE ANY MORE.
 *
 * This file used to derive live counts for five rows — favourites, trash,
 * duplicate clusters, places, shared — by reading the timeline, the place
 * table and the share target, so each row could carry the mono figure the
 * prototype puts beside it. All five of those rows are sections of
 * Collections now, where the same counts are stated beside the same shelves,
 * over the shelf's own covers. Deriving them twice meant two places that had
 * to agree about what a duplicate cluster is.
 *
 * Backup, the one row left, deliberately carries no meta: the figure it would
 * show comes from a network round trip and a durable-queue read this sheet has
 * no business making, and a placeholder number is the lie the meta map existed
 * to avoid.
 */

export default function PhotosMoreSheet({
  visible,
  onClose,
  onSelect,
}: PhotosMoreSheetProps): React.JSX.Element {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
          const rowMeta = row.meta;
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
