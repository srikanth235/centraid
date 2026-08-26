// The More sheet (Photos v4 handoff §3.1, §H): the band caps at five
// destinations, so only Backup lives here. NO import row (see photos-band.ts);
// tile size belongs to the Library header menu, not this sheet.

import React, { useMemo } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, radii, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { PHOTOS_MORE_FOOT, PHOTOS_MORE_ROWS } from "./photos-band";
import type { PhotosMoreRowKey } from "./photos-band";

export interface PhotosMoreSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (key: PhotosMoreRowKey) => void;
}

/*
 * NO META MAP HERE: no live counts derived in this file. Collections states
 * counts beside the same shelves; Backup deliberately carries no meta — its
 * figure needs a network round trip this sheet must not make.
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
      ...t("small"),
    },
    rowMeta: { ...t("mono"), color: colors.textFaint },
    scrim: { ...StyleSheet.absoluteFill },
    sheet: {
      backgroundColor: colors.bgElev,
      borderColor: colors.line,
      borderTopLeftRadius: radii.lg,
      borderTopRightRadius: radii.lg,
      borderWidth: borders.hairline,
      bottom: 0,
      insetInlineEnd: 0,
      insetInlineStart: 0,
      paddingTop: 10,
      position: "absolute",
    },
  });
