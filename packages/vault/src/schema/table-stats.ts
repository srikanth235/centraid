import type { DatabaseSync } from "node:sqlite";

export type TableStatsMethod = "dbstat" | "estimate";

export interface TableSizeEntry {
  table: string;
  bytes?: number;
  pages?: number;
  rows?: number;
}

export interface DbSizeBreakdown {
  method: TableStatsMethod;
  fileBytesTotal: number;
  pageSize: number;
  pageCount: number;
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
  const pageCount =
    (db.prepare("PRAGMA page_count").get() as PragmaRow).page_count ?? 0;
  const pageSize =
    (db.prepare("PRAGMA page_size").get() as PragmaRow).page_size ?? 0;
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

function dbstatBreakdown(db: DatabaseSync): TableSizeEntry[] {
  const stats = db
    .prepare("SELECT name, pageno, pgsize FROM dbstat WHERE aggregate = TRUE")
    .all() as unknown as DbstatRow[];
  const master = db
    .prepare("SELECT name, tbl_name FROM sqlite_master")
    .all() as unknown as MasterRow[];
  const tblNameOf = new Map(master.map((m) => [m.name, m.tbl_name]));
  const byTable = new Map<string, { bytes: number; pages: number }>();
  for (const row of stats) {
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

function estimateBreakdown(db: DatabaseSync): TableSizeEntry[] {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as unknown as { name: string }[];
  const entries: TableSizeEntry[] = [];
  for (const { name } of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as {
        n: number;
      };
      entries.push({ table: name, rows: row.n });
    } catch {
      // Intentionally empty.
    }
  }
  return entries.sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0));
}

export function dbSizeBreakdown(db: DatabaseSync): DbSizeBreakdown {
  const { pageCount, pageSize, fileBytesTotal } = fileTotals(db);
  try {
    return {
      method: "dbstat",
      fileBytesTotal,
      pageSize,
      pageCount,
      tables: dbstatBreakdown(db),
    };
  } catch {
    return {
      method: "estimate",
      fileBytesTotal,
      pageSize,
      pageCount,
      tables: estimateBreakdown(db),
    };
  }
}
