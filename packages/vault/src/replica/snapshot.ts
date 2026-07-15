import type { DatabaseSync } from 'node:sqlite';
import { sealedColumnsOf } from '../schema/sealed.js';
import { resolveEntity } from '../schema/tables.js';
import { currentReplicaLogState, type ReplicaLogState } from './change-log.js';
import { replicaUnavailableColumnsOf } from './unavailable-columns.js';

export const DEFAULT_REPLICA_MAX_VALUE_BYTES = 64 * 1_024;

export interface ReplicaRow {
  rowId: string;
  values: Record<string, unknown>;
  /** Oversized and binary values omitted from `values`; fetch them on demand. */
  deferredColumns: string[];
}

export interface ReplicaRowsPage {
  entity: string;
  columns: string[];
  sealedColumns: string[];
  rows: ReplicaRow[];
  nextAfter?: string;
  hasMore: boolean;
}

export interface ReadReplicaRowsOptions {
  after?: string;
  limit?: number;
  maxValueBytes?: number;
}

interface ColumnInfo {
  name: string;
  pk: number;
}

interface EntityShape {
  entity: string;
  physical: string;
  columns: string[];
  sealedColumns: string[];
  primaryKey: string[];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function shapeOf(vault: DatabaseSync, entity: string): EntityShape {
  const ref = resolveEntity(entity, vault);
  if (!ref || ref.file !== 'vault') throw new Error(`unknown replica entity "${entity}"`);
  const info = vault
    .prepare(`PRAGMA table_info(${JSON.stringify(ref.physical)})`)
    .all() as unknown as ColumnInfo[];
  const sealed = [...sealedColumnsOf(entity, vault)];
  const unavailable = new Set(replicaUnavailableColumnsOf(entity, vault));
  return {
    entity,
    physical: ref.physical,
    columns: info.map((column) => column.name).filter((column) => !unavailable.has(column)),
    sealedColumns: sealed,
    primaryKey: info
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name),
  };
}

function rowIdOf(row: Record<string, unknown>, primaryKey: string[]): string {
  if (primaryKey.length === 0) throw new Error('replica entities must have a primary key');
  if (primaryKey.length === 1) return String(row[primaryKey[0] ?? '']);
  return JSON.stringify(primaryKey.map((column) => row[column]));
}

function keyValues(rowId: string, primaryKey: string[]): unknown[] {
  if (primaryKey.length === 1) return [rowId];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rowId) as unknown;
  } catch {
    throw new Error('composite replica row id must be a JSON array');
  }
  if (!Array.isArray(parsed) || parsed.length !== primaryKey.length) {
    throw new Error(`composite replica row id must contain ${primaryKey.length} values`);
  }
  return parsed;
}

function valueBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  return Buffer.byteLength(String(value));
}

function publicRow(
  raw: Record<string, unknown>,
  shape: EntityShape,
  maxValueBytes: number,
): ReplicaRow {
  const values: Record<string, unknown> = {};
  const deferredColumns: string[] = [];
  for (const column of shape.columns) {
    const value = raw[column];
    // Binary data is never eager on the JSON replica lane. Canonical
    // photo/document rows carry blob URIs, so their metadata still arrives;
    // byte bodies take the dedicated lazy blob/cache path.
    if (value instanceof Uint8Array || valueBytes(value) > maxValueBytes) {
      deferredColumns.push(column);
    } else {
      values[column] = value;
    }
  }
  return { rowId: rowIdOf(raw, shape.primaryKey), values, deferredColumns };
}

function validateOptions(options: ReadReplicaRowsOptions): {
  limit: number;
  maxValueBytes: number;
} {
  const limit = options.limit ?? 1_000;
  const maxValueBytes = options.maxValueBytes ?? DEFAULT_REPLICA_MAX_VALUE_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError('replica row page limit must be an integer between 1 and 10000');
  }
  if (!Number.isSafeInteger(maxValueBytes) || maxValueBytes < 0) {
    throw new RangeError('replica maxValueBytes must be a non-negative safe integer');
  }
  return { limit, maxValueBytes };
}

/**
 * Shape-neutral row page. Sealed columns are absent structurally (never
 * placeholder/ciphertext), and oversized/binary values are marked deferred.
 */
export function readReplicaRows(
  vault: DatabaseSync,
  entity: string,
  options: ReadReplicaRowsOptions = {},
): ReplicaRowsPage {
  const shape = shapeOf(vault, entity);
  if (shape.primaryKey.length === 0) {
    throw new Error(`replica entity "${entity}" has no primary key`);
  }
  const { limit, maxValueBytes } = validateOptions(options);
  const selected = shape.columns.map(quoteIdentifier).join(', ');
  const order = shape.primaryKey.map(quoteIdentifier).join(', ');
  let where = '';
  let params: unknown[] = [];
  if (options.after !== undefined) {
    const values = keyValues(options.after, shape.primaryKey);
    const lhs =
      shape.primaryKey.length === 1
        ? quoteIdentifier(shape.primaryKey[0] ?? '')
        : `(${shape.primaryKey.map(quoteIdentifier).join(', ')})`;
    const rhs = shape.primaryKey.length === 1 ? '?' : `(${values.map(() => '?').join(', ')})`;
    where = ` WHERE ${lhs} > ${rhs}`;
    params = values;
  }
  const rawRows = vault
    .prepare(
      `SELECT ${selected} FROM ${quoteIdentifier(shape.physical)}${where}
        ORDER BY ${order} LIMIT ?`,
    )
    .all(
      ...(params as (string | number | bigint | Uint8Array | null)[]),
      limit + 1,
    ) as unknown as Record<string, unknown>[];
  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
  const rows = pageRows.map((row) => publicRow(row, shape, maxValueBytes));
  return {
    entity,
    columns: [...shape.columns],
    sealedColumns: [...shape.sealedColumns],
    rows,
    ...(hasMore && rows.at(-1) ? { nextAfter: rows.at(-1)?.rowId } : {}),
    hasMore,
  };
}

/** Fetch a changed row by its log row id; delete entries naturally return undefined. */
export function readReplicaRow(
  vault: DatabaseSync,
  entity: string,
  rowId: string,
  options: Pick<ReadReplicaRowsOptions, 'maxValueBytes'> = {},
): ReplicaRow | undefined {
  const shape = shapeOf(vault, entity);
  if (shape.primaryKey.length === 0) {
    throw new Error(`replica entity "${entity}" has no primary key`);
  }
  const { maxValueBytes } = validateOptions({ ...options, limit: 1 });
  const values = keyValues(rowId, shape.primaryKey);
  const where = shape.primaryKey.map((column) => `${quoteIdentifier(column)} = ?`).join(' AND ');
  const selected = shape.columns.map(quoteIdentifier).join(', ');
  const raw = vault
    .prepare(`SELECT ${selected} FROM ${quoteIdentifier(shape.physical)} WHERE ${where}`)
    .get(...(values as (string | number | bigint | Uint8Array | null)[])) as
    | Record<string, unknown>
    | undefined;
  return raw ? publicRow(raw, shape, maxValueBytes) : undefined;
}

export interface ReplicaSnapshotReader {
  state: ReplicaLogState;
  readRows(entity: string, options?: ReadReplicaRowsOptions): ReplicaRowsPage;
  readRow(
    entity: string,
    rowId: string,
    options?: Pick<ReadReplicaRowsOptions, 'maxValueBytes'>,
  ): ReplicaRow | undefined;
}

export interface ReplicaSnapshotResult<T> {
  state: ReplicaLogState;
  value: T;
}

/**
 * Pin a SQLite read snapshot at watermark N while a synchronous caller streams
 * or materializes its consent-filtered shape. The transaction is read-only by
 * convention and always rolled back to release it without a write commit.
 */
export function withReplicaSnapshot<T>(
  vault: DatabaseSync,
  read: (reader: ReplicaSnapshotReader) => T,
): ReplicaSnapshotResult<T> {
  vault.exec('BEGIN');
  try {
    const state = currentReplicaLogState(vault);
    const reader: ReplicaSnapshotReader = {
      state,
      readRows: (entity, options) => readReplicaRows(vault, entity, options),
      readRow: (entity, rowId, options) => readReplicaRow(vault, entity, rowId, options),
    };
    const value = read(reader);
    vault.exec('ROLLBACK');
    return { state, value };
  } catch (error) {
    vault.exec('ROLLBACK');
    throw error;
  }
}
