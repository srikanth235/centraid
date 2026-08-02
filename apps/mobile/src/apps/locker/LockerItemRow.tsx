// One row of the unlocked Locker list.
//
// Extracted so the screen file is the unlock/session lifecycle and this is the
// cell. Both halves of the memo contract live here: the row is memoized, and
// `onOpen` takes the row rather than a pre-bound closure so every row can share
// one stable callback — a per-row arrow would defeat the memo.

import React, { memo } from "react";
import { Pressable, View } from "react-native";

import Icon from "../../kit/components/Icon";
import { Text } from "../../kit/components/NativeText";
import type { useTheme } from "../../kit/theme";
import type { makeLockerStyles } from "./LockerHome.styles";
import type { LockerRow } from "./LockerHome.types";

// `item_id` is the Locker item's vault identity, so it is already unique.
export const lockerItemKey = (item: LockerRow): string => item.item_id;

// `onOpen` takes the row rather than a pre-bound closure so every row can share
// one stable callback — a per-row arrow would defeat the memo.
export const LockerItemRow = memo(
  ({
    row,
    styles,
    colors,
    onOpen,
  }: {
    row: LockerRow;
    styles: ReturnType<typeof makeLockerStyles>;
    colors: ReturnType<typeof useTheme>["colors"];
    onOpen: (row: LockerRow) => Promise<void>;
  }): React.JSX.Element => (
    <Pressable
      accessibilityRole="button"
      onPress={() => void onOpen(row)}
      style={styles.row}
    >
      <View style={styles.rowIcon}>
        <Icon name="Key" size={18} color={colors.textSoft} />
      </View>
      <View style={styles.rowCopy}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {row.title}
        </Text>
        <Text numberOfLines={1} style={styles.rowSubtitle}>
          {row.subtitle}
        </Text>
      </View>
      <Icon name="ChevronRight" size={16} color={colors.textFaint} />
    </Pressable>
  )
);
LockerItemRow.displayName = "LockerItemRow";
