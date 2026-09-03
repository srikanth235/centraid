import React, { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { docRowMenu } from "@centraid/design/blocks";
import type {
  DocRowActionLabels,
  DocRowMenuItem,
} from "@centraid/design/blocks";

import { useTheme } from "../theme";
import type { ThemeColors } from "../theme";
import AnchoredMenu, { useMenuAnchor } from "./AnchoredMenu";
import type { MenuGroup } from "./AnchoredMenu";
import { snipLine } from "./doc-table-model";
import type { DocRecord, DocRowAction } from "./doc-table-model";
import { styles } from "./DocTable.styles";
import Icon from "./Icon";
import { Text } from "./NativeText";

export interface DocTableCopy extends DocRowActionLabels {
  more: (title: string) => string;
}

export interface DocTableProps {
  records: readonly DocRecord[];
  copy: DocTableCopy;
  onRowAction: (record: DocRecord, action: DocRowAction) => void;
  caption?: string;
  accessibilityLabel?: string;
  moreIcon?: string;
}

const MORE_GLYPH = 16;

function DocTableRow({
  record,
  copy,
  colors,
  first,
  moreIcon,
  onRowAction,
}: {
  record: DocRecord;
  copy: DocTableCopy;
  colors: ThemeColors;
  first: boolean;
  moreIcon: string;
  onRowAction: (record: DocRecord, action: DocRowAction) => void;
}): React.JSX.Element {
  const { anchor, anchorRef, measureAnchor } = useMenuAnchor();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const press = useCallback(() => {
    measureAnchor();
    setOpen(true);
  }, [measureAnchor]);

  const groups = useMemo<readonly MenuGroup[]>(() => {
    const menu = docRowMenu(copy);
    const rowsFor = (
      items: readonly DocRowMenuItem[],
      destructive: boolean
    ): MenuGroup["rows"] =>
      items.map((item) => ({
        ...(destructive ? { destructive } : {}),
        key: item.action,
        label: item.label,
        onSelect: () => onRowAction(record, item.action),
      }));
    return [
      { key: "record", rows: rowsFor(menu.record, false) },
      ...(menu.danger.length > 0
        ? [{ key: "danger", rows: rowsFor(menu.danger, true) }]
        : []),
    ];
  }, [copy, onRowAction, record]);

  const snip = snipLine(record);
  return (
    <View
      style={[
        styles.row,
        { borderTopColor: colors.line },
        first ? styles.rowFirst : undefined,
      ]}
    >
      <View style={styles.text}>
        <Text
          ellipsizeMode="tail"
          numberOfLines={1}
          style={[styles.title, { color: colors.text }]}
        >
          {record.title}
        </Text>
        {snip ? (
          <Text
            ellipsizeMode="tail"
            numberOfLines={1}
            style={[styles.snip, { color: colors.textFaint }]}
          >
            {snip}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityLabel={copy.more(record.title)}
        accessibilityRole="button"
        onPress={press}
        ref={anchorRef}
        style={styles.more}
      >
        <Icon color={colors.textFaint} name={moreIcon} size={MORE_GLYPH} />
      </Pressable>
      <AnchoredMenu
        anchor={anchor}
        groups={groups}
        onClose={close}
        visible={open}
      />
    </View>
  );
}

export default function DocTable({
  records,
  copy,
  onRowAction,
  caption,
  accessibilityLabel,
  moreIcon = "more-horizontal",
}: DocTableProps): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="list"
      style={[
        styles.table,
        { backgroundColor: colors.bgElev, borderColor: colors.line },
      ]}
    >
      {records.map((record, index) => (
        <DocTableRow
          colors={colors}
          copy={copy}
          first={index === 0}
          key={record.key}
          moreIcon={moreIcon}
          onRowAction={onRowAction}
          record={record}
        />
      ))}
      {caption ? (
        <View style={[styles.captionRow, { borderTopColor: colors.line }]}>
          <Text style={[styles.caption, { color: colors.textFaint }]}>
            {caption}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
