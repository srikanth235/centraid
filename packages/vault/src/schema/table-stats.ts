// Per-table size breakdown (issue #367 §E1): the diagnostics bundle needs
// to make "which table is actually big" obvious for a mounted vault, so the
// growth-runway work in the rest of §E (journal archival, FTS bounding,
// inline-body thresholds) is aimed at real numbers instead of guesses.
//
// Primary method: SQLite's `dbstat` virtual table (compiled in when SQLite
// is built with `SQLITE_ENABLE_DBSTAT_VTAB`). Probed live against this
// repo's node:sqlite (see issue #367 report): `ENABLE_DBSTAT_VTAB` IS in
// `pragma_compile_options()`, and `SELECT ... FROM dbstat WHERE aggregate
// = TRUE` returns one row per btree object (`pgsize` = total bytes,
// `pageno` = page count when aggregated) without a full page-by-page scan.
// If a future Node/SQLite build lacks it, the query throws and this module
// falls back to a documented estimate (`sqlite_master` walk + per-table row
// counts + whole-file `page_count`/`page_size`) — no byte breakdown in that
// mode, honestly labeled `method: 'estimate'` rather than faked.
//
// Index (and FTS5 shadow table) bytes roll up into their OWNING table via
// `sqlite_master.tbl_name`, so "how big is knowledge.note, indexes
// included" is one row, not four.

import type { DatabaseSync } from 'node:sqlite';

export type TableStatsMethod = 'dbstat' | 'estimate';

export interface TableSizeEntry {
  /** The owning table's physical name (indexes/FTS shadows roll up into it). */
  table: string;
  /** Bytes attributable to this table + its indexes. `dbstat` method only. */
  bytes?: number;
  /** Pages attributable to this table + its indexes. `dbstat` method only. */
  pages?: number;
  /** Row count. `estimate` method always; `dbstat` method omits it (a second
   *  full-table COUNT(*) nobody asked for when byte stats are available). */
  rows?: number;
}

export interface DbSizeBreakdown {
  method: TableStatsMethod;
  /** `page_count * page_size` — the whole-file size estimate, both methods. */
  fileBytesTotal: number;
  pageSize: number;
  pageCount: number;
  /** Sorted by `bytes` (dbstat) or `rows` (estimate) descending — biggest first. */
  tables: TableSizeEntry[];
}

interface PragmaRow {
  page_count?: number;
  page_size?: number;
}

function fileTotals(db: DatabaseSync): {
  pageCount: number;
  pageSize: number;
  fileBytesTotal: number;
} {
  const pageCount = (db.prepare('PRAGMA page_count').get() as PragmaRow).page_count ?? 0;
  const pageSize = (db.prepare('PRAGMA page_size').get() as PragmaRow).page_size ?? 0;
  return { pageCount, pageSize, fileBytesTotal: pageCount * pageSize };
}

interface DbstatRow {
  name: string;
  pageno: number; // page COUNT when aggregate = TRUE (see module header)
  pgsize: number; // total bytes when aggregate = TRUE
}

interface MasterRow {
  name: string;
  tbl_name: string;
}

/** Try the dbstat vtab; throws (caller catches) when it isn't compiled in. */
function dbstatBreakdown(db: DatabaseSync): TableSizeEntry[] {
  const stats = db
    .prepare('SELECT name, pageno, pgsize FROM dbstat WHERE aggregate = TRUE')
    .all() as unknown as DbstatRow[];
  const master = db
    .prepare('SELECT name, tbl_name FROM sqlite_master')
    .all() as unknown as MasterRow[];
  const tblNameOf = new Map(master.map((m) => [m.name, m.tbl_name]));
  const byTable = new Map<string, { bytes: number; pages: number }>();
  for (const row of stats) {
    // `sqlite_schema` is dbstat's own pseudo-entry for the schema page(s) —
    // it has no sqlite_master row; keep it as its own bucket.
    const owner = tblNameOf.get(row.name) ?? row.name;
    const acc = byTable.get(owner) ?? { bytes: 0, pages: 0 };
    acc.bytes += row.pgsize;
    acc.pages += row.pageno;
    byTable.set(owner, acc);
  }
  return [...byTable.entries()]
    .map(([table, acc]) => ({ table, bytes: acc.bytes, pages: acc.pages }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Fallback when dbstat is unavailable: row counts, no byte breakdown. */
function estimateBreakdown(db: DatabaseSync): TableSizeEntry[] {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as unknown as { name: string }[];
  const entries: TableSizeEntry[] = [];
  for (const { name } of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
      entries.push({ table: name, rows: row.n });
    } catch {
      // A shadow table for a virtual module that refuses a bare COUNT(*)
      // (rare) — skip it rather than fail the whole estimate.
    }
  }
  return entries.sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0));
}

/** Per-table size breakdown of one open database (vault.db or journal.db). */
export function dbSizeBreakdown(db: DatabaseSync): DbSizeBreakdown {
  const { pageCount, pageSize, fileBytesTotal } = fileTotals(db);
  try {
    return { method: 'dbstat', fileBytesTotal, pageSize, pageCount, tables: dbstatBreakdown(db) };
  } catch {
    return {
      method: 'estimate',
      fileBytesTotal,
      pageSize,
      pageCount,
      tables: estimateBreakdown(db),
    };
  }
}
