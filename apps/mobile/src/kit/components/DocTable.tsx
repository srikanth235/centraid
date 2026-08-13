// DOC TABLE — records, in the one form this surface has (#765, spec §9/§11).
//
// The reference's table has a column header and two fixed columns, and hides
// ALL THREE at phone width (`showHead: !mob`, `display:none` on Kind and
// Written). This app is always at phone width, so there is no `showHead` prop
// and no wide branch to keep honest: the collapsed form IS the table here. A
// record is its title over one annotation line carrying what the two hidden
// columns held (./doc-table-model#snipLine), and the row grows to 52 to hold
// the second line rather than tightening its leading.
//
// The trailing control is a 44×44 overflow button opening the kit's own
// `AnchoredMenu` — which already hangs its card off the TRAILING edge of the
// control it was measured from, so the geometry the reference specifies
// (`inset-inline-end: 0`) is the one this gets for free, mirrored under RTL.
// Every menu word, including the button's own label, is the caller's.

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

/** The overflow menu's words. There are no defaults: a kit block that shipped
 *  its own copy would be the one place in this app where a string has no
 *  author.
 *
 *  `edit` and `delete` are OPTIONAL, and a menu given neither honestly carries
 *  two items — a screen whose surface cannot yet edit or delete a record says
 *  so by omitting the verb, not by listing one that does nothing. */
export interface DocTableCopy extends DocRowActionLabels {
  /** The overflow button's accessibility label, e.g. `More for ${title}`. */
  more: (title: string) => string;
}

export interface DocTableProps {
  records: readonly DocRecord[];
  copy: DocTableCopy;
  onRowAction: (record: DocRecord, action: DocRowAction) => void;
  /** The sentence under the table — how many of how many, and in what order. */
  caption?: string;
  accessibilityLabel?: string;
  /** The glyph on the overflow control. */
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
  // One anchor per ROW, not one per table: the card hangs off the button that
  // was pressed, and a shared anchor would open every menu beside the first
  // row that happened to measure itself.
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
      // Its own group, so the rule above it is the separation the reference
      // draws — a delete never sits one thumb-width from "Copy the id". A
      // caller that named no delete gets no group and no rule.
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
