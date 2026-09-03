import type { DatabaseSync } from "node:sqlite";

import { maskSealed } from "./atlas-browse-mask.js";
import { atlasTables, packKindOf } from "./atlas.js";
import type { AtlasPackKind } from "./atlas.js";
import { sealedColumnsOf } from "./sealed.js";
import { resolveEntity } from "./tables.js";
import type { EntityRef } from "./tables.js";

export const BROWSE_MAX_LIMIT = 100;
export const BROWSE_DEFAULT_LIMIT = 50;
export const BROWSE_REF_SEARCH_LIMIT = 20;

export const DISPLAY_FIELD_CANDIDATES: readonly string[] = [
  "display_name",
  "name",
  "title",
  "label",
  "pref_label",
  "summary",
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

export function tableInfo(
  vault: DatabaseSync,
  physical: string
): TableInfoRow[] {
  return vault
    .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
    .all() as unknown as TableInfoRow[];
}

export function foreignKeys(
  vault: DatabaseSync,
  physical: string
): ForeignKeyRow[] {
  return vault
    .prepare(`PRAGMA foreign_key_list(${JSON.stringify(physical)})`)
    .all() as unknown as ForeignKeyRow[];
}

function countRows(vault: DatabaseSync, physical: string): number {
  try {
    return (
      vault.prepare(`SELECT COUNT(*) AS n FROM "${physical}"`).get() as {
        n: number;
      }
    ).n;
  } catch {
    return 0;
  }
}

export function primaryKeyColumns(
  vault: DatabaseSync,
  physical: string
): string[] {
  return tableInfo(vault, physical)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

export function keysetKey(
  vault: DatabaseSync,
  physical: string
): { column: string; rowid: boolean } {
  const pks = primaryKeyColumns(vault, physical);
  return pks.length === 1
    ? { column: pks[0]!, rowid: false }
    : { column: "rowid", rowid: true };
}

export function displayFieldOf(columns: readonly string[], pk: string): string {
  return DISPLAY_FIELD_CANDIDATES.find((c) => columns.includes(c)) ?? pk;
}

export function resolveBrowseTable(
  vault: DatabaseSync,
  logical: string
): EntityRef {
  const ref = resolveEntity(logical, vault);
  if (!ref) {
    throw new BrowseError("unknown_table", `unknown vault table "${logical}"`);
  }
  return ref;
}

export class BrowseError extends Error {
  constructor(
    readonly code: "unknown_table" | "bad_request" | "not_found",
    message: string
  ) {
    super(message);
    this.name = "BrowseError";
  }
}

export interface BrowseTableEntry {
  logical: string;
  physical: string;
  pack: string;
  packLabel: string;
  packKind: AtlasPackKind;
  label: string;
  rows: number;
  machinery: boolean;
  singlePk: boolean;
}

export function browseTableList(vault: DatabaseSync): BrowseTableEntry[] {
  return atlasTables().map((e) => ({
    logical: e.logical,
    physical: e.physical,
    pack: e.pack,
    packLabel: e.packLabel,
    packKind: e.packKind,
    label: e.label,
    rows: countRows(vault, e.physical),
    machinery: e.packKind === "machinery",
    singlePk: primaryKeyColumns(vault, e.physical).length === 1,
  }));
}

export interface BrowseColumn {
  name: string;
  type: string;
  notnull: boolean;
  pk: number;
  defaultValue: string | null;
  fkTable: string | null;
  fkColumn: string | null;
  fkLogical: string | null;
  sealed: boolean;
}

export interface BrowseColumnsResult {
  logical: string;
  physical: string;
  columns: BrowseColumn[];
  keysetKey: string;
  displayField: string;
  machinery: boolean;
}

export function browseColumns(
  vault: DatabaseSync,
  logical: string
): BrowseColumnsResult {
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
  const displayPk = pks[0] ?? "rowid";
  return {
    logical,
    physical: ref.physical,
    columns,
    keysetKey: keysetKey(vault, ref.physical).column,
    displayField: displayFieldOf(
      info.map((c) => c.name),
      displayPk
    ),
    machinery: packKindOf(ref.schema) === "machinery",
  };
}

export interface BrowseRowsParams {
  table: string;
  limit?: number;
  after?: string;
  orderBy?: string;
  dir?: "asc" | "desc";
}

export interface BrowseRowsResult {
  logical: string;
  physical: string;
  rows: Record<string, unknown>[];
  columns: string[];
  nextCursor: string | null;
  orderBy: string;
  dir: "asc" | "desc";
  keysetKey: string;
}

interface Cursor {
  o: string | number | null;
  k: string | number;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    ) as Cursor;
    if (typeof c !== "object" || c === null || !("o" in c) || !("k" in c)) {
      throw new Error("shape");
    }
    return c;
  } catch {
    throw new BrowseError("bad_request", "invalid page cursor");
  }
}

export function browseRows(
  vault: DatabaseSync,
  params: BrowseRowsParams
): BrowseRowsResult {
  const ref = resolveBrowseTable(vault, params.table);
  const info = tableInfo(vault, ref.physical);
  const realColumns = new Set(info.map((c) => c.name));
  const key = keysetKey(vault, ref.physical);
  const dir: "asc" | "desc" = params.dir === "desc" ? "desc" : "asc";
  const cmp = dir === "desc" ? "<" : ">";

  const orderBy = params.orderBy ?? key.column;
  if (
    orderBy !== key.column &&
    orderBy !== "rowid" &&
    !realColumns.has(orderBy)
  ) {
    throw new BrowseError("bad_request", `unknown order column "${orderBy}"`);
  }
  const singleKey = orderBy === key.column;

  const limit = Math.min(
    Math.max(params.limit ?? BROWSE_DEFAULT_LIMIT, 1),
    BROWSE_MAX_LIMIT
  );
  const selectCols = key.rowid ? `rowid AS __rowid, *` : "*";

  const where: string[] = [];
  const bind: (string | number | null)[] = [];
  if (params.after !== undefined) {
    const cur = decodeCursor(params.after);
    if (singleKey) {
      where.push(`"${key.column}" ${cmp} ?`);
      bind.push(cur.k);
    } else {
      const oExpr = `"${orderBy}"`;
      const kExpr = `"${key.column}"`;
      if (cur.o === null) {
        if (dir === "asc") {
          where.push(
            `((${oExpr} IS NULL AND ${kExpr} ${cmp} ?) OR ${oExpr} IS NOT NULL)`
          );
        } else {
          where.push(`(${oExpr} IS NULL AND ${kExpr} ${cmp} ?)`);
        }
        bind.push(cur.k);
      } else {
        const tail = `(${oExpr} ${cmp} ? OR (${oExpr} = ? AND ${kExpr} ${cmp} ?))`;
        if (dir === "asc") {
          where.push(`(${oExpr} IS NOT NULL AND ${tail})`);
        } else {
          where.push(
            `(${oExpr} IS NULL OR (${oExpr} IS NOT NULL AND ${tail}))`
          );
        }
        bind.push(cur.o, cur.o, cur.k);
      }
    }
  }

  const orderSql = singleKey
    ? `"${key.column}" ${dir}`
    : `"${orderBy}" ${dir}, "${key.column}" ${dir}`;
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = vault
    .prepare(
      `SELECT ${selectCols} FROM "${ref.physical}" ${whereSql} ORDER BY ${orderSql} LIMIT ${limit + 1}`
    )
    .all(...bind) as Record<string, unknown>[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  maskSealed(vault, params.table, pageRows);

  let nextCursor: string | null = null;
  const last = pageRows.at(-1);
  if (hasMore && last) {
    const kValue = key.rowid
      ? (last["__rowid"] as number)
      : (last[key.column] as string | number);
    const oValue = singleKey
      ? kValue
      : ((last[orderBy] ?? null) as string | number | null);
    nextCursor = encodeCursor({ o: oValue, k: kValue });
  }
  if (key.rowid) for (const r of pageRows) delete r["__rowid"];

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

export interface BrowseRowResult {
  logical: string;
  physical: string;
  row: Record<string, unknown>;
  columns: string[];
}

export function browseRow(
  vault: DatabaseSync,
  table: string,
  id: string
): BrowseRowResult {
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
        "bad_request",
        `composite key needs a JSON array of ${pks.length} values`
      );
    }
    if (!Array.isArray(parts) || parts.length !== pks.length) {
      throw new BrowseError(
        "bad_request",
        `composite key needs ${pks.length} values`
      );
    }
    where = pks.map((c) => `"${c}" = ?`).join(" AND ");
    bind = parts.map((p) => (typeof p === "number" ? p : String(p)));
  }
  const row = vault
    .prepare(`SELECT * FROM "${ref.physical}" WHERE ${where} LIMIT 1`)
    .get(...bind) as Record<string, unknown> | undefined;
  if (!row) throw new BrowseError("not_found", `no row ${id} in ${table}`);
  maskSealed(vault, table, [row]);
  return {
    logical: table,
    physical: ref.physical,
    row,
    columns: info.map((c) => c.name),
  };
}
