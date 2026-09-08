/**
 * The golden-vault snapshot format (#892).
 *
 * Migration tests replay the ladder over vaults this build just created. Nothing
 * opened a PRIOR RELEASE's vault, and "an upgrade ate my data" is the worst
 * outcome a local-first sovereign vault has.
 *
 * Hashing the whole file fails on the first migration; counting rows passes one
 * that rewrote every value. So the snapshot maps primary key → digest over THE
 * COLUMNS THAT EXISTED AT FREEZE TIME, giving three distinguishable outcomes: a
 * dropped ROW is data loss, a changed VALUE is a migration rewriting a member's
 * content, and a dropped COLUMN is its own class — sometimes legitimate, never
 * silent, remedied by re-freezing in the release that drops it. Added rows and
 * columns are allowed: a backfill is doing its job.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** One table as it stood when the corpus was frozen. */
export interface TableSnapshot {
  /** Column names captured at freeze time, sorted. */
  columns: string[];
  /** The single-column primary key, or null when the table has none. */
  primaryKey: string | null;
  rows: number;
  /** Primary key → digest over `columns`. Empty when `primaryKey` is null. */
  digests: Record<string, string>;
}

/** Every non-empty table of a frozen vault, keyed by physical table name. */
export type VaultSnapshot = Record<string, TableSnapshot>;

export interface SnapshotComparison {
  ok: boolean;
  /** Human-readable, one per problem — the failure message IS this list. */
  findings: string[];
  /** What was actually compared, so a vacuous pass is visible as one. */
  compared: { tables: number; rows: number };
}

/**
 * RUNTIME BOOKKEEPING, not member content. A row here is rewritten by the act of
 * OPENING the vault, so freezing it would red the gate for a reason unrelated to
 * an upgrade. The list is capped by a test — "it kept changing" is not a reason.
 */
export const SNAPSHOT_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    "replica_meta",
    "the replica protocol's singleton: `active_commit_id`, `floor_seq`, " +
      "`trigger_schema_version` and `updated_at` are rewritten by opening the " +
      "vault (replica/change-log.ts), so it is state ABOUT the vault rather " +
      "than content IN it.",
  ],
]);

/** Tables whose contents are the corpus. Ordered for a stable manifest. */
export function snapshotTables(vault: DatabaseSync): string[] {
  return vault
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
          -- The FTS shadow tables are named fts_<entity> and its five
          -- suffixed siblings. The pattern here used to be '%_fts%', where
          -- _ is LIKE's ONE-CHARACTER wildcard: it matches a name with a
          -- character BEFORE "fts", which no shadow table has -- so the
          -- exclusion excluded nothing and the manifest carried 52 index
          -- tables as if they were corpus.
          AND name NOT LIKE 'fts\\_%' ESCAPE '\\'
        ORDER BY name`
    )
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((name) => !SNAPSHOT_EXCLUSIONS.has(name));
}

interface ColumnInfo {
  name: string;
  pk: number;
}

function columnsOf(db: DatabaseSync, table: string): ColumnInfo[] {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all() as unknown as ColumnInfo[];
}

/**
 * The primary-key column, or null. A table without one cannot be diffed
 * row-by-row, so it is counted instead of being dropped from the corpus.
 */
export function primaryKeyOf(db: DatabaseSync, table: string): string | null {
  const pk = columnsOf(db, table).filter((column) => column.pk > 0);
  return pk.length === 1 ? (pk[0]?.name ?? null) : null;
}

function digestValues(values: unknown[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    // Type is part of the digest: SQLite holds `1` where `'1'` was, and a
    // migration that changed a column's affinity changed the data.
    hash.update(value === null ? "\0null" : `${typeof value}:${String(value)}`);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Freeze one table: the column names captured, and a pk → digest map.
 *
 */
export function snapshotTable(db: DatabaseSync, table: string): TableSnapshot {
  const columns = columnsOf(db, table)
    .map((column) => column.name)
    .sort();
  const pk = primaryKeyOf(db, table);
  if (!pk) {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as {
      n: number;
    };
    return { columns, primaryKey: null, rows: count.n, digests: {} };
  }
  const quoted = columns.map((name) => `"${name}"`).join(", ");
  const rows = db
    .prepare(`SELECT ${quoted} FROM "${table}" ORDER BY "${pk}"`)
    .all() as Record<string, unknown>[];
  const digests: Record<string, string> = {};
  for (const row of rows) {
    digests[String(row[pk])] = digestValues(columns.map((name) => row[name]));
  }
  return { columns, primaryKey: pk, rows: rows.length, digests };
}

/** Freeze every table with at least one row. An empty table pins nothing. */
export function snapshotVault(db: DatabaseSync): VaultSnapshot {
  const tables: VaultSnapshot = {};
  for (const table of snapshotTables(db)) {
    const snapshot = snapshotTable(db, table);
    if (snapshot.rows > 0) tables[table] = snapshot;
  }
  return tables;
}

/**
 * Compare a frozen snapshot against the same vault after today's migrations.
 *
 */
export function compareSnapshot(
  frozen: VaultSnapshot,
  db: DatabaseSync
): SnapshotComparison {
  const findings: string[] = [];
  let comparedTables = 0;
  let comparedRows = 0;

  for (const [table, snapshot] of Object.entries(frozen)) {
    const live = db
      .prepare(
        `SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`
      )
      .get(table);
    if (!live) {
      findings.push(
        `table \`${table}\` held ${snapshot.rows} row(s) at freeze time and does not exist after migrating — every row in it is gone`
      );
      continue;
    }
    const liveColumns = new Set(
      columnsOf(db, table).map((column) => column.name)
    );
    const dropped = snapshot.columns.filter((name) => !liveColumns.has(name));
    if (dropped.length) {
      findings.push(
        `table \`${table}\` lost column(s) ${dropped.join(", ")} — if that retirement is intended, re-freeze the golden corpus in the release that does it`
      );
      continue;
    }
    if (!snapshot.primaryKey) {
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM "${table}"`)
        .get() as {
        n: number;
      };
      if (count.n < snapshot.rows) {
        findings.push(
          `table \`${table}\` (no single-column primary key, counted only) went from ${snapshot.rows} to ${count.n} row(s)`
        );
      }
      comparedTables += 1;
      continue;
    }
    const quoted = snapshot.columns.map((name) => `"${name}"`).join(", ");
    const after = new Map<string, string>();
    for (const row of db
      .prepare(`SELECT ${quoted} FROM "${table}"`)
      .all() as Record<string, unknown>[]) {
      after.set(
        String(row[snapshot.primaryKey]),
        digestValues(snapshot.columns.map((name) => row[name]))
      );
    }
    const droppedRows: string[] = [];
    const mutatedRows: string[] = [];
    for (const [key, digest] of Object.entries(snapshot.digests)) {
      comparedRows += 1;
      if (!after.has(key)) droppedRows.push(key);
      else if (after.get(key) !== digest) mutatedRows.push(key);
    }
    if (droppedRows.length) {
      findings.push(
        `table \`${table}\`: ${droppedRows.length} row(s) present before the upgrade are GONE after it (e.g. ${droppedRows.slice(0, 3).join(", ")})`
      );
    }
    if (mutatedRows.length) {
      findings.push(
        `table \`${table}\`: ${mutatedRows.length} row(s) had their values REWRITTEN by the upgrade (e.g. ${mutatedRows.slice(0, 3).join(", ")})`
      );
    }
    comparedTables += 1;
  }

  return {
    ok: findings.length === 0,
    findings,
    compared: { tables: comparedTables, rows: comparedRows },
  };
}
