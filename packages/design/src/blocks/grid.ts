// Records GRID logic (#775): cells are classified here, never in a kit.

import type { GridColumnData, GridSortData } from "./contracts";

/** Both seats clip at the same place. */
export const GRID_CLIP_AT = 48;

/** `null` (no value) and `blank` ("") are different facts, only one a gap. */
export type GridCellKind = "value" | "null" | "blank" | "sealed";

export interface GridCell {
  kind: GridCellKind;
  text: string;
  short: string;
  clipped: boolean;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** `sealed` wins over absence: never advertise which rows are empty. */
export function gridCell(
  value: unknown,
  options: { sealed?: boolean; clipAt?: number } = {}
): GridCell {
  const blank: Omit<GridCell, "kind"> = {
    clipped: false,
    short: "",
    text: "",
  };
  if (options.sealed) return { ...blank, kind: "sealed" };
  if (value === null || value === undefined) return { ...blank, kind: "null" };
  const text = asText(value);
  if (text === "") return { ...blank, kind: "blank" };
  const clipAt = options.clipAt ?? GRID_CLIP_AT;
  const clipped = text.length > clipAt;
  return {
    clipped,
    kind: "value",
    short: clipped ? `${text.slice(0, clipAt)}…` : text,
    text,
  };
}

/** Ascending first; only a second ask on the same column reverses. */
export function gridSortNext(
  current: GridSortData | null | undefined,
  key: string
): GridSortData {
  if (current?.key === key && current.dir === "asc")
    return { dir: "desc", key };
  return { dir: "asc", key };
}

export function gridSortOf(
  sort: GridSortData | null | undefined,
  key: string
): "asc" | "desc" | null {
  return sort?.key === key ? sort.dir : null;
}

export function gridColumnBadges(
  column: GridColumnData
): readonly ("pk" | "fk")[] {
  const badges: ("pk" | "fk")[] = [];
  if (column.pk) badges.push("pk");
  if (column.fk) badges.push("fk");
  return badges;
}

export function gridColumnHint(column: GridColumnData): string | undefined {
  return column.fk ? `→ ${column.fk}` : undefined;
}

export function gridColumnSortable(column: GridColumnData): boolean {
  return !column.fixed;
}
