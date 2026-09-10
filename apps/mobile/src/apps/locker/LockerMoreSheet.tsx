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
import { Pressable, StyleSheet, View } from "react-native";

import {
  MORE_FOOT,
  MORE_TITLE,
} from "@centraid/blueprints/apps/locker/route-copy";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import { SheetRoom } from "../../kit/rooms";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { LOCKER_MORE_ROWS } from "./locker-band";
import type { LockerMoreRowKey } from "./locker-band";

/** What a row whose act lives on another seat says instead of a count. */
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
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <SheetRoom onClose={onClose} title={MORE_TITLE} visible={visible}>
      <View>
        {LOCKER_MORE_ROWS.map((row) => (
          <Pressable
            accessibilityLabel={`${row.label}. ${row.meta}`}
            accessibilityRole="button"
            key={row.key}
            onPress={() => onSelect(row.key)}
            style={styles.row}
          >
            <Icon color={colors.textFaint} name={row.icon} size={16} />
            <Text style={styles.rowLabel}>{row.label}</Text>
            <Text style={styles.rowMeta}>
              {row.reach === "here" ? row.meta : ELSEWHERE}
            </Text>
          </Pressable>
        ))}
        <Text style={styles.foot}>{MORE_FOOT}</Text>
      </View>
    </SheetRoom>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    foot: {
      ...t("small"),
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      color: colors.textFaint,
      paddingVertical: spacing[3],
    },
    row: {
      alignItems: "center",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      flexDirection: "row",
      gap: spacing[3],
      minHeight: 44,
      paddingVertical: spacing[2],
    },
    rowLabel: { ...t("small"), color: colors.text, flex: 1 },
    rowMeta: { ...t("small"), color: colors.textFaint },
  });
