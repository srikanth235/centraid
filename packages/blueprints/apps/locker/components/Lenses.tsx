// THE TOOL ROW'S LENSES.
//
// The SAME filters the rail's rows carry, drawn as chips — so a narrow surface
// that withdrew the 232px column does not lose half of its navigation with it.
// An app with a rail must still work without one; a destination that exists
// only in the rail is a defect.
//
// `flex: none` on the scroller, never `flex: 1` (v17 defect #1): a chip row
// that grew inside a nowrap tool row eats the count beside it.
import type { ReactElement } from "react";

import type { ItemFilter } from "../types.ts";
import {
  RAIL_ALL,
  RAIL_STARRED,
  TYPE_ORDER,
  TYPE_PLURAL,
} from "../view-copy.ts";

import styles from "./Rows.module.css";

/** Is this lens the one the member is standing in? */
export function isCurrentLens(filter: ItemFilter, value: ItemFilter): boolean {
  if (value.kind !== filter.kind) return false;
  if (value.kind === "type") {
    return filter.kind === "type" && filter.type === value.type;
  }
  if (value.kind === "tag") {
    return filter.kind === "tag" && filter.tag === value.tag;
  }
  return true;
}

/** Everything, Starred, and the six types — the rail's rows, in a row. */
export function lensesFor(): Array<{
  key: string;
  label: string;
  value: ItemFilter;
}> {
  return [
    { key: "all", label: RAIL_ALL, value: { kind: "all" } },
    { key: "starred", label: RAIL_STARRED, value: { kind: "starred" } },
    ...TYPE_ORDER.map((type) => ({
      key: `type:${type}`,
      label: TYPE_PLURAL[type],
      value: { kind: "type", type } as ItemFilter,
    })),
  ];
}

export function Lenses({
  filter,
  onFilter,
}: {
  filter: ItemFilter;
  onFilter: (filter: ItemFilter) => void;
}): ReactElement {
  return (
    <span className={styles.lenses}>
      {lensesFor().map((lens) => (
        <button
          key={lens.key}
          type="button"
          className="kit-chip quiet"
          aria-pressed={isCurrentLens(filter, lens.value)}
          onClick={() => onFilter(lens.value)}
        >
          {lens.label}
        </button>
      ))}
    </span>
  );
}
