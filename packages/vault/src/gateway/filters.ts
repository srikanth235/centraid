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
  const parts: string[] = [];
  const params: (string | number)[] = [];
  for (const clause of clauses) {
    if (!cols.has(clause.column))
      throw new Error(`unknown column "${clause.column}" on ${physical}`);
    const col = `${alias ? `${alias}.` : ''}"${clause.column}"`;
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
    } else {
      const sqlOp = OPS[clause.op];
      if (!sqlOp) throw new Error(`unknown filter op "${clause.op}"`);
      parts.push(`${col} ${sqlOp} ?`);
      params.push(toParam(clause.value));
    }
  }
  return { where: parts.length > 0 ? parts.join(' AND ') : '1=1', params };
}

function toParam(value: unknown): string | number {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error(`unsupported filter value ${JSON.stringify(value)}`);
}

/**
 * Column allow-list from consent.grant_scope.field_mask_json — minimization
 * by default (§03). Returns the SELECT list; a mask never widens past real
 * columns, and an empty intersection fails closed.
 */
export function applyFieldMask(db: DatabaseSync, physical: string, mask: string[] | null): string {
  if (mask === null) return '*';
  const cols = tableColumns(db, physical);
  const allowed = mask.filter((c) => cols.has(c));
  if (allowed.length === 0) throw new Error(`field mask excludes every column of ${physical}`);
  return allowed.map((c) => `"${c}"`).join(', ');
}
