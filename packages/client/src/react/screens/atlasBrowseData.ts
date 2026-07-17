// Pure grid/state helpers for the Vault Atlas Browse tab (issue #441 B3),
// split out of AtlasBrowseTab.tsx so the component reads as UI, not plumbing.
// Nothing here touches React or the network — it groups the picker, classifies
// cell values, and computes row identity from column metadata so the editor and
// the delete flow agree on what "this row" means.

import type { BrowseColumn, BrowseDependent, BrowseTableEntry } from '../../gateway-client.js';

/**
 * The masked value a sealed column reads back as (#293/#298). The backend never
 * returns the plaintext; the grid styles this sentinel as a chip rather than
 * printing it, and the editor refuses to write it.
 */
export const SEALED_SENTINEL = '«sealed»';

/** One pack's worth of tables in the picker — a pack header + its tables. */
export interface BrowsePackGroup {
  pack: string;
  packLabel: string;
  tables: BrowseTableEntry[];
}

/** The picker split into ontology packs (first) and machinery bands (below). */
export interface GroupedBrowseTables {
  ontology: BrowsePackGroup[];
  machinery: BrowsePackGroup[];
}

/**
 * Group the flat picker list into ontology-packs-first, machinery-bands-below,
 * filtered by a case-insensitive substring over the logical name + label. Packs
 * keep first-seen order (the backend already orders ontology before machinery);
 * an empty pack after filtering is dropped so the divider never floats over
 * nothing.
 */
export function groupBrowseTables(tables: BrowseTableEntry[], query: string): GroupedBrowseTables {
  const q = query.trim().toLowerCase();
  const match = (t: BrowseTableEntry): boolean =>
    q === '' ||
    t.logical.toLowerCase().includes(q) ||
    t.label.toLowerCase().includes(q) ||
    t.physical.toLowerCase().includes(q);

  const packs = new Map<string, BrowsePackGroup>();
  const order: string[] = [];
  for (const t of tables) {
    if (!match(t)) continue;
    let g = packs.get(t.pack);
    if (!g) {
      g = { pack: t.pack, packLabel: t.packLabel, tables: [] };
      packs.set(t.pack, g);
      order.push(t.pack);
    }
    g.tables.push(t);
  }

  const ontology: BrowsePackGroup[] = [];
  const machinery: BrowsePackGroup[] = [];
  for (const p of order) {
    const g = packs.get(p);
    if (!g) continue;
    // A pack is machinery when all of its (matched) tables are machinery — the
    // classification is per-table but packs don't straddle the divider.
    const isMachinery = g.tables.every((t) => t.machinery);
    (isMachinery ? machinery : ontology).push(g);
  }
  return { ontology, machinery };
}

/** True when a cell holds the sealed-column mask, never the real value. */
export function isSealedValue(value: unknown): boolean {
  return value === SEALED_SENTINEL;
}

/** Render any cell scalar as the string the grid shows (null → empty). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
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
export function rowIdOf(row: Record<string, unknown>, columns: BrowseColumn[]): string {
  const pks = pkColumns(columns);
  if (pks.length <= 1) {
    const only = pks[0];
    return only ? cellText(row[only.name]) : '';
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
  return /INT|REAL|NUM|DEC|FLOA|DOUB/i.test(col.type);
}

/** Human label for a dependent's mechanism badge in the delete dialog. */
export function mechanismLabel(mechanism: 'fk' | 'poly'): string {
  return mechanism === 'fk' ? 'reference' : 'authored';
}

/**
 * The row editor's mode: inserting a fresh row, editing an existing one (carrying
 * its id + original values), or closed. Shared so the editor sub-component and the
 * orchestrating tab agree on the shape.
 */
export type EditorState =
  | { mode: 'insert' }
  | { mode: 'edit'; id: string; row: Record<string, unknown> }
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
