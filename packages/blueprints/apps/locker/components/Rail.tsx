// THE 232px RAIL (README-Locker §1), on a wide pointer surface only.
//
// THREE GROUPS, because the rail holds three different kinds of thing and the
// difference is the navigational idea of the app: *The vault* is the set and
// its two lenses, *Types* is what an item IS, and *Acts* are surfaces rather
// than places. A rail that listed all twelve under one silent head would be
// asking a member to work out why Wi-Fi and Trash are neighbours.
//
// The rail is `_shared/NavRail.tsx` — the same component Photos and Docs draw,
// so the roving tab stop, the count register and the current row are the
// product's rather than this app's. This file is only the ROWS.
//
// Counts are facts, not badges: bare integers in the numeric register beside a
// label, never a coloured pip, and a zero is drawn as a zero rather than
// hidden — a type with nothing in it is a fact about the vault.
import type { ReactNode } from "react";

import { NavRail } from "../../_shared/NavRail.tsx";
import type { NavRailItem } from "../../_shared/NavRail.tsx";
import { needsReview } from "../format.ts";
import { ACCESS, FILL, GEN, IMPORT, TRASH, WATCH } from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type { ItemFilter, LockerItemType, LockerRow } from "../types.ts";
import {
  RAIL_ALL,
  RAIL_HEADS,
  RAIL_REVIEW,
  RAIL_STARRED,
  TYPE_ORDER,
  TYPE_PLURAL,
} from "../view-copy.ts";

export interface RailProps {
  /** The route the member is standing on. */
  shelf: ShelfId;
  /** Which slice of the window Items is showing. */
  filter: ItemFilter;
  /** The whole window, for the three counts at the top and the six below. */
  rows: readonly LockerRow[];
  typeCounts: Readonly<Record<LockerItemType, number>>;
  trashCount: number;
  onFilter: (filter: ItemFilter) => void;
  onGo: (shelf: ShelfId) => void;
}

export function Rail(props: RailProps): ReactNode {
  const onItems = props.shelf === null;
  const filterRow = (
    id: string,
    label: string,
    count: number,
    filter: ItemFilter,
    indent = false
  ): NavRailItem => ({
    kind: "row",
    id,
    label,
    count,
    current:
      onItems &&
      props.filter.kind === filter.kind &&
      (filter.kind !== "type" ||
        (props.filter.kind === "type" && props.filter.type === filter.type)),
    indent,
    onSelect: () => props.onFilter(filter),
  });

  const actRow = (
    shelf: ShelfId,
    label: string,
    count?: number
  ): NavRailItem => ({
    kind: "row",
    id: String(shelf),
    label,
    ...(count === undefined ? {} : { count }),
    current: props.shelf === shelf,
    onSelect: () => props.onGo(shelf),
  });

  const items: NavRailItem[] = [
    { kind: "head", label: RAIL_HEADS.vault },
    filterRow("all", RAIL_ALL, props.rows.length, { kind: "all" }),
    filterRow(
      "starred",
      RAIL_STARRED,
      props.rows.filter((row) => row.favorite).length,
      { kind: "starred" }
    ),
    // Review is a ROUTE, not a lens: it draws two registers of its own — the
    // verdicts, and the checks that cannot honestly run — so it goes to
    // `locker/watch` rather than filtering the list in place.
    {
      kind: "row",
      id: String(WATCH),
      label: RAIL_REVIEW,
      count: props.rows.filter(needsReview).length,
      current: props.shelf === WATCH,
      onSelect: () => props.onGo(WATCH),
    },
    { kind: "rule" },
    { kind: "head", label: RAIL_HEADS.types },
    ...TYPE_ORDER.map((type) =>
      filterRow(
        `type:${type}`,
        TYPE_PLURAL[type],
        props.typeCounts[type] ?? 0,
        { kind: "type", type },
        true
      )
    ),
    { kind: "rule" },
    { kind: "head", label: RAIL_HEADS.acts },
    actRow(GEN, "Generator"),
    actRow(IMPORT, "Import"),
    actRow(ACCESS, "Access history"),
    actRow(FILL, "Companion"),
    actRow(TRASH, "Trash", props.trashCount),
  ];

  return <NavRail label="Locker" items={items} />;
}
