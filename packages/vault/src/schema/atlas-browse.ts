// The Vault Atlas — Browse read side (issue #441 Part B, B3). A vault-aware
// table editor's read surface: the table picker, a keyset-paginated row grid,
// single-row reads, per-column metadata (declared type, notnull, pk, FK
// target, sealed flag), an FK reference-picker search, and the dependent
// preview a delete confirmation needs.
//
// Two invariants run through everything here:
//   1. NO user input ever becomes SQL text. Table names resolve through the
//      logical↔physical registry (`resolveEntity`) — an unknown name is a
//      denial, never a query. Column names in ORDER BY / keyset predicates are
//      validated against the live `PRAGMA table_info` whitelist. Values are
//      always bound parameters.
//   2. Sealed columns (issue #293) are masked on read — the same
//      `SEALED_PLACEHOLDER` the consent-checked read path shows. Plaintext
//      takes the `reveal` verb, never a Browse read.
//
// The dependent preview is the shared seam with Part A: engine FKs are found
// by a reverse `PRAGMA foreign_key_list` walk, and the polymorphic `(type,id)`
// mechanisms — invisible to the engine — by the A1 `POLY_REF_REGISTRY`. That
// is the acceptance criterion "counts polymorphic dependents via the registry,
// not only engine FKs".

import type { DatabaseSync } from 'node:sqlite';
import { SEALED_PLACEHOLDER, sealedColumnsOf } from './sealed.js';
import { resolveEntity, type EntityRef } from './tables.js';
import { atlasTables, packKindOf, type AtlasPackKind } from './atlas.js';

/** Hard cap on a Browse page — some tables are 40k+ rows (issue #441 B3). */
export const BROWSE_MAX_LIMIT = 100;
export const BROWSE_DEFAULT_LIMIT = 50;
/** Cap on the FK reference-picker result set. */
export const BROWSE_REF_SEARCH_LIMIT = 20;

/**
 * The display-field heuristic the whole Browse surface shares (issue #441 B3):
 * the human-facing label of a row is the first present of these columns, else
 * the primary key. Lives here so the FK reference-picker and the column
 * metadata agree on what a row "reads as".
 */
export const DISPLAY_FIELD_CANDIDATES: readonly string[] = [
  'display_name',
  'name',
  'title',
  'label',
  'pref_label',
  'summary',
];

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
}

export function tableInfo(vault: DatabaseSync, physical: string): TableInfoRow[] {
  return vault
    .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
    .all() as unknown as TableInfoRow[];
}

export function foreignKeys(vault: DatabaseSync, physical: string): ForeignKeyRow[] {
  return vault
    .prepare(`PRAGMA foreign_key_list(${JSON.stringify(physical)})`)
    .all() as unknown as ForeignKeyRow[];
}

function countRows(vault: DatabaseSync, physical: string): number {
  try {
    return (vault.prepare(`SELECT COUNT(*) AS n FROM "${physical}"`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

/** The pk columns of a table in declared order (`pk` is 1-based, 0 = not pk). */
export function primaryKeyColumns(vault: DatabaseSync, physical: string): string[] {
  return tableInfo(vault, physical)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

/**
 * The keyset key of a table: its single TEXT PK when it has exactly one pk
 * column, otherwise `rowid` (composite-PK tables like `tally_expense_split`,
 * and the rare pk-less table). Keyset pagination always rides a unique,
 * non-null key so a page boundary is totally stable.
 */
export function keysetKey(
  vault: DatabaseSync,
  physical: string,
): { column: string; rowid: boolean } {
  const pks = primaryKeyColumns(vault, physical);
  return pks.length === 1 ? { column: pks[0]!, rowid: false } : { column: 'rowid', rowid: true };
}

/** The display field for a table given its columns, per the shared heuristic. */
export function displayFieldOf(columns: readonly string[], pk: string): string {
  return DISPLAY_FIELD_CANDIDATES.find((c) => columns.includes(c)) ?? pk;
}

/** Resolve a logical name to a vault-file table, or throw a clean rejection. */
export function resolveBrowseTable(vault: DatabaseSync, logical: string): EntityRef {
  const ref = resolveEntity(logical, vault);
  if (!ref || ref.file !== 'vault') {
    throw new BrowseError('unknown_table', `unknown vault table "${logical}"`);
  }
  return ref;
}

/** A clean, mappable failure — the route turns `code` into a status. */
export class BrowseError extends Error {
  constructor(
    readonly code: 'unknown_table' | 'bad_request' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'BrowseError';
  }
}

// ---------------------------------------------------------------------------
// Table picker
// ---------------------------------------------------------------------------

export interface BrowseTableEntry {
  logical: string;
  physical: string;
  pack: string;
  packLabel: string;
  packKind: AtlasPackKind;
  label: string;
  rows: number;
  /** Machinery bands are read-only by default (issue #441 B3). */
  machinery: boolean;
  /** True when the table has a single TEXT pk (the common keyset case). */
  singlePk: boolean;
}

/**
 * Every registered vault-file table with its pack classification and live row
 * count — the Browse table picker, grouped ontology-packs-first with machinery
 * bands below by the caller. Derived from `atlasTables()`; never hand-listed.
 */
export function browseTableList(vault: DatabaseSync): BrowseTableEntry[] {
  return atlasTables()
    .filter((e) => e.file === 'vault')
    .map((e) => ({
      logical: e.logical,
      physical: e.physical,
      pack: e.pack,
      packLabel: e.packLabel,
      packKind: e.packKind,
      label: e.label,
      rows: countRows(vault, e.physical),
      machinery: e.packKind === 'machinery',
      singlePk: primaryKeyColumns(vault, e.physical).length === 1,
    }));
}

// ---------------------------------------------------------------------------
// Column metadata
// ---------------------------------------------------------------------------

export interface BrowseColumn {
  name: string;
  /** Declared SQLite type (STRICT tables carry a concrete affinity). */
  type: string;
  notnull: boolean;
  /** 0 = not pk; else 1-based position in a (possibly composite) pk. */
  pk: number;
  defaultValue: string | null;
  /** FK target as `physical.column`, or null. */
  fkTable: string | null;
  fkColumn: string | null;
  /** The FK target's logical `schema.table`, for the reference picker. */
  fkLogical: string | null;
  /** Sealed cell (issue #293): never editable/displayed in plaintext. */
  sealed: boolean;
}

export interface BrowseColumnsResult {
  logical: string;
  physical: string;
  columns: BrowseColumn[];
  /** The keyset key column (single pk or `rowid`). */
  keysetKey: string;
  /** The human display field the FK picker uses for this table. */
  displayField: string;
  machinery: boolean;
}

export function browseColumns(vault: DatabaseSync, logical: string): BrowseColumnsResult {
  const ref = resolveBrowseTable(vault, logical);
  const info = tableInfo(vault, ref.physical);
  const fks = foreignKeys(vault, ref.physical);
  const fkByColumn = new Map(fks.map((fk) => [fk.from, fk]));
  const byPhysical = new Map(atlasTables().map((e) => [e.physical, e.logical]));
  const sealed = new Set(sealedColumnsOf(logical, vault));
  const columns: BrowseColumn[] = info.map((c) => {
    const fk = fkByColumn.get(c.name);
    return {
      name: c.name,
      type: c.type,
      notnull: c.notnull === 1,
      pk: c.pk,
      defaultValue: c.dflt_value,
      fkTable: fk?.table ?? null,
      fkColumn: fk?.to ?? null,
      fkLogical: fk ? (byPhysical.get(fk.table) ?? null) : null,
      sealed: sealed.has(c.name),
    };
  });
  const pks = primaryKeyColumns(vault, ref.physical);
  const displayPk = pks[0] ?? 'rowid';
  return {
    logical,
    physical: ref.physical,
    columns,
    keysetKey: keysetKey(vault, ref.physical).column,
    displayField: displayFieldOf(
      info.map((c) => c.name),
      displayPk,
    ),
    machinery: packKindOf(ref.schema) === 'machinery',
  };
}

// ---------------------------------------------------------------------------
// Row list — keyset pagination
// ---------------------------------------------------------------------------

export interface BrowseRowsParams {
  table: string;
  limit?: number;
  /** Opaque keyset cursor from a prior page's `nextCursor`. */
  after?: string;
  /** A real column to order by; defaults to the keyset key. */
  orderBy?: string;
  dir?: 'asc' | 'desc';
}

export interface BrowseRowsResult {
  logical: string;
  physical: string;
  rows: Record<string, unknown>[];
  columns: string[];
  /** Cursor for the next page, or null when the page is the last. */
  nextCursor: string | null;
  orderBy: string;
  dir: 'asc' | 'desc';
  keysetKey: string;
}

interface Cursor {
  /** The ordered column's value at the page boundary (null-safe). */
  o: string | number | null;
  /** The keyset key's value at the page boundary (always non-null). */
  k: string | number;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof c !== 'object' || c === null || !('o' in c) || !('k' in c)) {
      throw new Error('shape');
    }
    return c;
  } catch {
    throw new BrowseError('bad_request', 'invalid page cursor');
  }
}

/**
 * One keyset-paginated page. The order is `(orderBy, keysetKey)` — a real
 * column then the unique key as tiebreaker, both in `dir`, so ties never split
 * a row across two pages and the boundary is exact. The `after` predicate is
 * NULL-aware (SQLite sorts NULLs first ASC, last DESC) so a nullable orderBy
 * column paginates without dropping rows at the NULL boundary.
 */
export function browseRows(vault: DatabaseSync, params: BrowseRowsParams): BrowseRowsResult {
  const ref = resolveBrowseTable(vault, params.table);
  const info = tableInfo(vault, ref.physical);
  const realColumns = new Set(info.map((c) => c.name));
  const key = keysetKey(vault, ref.physical);
  const dir: 'asc' | 'desc' = params.dir === 'desc' ? 'desc' : 'asc';
  const cmp = dir === 'desc' ? '<' : '>';

  // orderBy is a real column only (registry/PRAGMA whitelist) or the key.
  let orderBy = params.orderBy ?? key.column;
  if (orderBy !== key.column && orderBy !== 'rowid' && !realColumns.has(orderBy)) {
    throw new BrowseError('bad_request', `unknown order column "${orderBy}"`);
  }
  // When ordering by the key itself, the tuple collapses to one column.
  const singleKey = orderBy === key.column;

  const limit = Math.min(Math.max(params.limit ?? BROWSE_DEFAULT_LIMIT, 1), BROWSE_MAX_LIMIT);
  const selectCols = key.rowid ? `rowid AS __rowid, *` : '*';

  const where: string[] = [];
  const bind: (string | number | null)[] = [];
  if (params.after !== undefined) {
    const cur = decodeCursor(params.after);
    if (singleKey) {
      where.push(`"${key.column}" ${cmp} ?`);
      bind.push(cur.k);
    } else {
      // Row-value tuple keyset, NULL-aware. See the doc comment above.
      const oExpr = `"${orderBy}"`;
      const kExpr = `"${key.column}"`;
      if (cur.o === null) {
        if (dir === 'asc') {
          // After a NULL boundary ascending: remaining NULLs (k > kv), then
          // every non-null row.
          where.push(`((${oExpr} IS NULL AND ${kExpr} ${cmp} ?) OR ${oExpr} IS NOT NULL)`);
          bind.push(cur.k);
        } else {
          // Descending, NULLs last: only later NULLs remain.
          where.push(`(${oExpr} IS NULL AND ${kExpr} ${cmp} ?)`);
          bind.push(cur.k);
        }
      } else {
        const tail = `(${oExpr} ${cmp} ? OR (${oExpr} = ? AND ${kExpr} ${cmp} ?))`;
        if (dir === 'asc') {
          where.push(`(${oExpr} IS NOT NULL AND ${tail})`);
        } else {
          // Descending, NULLs last: non-null comparisons, then trailing NULLs.
          where.push(`(${oExpr} IS NULL OR (${oExpr} IS NOT NULL AND ${tail}))`);
        }
        bind.push(cur.o, cur.o, cur.k);
      }
    }
  }

  const orderSql = singleKey
    ? `"${key.column}" ${dir}`
    : `"${orderBy}" ${dir}, "${key.column}" ${dir}`;
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = vault
    .prepare(
      `SELECT ${selectCols} FROM "${ref.physical}" ${whereSql} ORDER BY ${orderSql} LIMIT ${limit + 1}`,
    )
    .all(...bind) as Record<string, unknown>[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  maskSealed(vault, params.table, pageRows);

  let nextCursor: string | null = null;
  const last = pageRows.at(-1);
  if (hasMore && last) {
    const kValue = key.rowid ? (last['__rowid'] as number) : (last[key.column] as string | number);
    const oValue = singleKey ? kValue : ((last[orderBy] ?? null) as string | number | null);
    nextCursor = encodeCursor({ o: oValue, k: kValue });
  }
  // The synthetic rowid selector is an implementation detail, not a column.
  if (key.rowid) for (const r of pageRows) delete r['__rowid'];

  return {
    logical: params.table,
    physical: ref.physical,
    rows: pageRows,
    columns: info.map((c) => c.name),
    nextCursor,
    orderBy,
    dir,
    keysetKey: key.column,
  };
}

// ---------------------------------------------------------------------------
// Single row
// ---------------------------------------------------------------------------

export interface BrowseRowResult {
  logical: string;
  physical: string;
  row: Record<string, unknown>;
  columns: string[];
}

/** One row by primary key. Composite PKs take a JSON array of pk values. */
export function browseRow(vault: DatabaseSync, table: string, id: string): BrowseRowResult {
  const ref = resolveBrowseTable(vault, table);
  const info = tableInfo(vault, ref.physical);
  const pks = primaryKeyColumns(vault, ref.physical);
  let where: string;
  let bind: (string | number)[];
  if (pks.length <= 1) {
    where = pks.length === 1 ? `"${pks[0]}" = ?` : `rowid = ?`;
    bind = [id];
  } else {
    let parts: unknown;
    try {
      parts = JSON.parse(id);
    } catch {
      throw new BrowseError(
        'bad_request',
        `composite key needs a JSON array of ${pks.length} values`,
      );
    }
    if (!Array.isArray(parts) || parts.length !== pks.length) {
      throw new BrowseError('bad_request', `composite key needs ${pks.length} values`);
    }
    where = pks.map((c) => `"${c}" = ?`).join(' AND ');
    bind = parts.map((p) => (typeof p === 'number' ? p : String(p)));
  }
  const row = vault
    .prepare(`SELECT * FROM "${ref.physical}" WHERE ${where} LIMIT 1`)
    .get(...bind) as Record<string, unknown> | undefined;
  if (!row) throw new BrowseError('not_found', `no row ${id} in ${table}`);
  maskSealed(vault, table, [row]);
  return { logical: table, physical: ref.physical, row, columns: info.map((c) => c.name) };
}

// ---------------------------------------------------------------------------
// FK reference-picker search
// ---------------------------------------------------------------------------

/** Mask sealed cells in-place — the same placeholder the read path shows. */
function maskSealed(vault: DatabaseSync, logical: string, rows: Record<string, unknown>[]): void {
  const sealed = sealedColumnsOf(logical, vault);
  if (sealed.length === 0) return;
  for (const row of rows) {
    for (const col of sealed) {
      // Any non-empty sealed cell reads as the placeholder — never plaintext,
      // whether it is ciphertext at rest or a legacy plaintext value.
      const v = row[col];
      if (v != null && v !== '') row[col] = SEALED_PLACEHOLDER;
    }
  }
}
