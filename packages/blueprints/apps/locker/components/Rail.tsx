import type { ReactNode } from "react";

import { NavRail } from "../../_shared/NavRail.tsx";
import type { NavRailItem } from "../../_shared/NavRail.tsx";
import { needsReview } from "../format.ts";
import { ACCESS, FILL, GEN, IMPORT, TRASH, WATCH } from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type { ItemFilter, LockerItemType, LockerRow } from "../types.ts";
import {
  RAIL_ALL,
  RAIL_ARCHIVED,
  RAIL_HEADS,
  RAIL_REVIEW,
  RAIL_STARRED,
  TYPE_ORDER,
  TYPE_PLURAL,
} from "../view-copy.ts";

export interface RailProps {
  shelf: ShelfId;
  filter: ItemFilter;
  rows: readonly LockerRow[];
  typeCounts: Readonly<Record<LockerItemType, number>>;
  trashCount: number;
  archivedCount: number;
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
    {
      kind: "row",
      id: String(WATCH),
      label: RAIL_REVIEW,
      count: props.rows.filter(needsReview).length,
      current: props.shelf === WATCH,
      onSelect: () => props.onGo(WATCH),
    },
    filterRow("archived", RAIL_ARCHIVED, props.archivedCount, {
      kind: "archived",
    }),
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
