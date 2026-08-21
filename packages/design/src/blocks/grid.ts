// The records GRID's logic (#775) — the block that shows a kind as the store
// holds it, every declared column of every record.
//
// `DocTable` is the same data read as DOCUMENTS: three columns, one row per
// record, a title and two facts. That is the right block for a drive and the
// wrong one for a vault census, where the question is "what is actually IN
// this column" — and the answer has to distinguish a column the store has no
// value for from one holding the empty string, and has to refuse to print a
// sealed value at all. Those distinctions are the whole point of the block, so
// they live here rather than in either kit: a renderer that classified cells
// for itself would be free to collapse two of them, which is exactly what a
// three-column summary did.
//
// Renderer-free, like every module beside it. What a `null` cell LOOKS like is
// a DOM class on one seat and a native style on the other; that it IS a null
// and not a blank is neither.

import type { GridColumnData, GridSortData } from "./contracts";

/**
 * Where a value stops being a cell and becomes a paragraph.
 *
 * A grid row is one line high, so a long value has to be cut somewhere and the
 * cut has to be reversible — hence `clipped`, which is the block telling a
 * renderer to offer the expansion rather than silently truncating. 48 is the
 * reference's figure and it is here rather than in a stylesheet because both
 * seats must clip at the same place: a value that is short on one surface and
 * elided on the other is two different answers to "what does this record say".
 */
export const GRID_CLIP_AT = 48;

/**
 * What a cell IS, before anything decides how it looks.
 *
 *  * `value`   — the store holds something and it is printable.
 *  * `null`    — the store holds NO value. Distinct from `blank`, and the
 *                distinction is load-bearing: a nullable column with no value
 *                and a text column holding "" are different facts about the
 *                record, and only one of them is a gap.
 *  * `blank`   — the store holds the empty string.
 *  * `sealed`  — the store will not say. Never carries text; the masking
 *                sentinel is not a value to be printed shorter.
 */
export type GridCellKind = "value" | "null" | "blank" | "sealed";

/** One cell, classified and cut. */
export interface GridCell {
  kind: GridCellKind;
  /** The whole value as text. Empty for every kind but `value`. */
  text: string;
  /** `text` cut to {@link GRID_CLIP_AT}, with an ellipsis when it was cut. */
  short: string;
  /** Whether `short` is shorter than `text` — the renderer's cue to offer the
   *  expansion. */
  clipped: boolean;
}

/** Render any cell scalar as text. Objects are their JSON: a grid over a store
 *  shows what the store holds, and `[object Object]` is not that. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Classify one cell.
 *
 * `sealed` wins over everything, including absence: a sealed column whose row
 * happens to hold no value must still not advertise which rows are empty.
 */
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

/**
 * The next sort after a member asks for a column.
 *
 * Ascending first, every time, and only a SECOND ask on the same column turns
 * it round. A header that remembered the previous column's direction would
 * answer one click with a different order depending on where you had been.
 */
export function gridSortNext(
  current: GridSortData | null | undefined,
  key: string
): GridSortData {
  if (current?.key === key && current.dir === "asc")
    return { dir: "desc", key };
  return { dir: "asc", key };
}

/** Which way this column is ordered, or `null` when the grid is ordered by
 *  another one. The renderer turns it into an arrow and a sort state. */
export function gridSortOf(
  sort: GridSortData | null | undefined,
  key: string
): "asc" | "desc" | null {
  return sort?.key === key ? sort.dir : null;
}

/**
 * A column's key badges, in reference order.
 *
 * The header is where these belong. A badge repeated on every cell of a
 * thousand-row column is noise; stated once above them it is the column's
 * declaration, which is what it actually is.
 */
export function gridColumnBadges(
  column: GridColumnData
): readonly ("pk" | "fk")[] {
  const badges: ("pk" | "fk")[] = [];
  if (column.pk) badges.push("pk");
  if (column.fk) badges.push("fk");
  return badges;
}

/**
 * What a foreign-key column points at, as the string a header hint carries.
 *
 * `fk` alone says a column is a reference; without the target it does not say
 * a reference to WHAT, which is the only part a member cannot work out from
 * the value.
 */
export function gridColumnHint(column: GridColumnData): string | undefined {
  return column.fk ? `→ ${column.fk}` : undefined;
}

/** Whether a header is a control at all: a column the store cannot order by
 *  draws its label and nothing else. */
export function gridColumnSortable(column: GridColumnData): boolean {
  return !column.fixed;
}
