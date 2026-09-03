import type { DatabaseSync } from "node:sqlite";

import {
  BROWSE_REF_SEARCH_LIMIT,
  displayFieldOf,
  foreignKeys,
  primaryKeyColumns,
  resolveBrowseTable,
  tableInfo,
} from "./atlas-browse.js";
import { atlasTables } from "./atlas.js";
import { ENTITY_POINTERS } from "./entity-refs.js";

export interface BrowseRefHit {
  id: string;
  display: string;
}

export function browseRefSearch(
  vault: DatabaseSync,
  table: string,
  query: string,
  limit = BROWSE_REF_SEARCH_LIMIT
): BrowseRefHit[] {
  const ref = resolveBrowseTable(vault, table);
  const info = tableInfo(vault, ref.physical);
  const pks = primaryKeyColumns(vault, ref.physical);
  const idCol = pks.length === 1 ? pks[0]! : "rowid";
  const display = displayFieldOf(
    info.map((c) => c.name),
    idCol
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
    bind = [`${q.replaceAll("%", "").replaceAll("_", "")}%`];
  } else {
    sql = `SELECT ${idSelect} AS __id, "${display}" AS __disp FROM "${ref.physical}" WHERE "${display}" LIKE ? ESCAPE '\\' ORDER BY "${display}" LIMIT ${cap}`;
    bind = [`%${likeEscape(q)}%`];
  }
  const rows = vault.prepare(sql).all(...bind) as {
    __id: unknown;
    __disp: unknown;
  }[];
  return rows.map((r) => ({
    id: String(r.__id),
    display: r.__disp == null ? String(r.__id) : String(r.__disp),
  }));
}

function likeEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export interface BrowseDependent {
  table: string;
  via: string;
  count: number;
  mechanism: "fk" | "poly";
}

export interface BrowseDependentsResult {
  logical: string;
  physical: string;
  id: string;
  dependents: BrowseDependent[];
  hasEngineDependents: boolean;
  totalRows: number;
}

export function browseDependents(
  vault: DatabaseSync,
  table: string,
  id: string
): BrowseDependentsResult {
  const ref = resolveBrowseTable(vault, table);
  const logical = `${ref.schema}.${ref.table}`;
  const byPhysical = new Map(atlasTables().map((e) => [e.physical, e.logical]));
  const dependents: BrowseDependent[] = [];

  for (const entry of atlasTables()) {
    if (entry.physical === ref.physical) continue; // self-refs handled below
    for (const fk of foreignKeys(vault, entry.physical)) {
      if (fk.table !== ref.physical) continue;
      const count = (
        vault
          .prepare(
            `SELECT COUNT(*) AS n FROM "${entry.physical}" WHERE "${fk.from}" = ?`
          )
          .get(id) as { n: number }
      ).n;
      if (count > 0) {
        dependents.push({
          table: entry.logical,
          via: `${entry.physical}.${fk.from}`,
          count,
          mechanism: "fk",
        });
      }
    }
  }
  for (const fk of foreignKeys(vault, ref.physical)) {
    if (fk.table !== ref.physical) continue;
    const count = (
      vault
        .prepare(
          `SELECT COUNT(*) AS n FROM "${ref.physical}" WHERE "${fk.from}" = ?`
        )
        .get(id) as { n: number }
    ).n;
    if (count > 0) {
      dependents.push({
        table: logical,
        via: `${ref.physical}.${fk.from}`,
        count,
        mechanism: "fk",
      });
    }
  }
  const hasEngineDependents = dependents.length > 0;

  for (const entry of ENTITY_POINTERS) {
    for (const pair of entry.pairs) {
      const count = (
        vault
          .prepare(
            `SELECT COUNT(*) AS n FROM "${entry.table}" WHERE "${pair.typeCol}" = ? AND "${pair.idCol}" = ?`
          )
          .get(logical, id) as { n: number }
      ).n;
      if (count > 0) {
        dependents.push({
          table: byPhysical.get(entry.table) ?? entry.table,
          via: `${entry.table}.${pair.typeCol}`,
          count,
          mechanism: "poly",
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
