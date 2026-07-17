// The Vault Atlas — Browse's relations-aware half (issue #441 Part B, B3),
// split from atlas-browse.ts to stay within the repo's file-size cap: the FK
// reference-picker search and the dependent preview a delete confirmation
// needs. The dependent preview is the shared seam with Part A: engine FKs are
// found by a reverse `PRAGMA foreign_key_list` walk, and the polymorphic
// `(type,id)` mechanisms — invisible to the engine — by the A1
// `POLY_REF_REGISTRY`. That is the acceptance criterion "counts polymorphic
// dependents via the registry, not only engine FKs". The no-SQL-from-input
// invariants of atlas-browse.ts apply here identically.

import type { DatabaseSync } from 'node:sqlite';
import { POLY_REF_REGISTRY } from './poly-refs.js';
import { atlasTables } from './atlas.js';
import {
  BROWSE_REF_SEARCH_LIMIT,
  displayFieldOf,
  foreignKeys,
  primaryKeyColumns,
  resolveBrowseTable,
  tableInfo,
} from './atlas-browse.js';

export interface BrowseRefHit {
  id: string;
  display: string;
}

/**
 * Search a FK target table for the reference picker: return `{ id, display }`
 * rows, `display` per the shared display-field heuristic. `query` matches the
 * display field (LIKE, bound) when the table has one; otherwise it matches the
 * pk prefix. Empty query returns the first N rows.
 */
export function browseRefSearch(
  vault: DatabaseSync,
  table: string,
  query: string,
  limit = BROWSE_REF_SEARCH_LIMIT,
): BrowseRefHit[] {
  const ref = resolveBrowseTable(vault, table);
  const info = tableInfo(vault, ref.physical);
  const pks = primaryKeyColumns(vault, ref.physical);
  const idCol = pks.length === 1 ? pks[0]! : 'rowid';
  const display = displayFieldOf(
    info.map((c) => c.name),
    idCol,
  );
  const cap = Math.min(Math.max(limit, 1), BROWSE_REF_SEARCH_LIMIT);
  const q = query.trim();
  const idSelect = pks.length === 1 ? `"${idCol}"` : `rowid`;
  let sql: string;
  let bind: string[];
  if (q.length === 0) {
    sql = `SELECT ${idSelect} AS __id, "${display}" AS __disp FROM "${ref.physical}" ORDER BY "${display}" LIMIT ${cap}`;
    bind = [];
  } else if (display === idCol) {
    sql = `SELECT ${idSelect} AS __id, "${display}" AS __disp FROM "${ref.physical}" WHERE "${idCol}" LIKE ? ORDER BY "${display}" LIMIT ${cap}`;
    bind = [`${q.replaceAll('%', '').replaceAll('_', '')}%`];
  } else {
    sql = `SELECT ${idSelect} AS __id, "${display}" AS __disp FROM "${ref.physical}" WHERE "${display}" LIKE ? ESCAPE '\\' ORDER BY "${display}" LIMIT ${cap}`;
    bind = [`%${likeEscape(q)}%`];
  }
  const rows = vault.prepare(sql).all(...bind) as { __id: unknown; __disp: unknown }[];
  return rows.map((r) => ({
    id: String(r.__id),
    display: r.__disp == null ? String(r.__id) : String(r.__disp),
  }));
}

function likeEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

// ---------------------------------------------------------------------------
// Dependent preview
// ---------------------------------------------------------------------------

export interface BrowseDependent {
  /** The referencing table, logical `schema.table` (physical if unmapped). */
  table: string;
  /** How it points here: `<physical>.<column>` (engine) or `<table>.<typeCol>` (poly). */
  via: string;
  count: number;
  mechanism: 'fk' | 'poly';
}

export interface BrowseDependentsResult {
  logical: string;
  physical: string;
  id: string;
  dependents: BrowseDependent[];
  /** True when any ENGINE-FK dependent exists — the delete-blocking set. */
  hasEngineDependents: boolean;
  /** Total dependent rows across both mechanisms. */
  totalRows: number;
}

/**
 * Every row that references `(table, id)`, from BOTH the reverse engine-FK
 * index (a `PRAGMA foreign_key_list` walk over every vault table) AND the A1
 * `POLY_REF_REGISTRY` matched on the row's LOGICAL entity name. Engine FKs
 * block a delete; polymorphic dependents are reported so the confirmation
 * dialog never lies by omission (issue #441 B3).
 */
export function browseDependents(
  vault: DatabaseSync,
  table: string,
  id: string,
): BrowseDependentsResult {
  const ref = resolveBrowseTable(vault, table);
  const logical = `${ref.schema}.${ref.table}`;
  const byPhysical = new Map(atlasTables().map((e) => [e.physical, e.logical]));
  const dependents: BrowseDependent[] = [];

  // Engine FKs: any vault table with an FK column whose parent is this table.
  for (const entry of atlasTables()) {
    if (entry.file !== 'vault') continue;
    if (entry.physical === ref.physical) continue; // self-refs handled below
    for (const fk of foreignKeys(vault, entry.physical)) {
      if (fk.table !== ref.physical) continue;
      const count = (
        vault
          .prepare(`SELECT COUNT(*) AS n FROM "${entry.physical}" WHERE "${fk.from}" = ?`)
          .get(id) as { n: number }
      ).n;
      if (count > 0) {
        dependents.push({
          table: entry.logical,
          via: `${entry.physical}.${fk.from}`,
          count,
          mechanism: 'fk',
        });
      }
    }
  }
  // A self-referencing FK (hierarchies) — count children pointing at this row.
  for (const fk of foreignKeys(vault, ref.physical)) {
    if (fk.table !== ref.physical) continue;
    const count = (
      vault
        .prepare(`SELECT COUNT(*) AS n FROM "${ref.physical}" WHERE "${fk.from}" = ?`)
        .get(id) as { n: number }
    ).n;
    if (count > 0) {
      dependents.push({
        table: logical,
        via: `${ref.physical}.${fk.from}`,
        count,
        mechanism: 'fk',
      });
    }
  }
  const hasEngineDependents = dependents.length > 0;

  // Polymorphic (type,id) mechanisms — invisible to the engine, matched on the
  // LOGICAL name (`core.party`, `knowledge.note`…) the type columns store.
  for (const entry of POLY_REF_REGISTRY) {
    for (const pair of entry.pairs) {
      const count = (
        vault
          .prepare(
            `SELECT COUNT(*) AS n FROM "${entry.table}" WHERE "${pair.typeCol}" = ? AND "${pair.idCol}" = ?`,
          )
          .get(logical, id) as { n: number }
      ).n;
      if (count > 0) {
        dependents.push({
          table: byPhysical.get(entry.table) ?? entry.table,
          via: `${entry.table}.${pair.typeCol}`,
          count,
          mechanism: 'poly',
        });
      }
    }
  }

  return {
    logical,
    physical: ref.physical,
    id,
    dependents,
    hasEngineDependents,
    totalRows: dependents.reduce((sum, d) => sum + d.count, 0),
  };
}
