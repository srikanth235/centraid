// THE ONE VIRTUALISED LIST ON THIS SEAT (#922 E6).
//
// Five surfaces window a bounded replica read — the People roster, the Docs
// drive, the Tally ledger, the Locker item window and the Notes places — and
// each of them used to carry its own list: two hand-wired `FlashList`s, one
// `FlatList` with its own windowing constants, and four `ScrollView` + `.map()`
// bodies that mounted every row a read returned. Once #922 0a/E2 stopped
// capping those reads at 1,000 rows silently, the `.map()` bodies became a
// year-3 roster mounted whole. One primitive is what keeps the five honest
// together: a row budget tuned once, an anchoring contract that cannot be
// inherited, and one accessible list container.
//
// ANCHORING IS A REQUIRED PROP, never a default. FlashList v2 anchors visible
// content by default and every seat here sorts newest first, so a row arriving
// from another device is inserted above the fold and drawn out of sight
// (docs/traps/list-anchoring.md). `scripts/lint-list-anchoring.mjs` holds that
// line for a hand-written FlashList tag; here the type does, which is the
// stronger rung — and it is why this file is the only tag left on five seats.

import { FlashList } from "@shopify/flash-list";
import React, { useCallback } from "react";
import type { StyleProp, ViewStyle } from "react-native";

import type { ListAnchoring } from "./list-anchoring";

export interface SeatListProps<Row> {
  rows: readonly Row[];
  keyOf: (row: Row, index: number) => string;
  renderRow: (row: Row, index: number) => React.ReactElement | null;
  /** Stated at the call site: a default here is exactly the inheritance the
   *  trap above forbids, and a wrong one loses rows without a word. */
  anchoring: ListAnchoring;
  /** What a screen reader calls this list. */
  accessibilityLabel: string;
  /** Drawn above the rows and scrolled with them — chips, a search field, a
   *  notice. A header outside the list would pin chrome no reader asked to
   *  keep, and a second scroller around a virtualised list measures nothing. */
  header?: React.ReactElement | null;
  footer?: React.ReactElement | null;
  /** Shown INSTEAD of the rows when there are none; the header and footer
   *  still draw, because "no match" is a state of a list, not its absence. */
  empty?: React.ReactElement | null;
  columns?: number;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

export default function SeatList<Row>({
  rows,
  keyOf,
  renderRow,
  anchoring,
  accessibilityLabel,
  header,
  footer,
  empty,
  columns,
  contentContainerStyle,
}: SeatListProps<Row>): React.JSX.Element {
  const renderItem = useCallback(
    ({ item, index }: { item: Row; index: number }) => renderRow(item, index),
    [renderRow]
  );
  const keyExtractor = useCallback(
    (item: Row, index: number) => keyOf(item, index),
    [keyOf]
  );
  return (
    <FlashList
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="list"
      maintainVisibleContentPosition={anchoring}
      data={rows as Row[]}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={empty}
      {...(columns === undefined ? {} : { numColumns: columns })}
      {...(contentContainerStyle === undefined
        ? {}
        : { contentContainerStyle })}
    />
  );
}
