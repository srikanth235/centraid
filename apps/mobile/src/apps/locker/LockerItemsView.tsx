// ITEMS — `locker` (README-Locker §1, §4, §6).
//
// THE LIST IS METADATA AND IT SAYS SO. `ITEMS_STATUS` is the app bar's ambient
// sentence (`LockerScreen.tsx` draws it from `ROUTE_STATUS`), and every row
// here is the secret-free shape the `items` query returns. There is no path by
// which a `LockerDetail` becomes one of these.
//
// THE WINDOW HAS AN HONEST END. `windowEndCopy` states what it is showing and
// that older items exist beyond it; *Show more* widens the ask by one page,
// capped at the query's own ceiling of 2,000. The design's exact "300 of 312"
// needs a total the items payload does not carry — see `lockerWindowFoot`.
//
// LOADING IS SKELETON ROWS at the list's own geometry, never a spinner.

import React, { useMemo } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { ListRenderItemInfo } from "react-native";

import { rowsFor, typeCounts } from "@centraid/blueprints/apps/locker/format";
import type {
  ItemFilter,
  LockerRow as LockerRowData,
} from "@centraid/blueprints/apps/locker/types";
import {
  DAY_ONE_ADD,
  DAY_ONE_BODY,
  DAY_ONE_IMPORT,
  DAY_ONE_TITLE,
  NEW_ITEM,
  NO_MATCH,
  RAIL_ALL,
  RAIL_REVIEW,
  RAIL_STARRED,
  SHOW_MORE,
  TYPE_ORDER,
  TYPE_PLURAL,
} from "@centraid/blueprints/apps/locker/view-copy";

import Button from "../../kit/components/Button";
import ChipsBlock from "../../kit/components/ChipsBlock";
import type { ChipDef } from "../../kit/components/ChipsBlock";
import EmptyBlock from "../../kit/components/EmptyBlock";
import { Text } from "../../kit/components/NativeText";
import SkeletonRows from "../../kit/components/SkeletonRows";
import { borders, spacing, t, useTheme } from "../../kit/theme";
import type { ThemeColors } from "../../kit/theme";
import { DEVICE_ENROL, DEVICE_OFFER, DEVICE_NOTE } from "./locker-seat-copy";
import type { LockerScreenState } from "./locker-view-model";
import { lockerWindowFoot } from "./locker-view-model";
import LockerNotice from "./LockerNotice";
import { LockerRow, lockerRowKey } from "./LockerRow";

export interface LockerItemsViewProps {
  rows: readonly LockerRowData[];
  filter: ItemFilter;
  onFilter: (filter: ItemFilter) => void;
  state: LockerScreenState;
  pending: number;
  waiting?: string | null;
  loaded: boolean;
  truncated: boolean;
  /** The device-credential offer, present only where this phone can hold one
   *  and does not yet. Enrolling needs an open session, which is why the offer
   *  cannot live on the lock wall that asks for one. */
  offerDevice: boolean;
  onEnrolDevice: () => void;
  onShowMore: () => void;
  onOpen: (row: LockerRowData) => void;
  onNew: () => void;
  onImport: () => void;
}

/** The filter chips: the rail's three rows, then every `TYPE_ORDER` type with
 *  its count — never a list of types kept here.
 *  A zero is drawn as a zero — a type with nothing in it is a fact. */
function filterChips(
  rows: readonly LockerRowData[],
  filter: ItemFilter,
  onFilter: (next: ItemFilter) => void
): readonly ChipDef[] {
  const counts = typeCounts(rows);
  return [
    {
      id: "all",
      label: RAIL_ALL,
      on: filter.kind === "all",
      onPress: () => onFilter({ kind: "all" }),
    },
    {
      id: "starred",
      label: RAIL_STARRED,
      on: filter.kind === "starred",
      onPress: () => onFilter({ kind: "starred" }),
    },
    {
      id: "review",
      label: RAIL_REVIEW,
      on: filter.kind === "review",
      onPress: () => onFilter({ kind: "review" }),
    },
    ...TYPE_ORDER.map((type) => ({
      id: `type:${type}`,
      label: `${TYPE_PLURAL[type]} ${String(counts[type])}`,
      on: filter.kind === "type" && filter.type === type,
      onPress: () => onFilter({ kind: "type", type }),
    })),
  ];
}

export default function LockerItemsView(
  props: LockerItemsViewProps
): React.JSX.Element {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const shown = useMemo(
    () => rowsFor(props.rows, props.filter),
    [props.rows, props.filter]
  );
  const foot = lockerWindowFoot(props.loaded, shown.length, props.truncated);

  const renderItem = ({
    item,
  }: ListRenderItemInfo<LockerRowData>): React.JSX.Element => (
    <LockerRow row={item} onOpen={props.onOpen} />
  );

  const head = (
    <View style={styles.head}>
      <ChipsBlock
        accessibilityLabel="Filter the window"
        chips={filterChips(props.rows, props.filter, props.onFilter)}
      />
      <LockerNotice
        state={props.state}
        pending={props.pending}
        waiting={props.waiting ?? null}
      />
      {props.offerDevice ? (
        <View style={styles.offer}>
          <Text style={styles.offerTitle}>{DEVICE_OFFER}</Text>
          <Text style={styles.offerBody}>{DEVICE_NOTE}</Text>
          <Button label={DEVICE_ENROL} onPress={props.onEnrolDevice} />
        </View>
      ) : null}
      <View style={styles.acts}>
        <Button label={NEW_ITEM} onPress={props.onNew} variant="primary" />
      </View>
    </View>
  );

  if (props.state === "loading") {
    return (
      <View style={styles.page}>
        <SkeletonRows accessibilityLabel="Reading the item window" />
      </View>
    );
  }

  if (props.state === "dayone") {
    return (
      <View style={styles.page}>
        <EmptyBlock
          title={DAY_ONE_TITLE}
          body={DAY_ONE_BODY}
          action={{ label: DAY_ONE_ADD, onPress: props.onNew }}
          action2={{ label: DAY_ONE_IMPORT, onPress: props.onImport }}
        />
      </View>
    );
  }

  return (
    <FlatList
      data={shown}
      keyExtractor={lockerRowKey}
      ListHeaderComponent={head}
      ListEmptyComponent={<Text style={styles.noMatch}>{NO_MATCH}</Text>}
      ListFooterComponent={
        foot ? (
          <View style={styles.foot}>
            <Text style={styles.footText}>{foot}</Text>
            {props.truncated ? (
              <Button label={SHOW_MORE} onPress={props.onShowMore} />
            ) : null}
          </View>
        ) : null
      }
      // A 56pt row means ~12 fill the viewport below the app bar; ±3 viewports
      // of retained cells absorbs a fast flick without keeping 300 mounted.
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      renderItem={renderItem}
      windowSize={7}
    />
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    acts: { flexDirection: "row", paddingHorizontal: spacing[4] },
    foot: {
      alignItems: "flex-start",
      borderTopColor: colors.line,
      borderTopWidth: borders.hairline,
      gap: spacing[3],
      padding: spacing[4],
    },
    footText: { ...t("mono"), color: colors.textFaint },
    head: { gap: spacing[3], paddingTop: spacing[2] },
    noMatch: {
      ...t("small"),
      color: colors.textFaint,
      padding: spacing[4],
    },
    offer: {
      borderColor: colors.line,
      borderWidth: borders.hairline,
      gap: spacing[2],
      marginHorizontal: spacing[4],
      padding: spacing[3],
    },
    offerBody: { ...t("mono"), color: colors.textFaint },
    offerTitle: { ...t("smallStrong"), color: colors.text },
    page: { flex: 1, padding: spacing[4] },
  });
