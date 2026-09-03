import type { ReactElement } from "react";

import type { ItemFilter } from "../types.ts";
import {
  RAIL_ALL,
  RAIL_STARRED,
  TYPE_ORDER,
  TYPE_PLURAL,
} from "../view-copy.ts";

import styles from "./Rows.module.css";

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
