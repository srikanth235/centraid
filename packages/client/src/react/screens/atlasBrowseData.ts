// Pure row/state helpers for the Data route's records section (#441),
// split out of the component so it reads as UI, not plumbing.
// Nothing here touches React or the network — it classifies cell values and
// computes row identity from column metadata so the table, the editor and the
// delete flow agree on what "this row" means. The picker grouping went with the
// table picker itself (#765): the kinds list picks the kind now.

import type { BrowseColumn, BrowseDependent } from "../../gateway-client.js";

/**
 * The masked value a sealed column reads back as (#293/#298). The backend never
 * returns the plaintext; the grid styles this sentinel as a chip rather than
 * printing it, and the editor refuses to write it.
 */
export const SEALED_SENTINEL = "«sealed»";

/** True when a cell holds the sealed-column mask, never the real value. */
export function isSealedValue(value: unknown): boolean {
  return value === SEALED_SENTINEL;
}

/** Render any cell scalar as the string the grid shows (null → empty). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The primary-key columns of a table, in composite-key order. */
export function pkColumns(columns: BrowseColumn[]): BrowseColumn[] {
  return columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
}

/**
 * The id string identifying a row for the read/write/delete endpoints. A single
 * pk passes its bare value; a composite pk passes a JSON array of its parts in
 * key order (the shape `row?id=` / delete accept).
 */
export function rowIdOf(
  row: Record<string, unknown>,
  columns: BrowseColumn[]
): string {
  const pks = pkColumns(columns);
  if (pks.length <= 1) {
    const only = pks[0];
    return only ? cellText(row[only.name]) : "";
  }
  return JSON.stringify(pks.map((c) => row[c.name] ?? null));
}

/** The columns the editor offers an input for on INSERT — pk is auto-minted, so
 *  it is shown read-only, and every other column is a candidate field. */
export function insertableColumns(columns: BrowseColumn[]): BrowseColumn[] {
  return columns.filter((c) => c.pk === 0);
}

/** A number input suits INTEGER/REAL affinity; everything else is text. */
export function isNumericColumn(col: BrowseColumn): boolean {
  return /INT|REAL|NUM|DEC|FLOA|DOUB/iu.test(col.type);
}

/** Human label for a dependent's mechanism badge in the delete dialog. */
export function mechanismLabel(mechanism: "fk" | "poly"): string {
  return mechanism === "fk" ? "reference" : "authored";
}

/**
 * The row editor's mode: inserting a fresh row, editing an existing one (carrying
 * its id + original values), or closed. Shared so the editor sub-component and the
 * orchestrating tab agree on the shape.
 */
export type EditorState =
  | { mode: "insert" }
  | { mode: "edit"; id: string; row: Record<string, unknown> }
  | null;

/** In-flight delete confirmation state — the target id, the discovered dependents,
 *  and whether an engine FK blocks the delete outright. */
export interface DeleteState {
  id: string;
  loading: boolean;
  dependents: BrowseDependent[];
  hasEngineDependents: boolean;
  totalRows: number;
  blockedReason: string | null;
  error: string | null;
}
