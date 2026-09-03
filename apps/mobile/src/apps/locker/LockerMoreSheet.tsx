// "More in Locker" — the band's fifth slot (README-Locker §1).
//
// Five rows, in the shared sheet's own order, with the shared table's labels
// and meta (`route-copy.ts` `SURFACE_TITLE` / `SURFACE_META`), so the sheet
// cannot drift from what the desktop rail calls the same surfaces.
//
// FOUR OF THEM ARE ROUTES HERE AND ONE IS NOT, and the sheet says which.
// Companion runs in a browser extension, beside the page, so its row says
// `elsewhere` in place of a count — and still leads somewhere, to a screen that
// states what the surface is and where the act happens, because a greyed row
// teaches that Companion is broken rather than that it lives in the browser.
import React, { useMemo } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  MORE_CLOSE,
  MORE_FOOT,
  MORE_TITLE,
} from "@centraid/blueprints/apps/locker/route-copy";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { borders, radii, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { LOCKER_MORE_ROWS } from "./locker-band";
import type { LockerMoreRowKey } from "./locker-band";

const ELSEWHERE = "elsewhere";

export interface LockerMoreSheetProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (key: LockerMoreRowKey) => void;
}

export default function LockerMoreSheet({
  visible,
  onClose,
  onSelect,
}: LockerMoreSheetProps): React.JSX.Element {
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
        accessibilityLabel={MORE_CLOSE}
        onPress={onClose}
        style={[styles.scrim, { backgroundColor: colors.scrim }]}
      />
      <View
        style={[styles.sheet, { paddingBottom: insets.bottom + spacing[3] }]}
        accessibilityViewIsModal
      >
        <View style={styles.head}>
          <Text style={styles.headTitle}>{MORE_TITLE}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={MORE_CLOSE}
            onPress={onClose}
            style={styles.closeButton}
          >
            <Icon name="X" size={16} color={colors.text} />
          </Pressable>
        </View>
        {LOCKER_MORE_ROWS.map((row) => (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityLabel={`${row.label}. ${row.meta}`}
            onPress={() => onSelect(row.key)}
            style={styles.row}
          >
            <Icon name={row.icon} size={16} color={colors.textFaint} />
            <Text style={styles.rowLabel}>{row.label}</Text>
            <Text style={styles.rowMeta}>
              {row.reach === "here" ? row.meta : ELSEWHERE}
            </Text>
          </Pressable>
        ))}
        <Text style={styles.foot}>{MORE_FOOT}</Text>
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
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[3],
    },
    head: {
      alignItems: "center",
      flexDirection: "row",
      paddingBottom: spacing[3],
      paddingHorizontal: spacing[4],
    },
    headTitle: { ...t("smallStrong"), color: colors.text, flex: 1 },
    row: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      minHeight: 44,
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[2],
    },
    rowLabel: { ...t("small"), color: colors.text, flex: 1 },
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
      paddingTop: spacing[2],
      position: "absolute",
    },
  });
