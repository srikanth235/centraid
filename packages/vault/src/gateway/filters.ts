// Row filters and field masks (S2). Row filters are the ODRL-constraint rows
// stored in consent.grant_scope.row_filter_json; the gateway compiles them to
// parameterized SQL against columns validated via PRAGMA table_info — no
// caller-supplied string ever becomes SQL text.

import type { DatabaseSync } from 'node:sqlite';
import type { FilterClause } from './types.js';

const OPS: Record<string, string> = {
  eq: '=',
  ne: '!=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

const columnCache = new Map<string, Set<string>>();
const scalarPrimaryKeyCache = new Map<string, string | null>();

/**
 * Forget cached columns. Ext-band applies (gateway/ext.ts) ALTER live
 * tables, and tests open many same-named vaults per process — both would
 * otherwise read stale shapes.
 */
export function clearColumnCache(physical?: string): void {
  if (physical === undefined) {
    columnCache.clear();
    scalarPrimaryKeyCache.clear();
  } else {
    columnCache.delete(physical);
    scalarPrimaryKeyCache.delete(physical);
  }
}

/** Actual column names of a physical table (cached per process). */
export function tableColumns(db: DatabaseSync, physical: string): Set<string> {
  let cols = columnCache.get(physical);
  if (!cols) {
    const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
      name: string;
    }[];
    cols = new Set(rows.map((r) => r.name));
    columnCache.set(physical, cols);
  }
  return cols;
}

export interface CompiledFilter {
  where: string;
  params: (string | number)[];
}

function compileFilterClauses(
  clauses: FilterClause[],
  now: string,
  columnSql: (column: string) => string,
): CompiledFilter {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  for (const clause of clauses) {
    const col = columnSql(clause.column);
    if (clause.op === 'is-null') {
      parts.push(`${col} IS NULL`);
    } else if (clause.op === 'not-null') {
      parts.push(`${col} IS NOT NULL`);
    } else if (clause.op === 'in') {
      const values = clause.value;
      if (!Array.isArray(values) || values.length === 0)
        throw new Error(`op "in" needs a non-empty array`);
      parts.push(`${col} IN (${values.map(() => '?').join(', ')})`);
      for (const v of values) params.push(toParam(v));
    } else if (clause.op === 'within-days') {
      const days = Number(clause.value);
      if (!Number.isFinite(days) || days <= 0)
        throw new Error(`op "within-days" needs a positive number`);
      const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString();
      parts.push(`${col} >= ?`);
      params.push(cutoff);
    } else if (clause.op === 'within-next-days') {
      const days = Number(clause.value);
      if (!Number.isFinite(days) || days <= 0)
        throw new Error(`op "within-next-days" needs a positive number`);
      const horizon = new Date(Date.parse(now) + days * 86_400_000).toISOString();
      parts.push(`${col} >= ? AND ${col} <= ?`);
      params.push(now, horizon);
    } else {
      const sqlOp = OPS[clause.op];
      if (!sqlOp) throw new Error(`unknown filter op "${clause.op}"`);
      parts.push(`${col} ${sqlOp} ?`);
      params.push(toParam(clause.value));
    }
  }
  return { where: parts.length > 0 ? parts.join(' AND ') : '1=1', params };
}

/**
 * Compile filter clauses to a WHERE fragment. Throws on unknown columns or
 * ops — a malformed grant filter must fail closed, never widen.
 */
export function compileFilters(
  db: DatabaseSync,
  physical: string,
  clauses: FilterClause[],
  now: string,
  alias?: string,
): CompiledFilter {
  const cols = tableColumns(db, physical);
  return compileFilterClauses(clauses, now, (column) => {
    if (!cols.has(column)) throw new Error(`unknown column "${column}" on ${physical}`);
    return `${alias ? `${alias}.` : ''}"${column}" COLLATE BINARY`;
  });
}

function sqliteCastType(declaredType: string): 'INTEGER' | 'TEXT' | 'REAL' | 'NUMERIC' | undefined {
  const type = declaredType.toUpperCase();
  if (type.includes('INT')) return 'INTEGER';
  if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'TEXT';
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'REAL';
  if (type === '' || type.includes('BLOB')) return undefined;
  return 'NUMERIC';
}

/**
 * Compile the same canonical predicate against a JSON snapshot of an OLD
 * SQLite row. Explicit casts preserve the physical column affinity; BLOB
 * predicates fail closed because replica change rows deliberately never
 * retain binary values. The caller supplies a one-row `replica_old(value)`
 * CTE so the JSON document is bound once before the predicate parameters.
 */
export function compileReplicaHistoricalFilters(
  db: DatabaseSync,
  physical: string,
  clauses: FilterClause[],
  now: string,
): CompiledFilter {
  const info = db.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
    name: string;
    type: string;
  }[];
  const columns = new Map(info.map((column) => [column.name, column.type]));
  return compileFilterClauses(clauses, now, (column) => {
    const declared = columns.get(column);
    if (declared === undefined) throw new Error(`unknown column "${column}" on ${physical}`);
    const cast = sqliteCastType(declared);
    if (!cast) throw new Error(`historical BLOB filter "${column}" cannot be replicated`);
    const path = `$."${column.replaceAll('"', '\\"')}"`;
    return `(CAST(json_extract((SELECT value FROM replica_old), '${path.replaceAll("'", "''")}') AS ${cast}) COLLATE BINARY)`;
  });
}

function toParam(value: unknown): string | number {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(`unsupported filter value ${JSON.stringify(value)}`);
}

/**
 * Compile a caller's ordering to an ORDER BY fragment ('' when absent).
 * Same discipline as filters: the column must be a real column of the
 * table, the direction one of two literals — no caller string reaches SQL.
 */
export function compileOrderBy(
  db: DatabaseSync,
  physical: string,
  orderBy: { column: string; dir?: 'asc' | 'desc' } | undefined,
  tieBreakColumn?: string,
): string {
  if (!orderBy) return '';
  const columns = tableColumns(db, physical);
  if (!columns.has(orderBy.column)) {
    throw new Error(`unknown order column "${orderBy.column}" on ${physical}`);
  }
  const dir = orderBy.dir ?? 'asc';
  if (dir !== 'asc' && dir !== 'desc') {
    throw new Error(`unknown order direction "${String(dir)}"`);
  }
  if (tieBreakColumn !== undefined && !columns.has(tieBreakColumn)) {
    throw new Error(`unknown order tie-break column "${tieBreakColumn}" on ${physical}`);
  }
  const tieBreak =
    tieBreakColumn !== undefined && tieBreakColumn !== orderBy.column
      ? `, "${tieBreakColumn}" COLLATE BINARY ASC`
      : '';
  return ` ORDER BY "${orderBy.column}" COLLATE BINARY ${dir === 'desc' ? 'DESC' : 'ASC'}${tieBreak}`;
}

/**
 * Return the sole non-BLOB primary key that can safely serve as the stable
 * secondary ordering shared by canonical and browser-replica reads.
 */
export function scalarPrimaryKeyColumn(db: DatabaseSync, physical: string): string | undefined {
  const cached = scalarPrimaryKeyCache.get(physical);
  if (cached !== undefined) return cached ?? undefined;
  const primary = (
    db.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
      name: string;
      type: string;
      pk: number;
    }[]
  )
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk);
  if (primary.length !== 1) {
    scalarPrimaryKeyCache.set(physical, null);
    return undefined;
  }
  const column = primary[0];
  const scalar = column && sqliteCastType(column.type) !== undefined ? column.name : undefined;
  scalarPrimaryKeyCache.set(physical, scalar ?? null);
  return scalar;
}

/**
 * Column allow-list from consent.grant_scope.field_mask_json — minimization
 * by default (§03). Returns the SELECT list; a mask never widens past real
 * columns, and an empty intersection fails closed.
 */
export function applyFieldMask(
  db: DatabaseSync,
  physical: string,
  mask: string[] | null,
  alias?: string,
): string {
  const prefix = alias ? `${alias}.` : '';
  if (mask === null) return `${prefix}*`;
  const cols = tableColumns(db, physical);
  const allowed = mask.filter((c) => cols.has(c));
  if (allowed.length === 0) throw new Error(`field mask excludes every column of ${physical}`);
  return allowed.map((c) => `${prefix}"${c}"`).join(', ');
}
