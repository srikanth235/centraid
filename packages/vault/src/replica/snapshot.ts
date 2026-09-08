import type { DatabaseSync } from "node:sqlite";

import { prepared } from "../grant/prepared.js";
import { DEFAULT_REPLICA_TEXT_CEILING_BYTES } from "../schema/entity-declaration.js";
import { parseExtLogical } from "../schema/ext.js";
import { sealedColumnsOf } from "../schema/sealed.js";
import { resolveEntity } from "../schema/tables.js";
import { currentReplicaLogState } from "./change-log.js";
import type { ReplicaLogState } from "./change-log.js";
import { replicaUnavailableColumnsOf } from "./unavailable-columns.js";
import { replicaValuePolicyOf } from "./value-policy.js";
import type { ReplicaValuePolicy } from "./value-policy.js";

/**
 * The text ceiling an entity gets when its declaration states none.
 *
 * It is a DEFAULT, not the rule: since #922 (ruling SB-text) the ceiling that
 * decides whether a text value rides in full is declared per entity in
 * `schema/entity-catalog.ts`, and a caller's `maxValueBytes` is only the
 * baseline for entities that declare nothing. The number lives beside the
 * declaration it defaults; this is the replica lane's re-export of it.
 */
export { DEFAULT_REPLICA_TEXT_CEILING_BYTES } from "../schema/entity-declaration.js";

export interface ReplicaRow {
  rowId: string;
  values: Record<string, unknown>;
  /** Last change-log sequence for this row in the current replica epoch. */
  rowVersion?: number;
  /**
   * Values omitted from `values`: a column the entity declares LAZY (bytes,
   * never text) or a text value above the entity's declared ceiling. Both
   * clients turn a deferred column into a refusal that names it
   * (`guardReplicaRow`), so a deferred value is absent but never silent.
   */
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
  /**
   * The replica epoch the caller already pinned. `withReplicaSnapshot` passes
   * the epoch it read once for the whole transaction; without it every row
   * read re-derives the log state, which is a second query per changed row on
   * the fan-out path (#922 A5).
   */
  epoch?: string;
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

/**
 * Canonical entity shapes are stable for the life of a connection: the
 * schema-changing rungs run at OPEN, before any replica read compiles against
 * the old shape (the same invariant `grant/prepared.ts` relies on). The
 * dynamic ext band is NOT stable — an app may add a table or a column while
 * the vault is open — so ext entities keep re-reading `PRAGMA table_info` and
 * only canonical entities are memoized.
 */
const SHAPES = new WeakMap<DatabaseSync, Map<string, EntityShape>>();

function readShape(vault: DatabaseSync, entity: string): EntityShape {
  const ref = resolveEntity(entity, vault);
  if (!ref) throw new Error(`unknown replica entity "${entity}"`);
  const info = vault
    .prepare(`PRAGMA table_info(${JSON.stringify(ref.physical)})`)
    .all() as unknown as ColumnInfo[];
  const sealed = [...sealedColumnsOf(entity, vault)];
  const unavailable = new Set(replicaUnavailableColumnsOf(entity, vault));
  return {
    entity,
    physical: ref.physical,
    columns: info
      .map((column) => column.name)
      .filter((column) => !unavailable.has(column)),
    sealedColumns: sealed,
    primaryKey: info
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name),
  };
}

function shapeOf(vault: DatabaseSync, entity: string): EntityShape {
  if (parseExtLogical(entity)) return readShape(vault, entity);
  let perVault = SHAPES.get(vault);
  if (!perVault) {
    perVault = new Map<string, EntityShape>();
    SHAPES.set(vault, perVault);
  }
  const hit = perVault.get(entity);
  if (hit) return hit;
  const shape = readShape(vault, entity);
  perVault.set(entity, shape);
  return shape;
}

function rowIdOf(row: Record<string, unknown>, primaryKey: string[]): string {
  if (primaryKey.length === 0)
    throw new Error("replica entities must have a primary key");
  if (primaryKey.length === 1) return String(row[primaryKey[0] ?? ""]);
  return JSON.stringify(primaryKey.map((column) => row[column]));
}

function keyValues(rowId: string, primaryKey: string[]): unknown[] {
  if (primaryKey.length === 1) return [rowId];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rowId) as unknown;
  } catch {
    throw new Error("composite replica row id must be a JSON array");
  }
  if (!Array.isArray(parsed) || parsed.length !== primaryKey.length) {
    throw new Error(
      `composite replica row id must contain ${primaryKey.length} values`
    );
  }
  return parsed;
}

function valueBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value instanceof Uint8Array) return value.byteLength;
  return Buffer.byteLength(String(value));
}

function publicRow(
  raw: Record<string, unknown>,
  shape: EntityShape,
  ceilingBytes: number,
  policy: ReplicaValuePolicy,
  rowVersion: number
): ReplicaRow {
  const values: Record<string, unknown> = {};
  const deferredColumns: string[] = [];
  for (const column of shape.columns) {
    const value = raw[column];
    // Binary data is never eager on the JSON replica lane. Canonical
    // photo/document rows carry blob URIs, so their metadata still arrives;
    // byte bodies take the dedicated lazy blob/cache path. The declaration is
    // the primary answer (#922, SB-text); the `Uint8Array` test behind it is
    // the safety net for the dynamic ext band, which has no declaration.
    if (policy.lazyColumns.has(column) || value instanceof Uint8Array) {
      deferredColumns.push(column);
      continue;
    }
    // TEXT rides in FULL up to the ceiling THIS entity declares. A flat 64 KiB
    // cap here is how a note body over ~48 KiB of prose reached no device and
    // nothing fetched it back — the hole #922 0b closes.
    if (valueBytes(value) > ceilingBytes) {
      deferredColumns.push(column);
    } else {
      values[column] = value;
    }
  }
  return {
    rowId: rowIdOf(raw, shape.primaryKey),
    values,
    deferredColumns,
    ...(rowVersion > 0 ? { rowVersion } : {}),
  };
}

function latestRowVersions(
  vault: DatabaseSync,
  entity: string,
  rowIds: readonly string[],
  epoch: string
): Map<string, number> {
  const versions = new Map<string, number>();
  for (let offset = 0; offset < rowIds.length; offset += 500) {
    const chunk = rowIds.slice(offset, offset + 500);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = vault
      .prepare(
        `SELECT row_id, MAX(seq) AS seq FROM replica_change
          WHERE epoch = ? AND entity = ? AND row_id IN (${placeholders})
          GROUP BY row_id`
      )
      .all(epoch, entity, ...chunk) as { row_id: string; seq: number | null }[];
    for (const row of rows)
      if (row.seq !== null) versions.set(row.row_id, row.seq);
  }
  return versions;
}

function validateOptions(options: ReadReplicaRowsOptions): {
  limit: number;
  maxValueBytes: number;
} {
  const limit = options.limit ?? 1_000;
  const maxValueBytes =
    options.maxValueBytes ?? DEFAULT_REPLICA_TEXT_CEILING_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError(
      "replica row page limit must be an integer between 1 and 10000"
    );
  }
  if (!Number.isSafeInteger(maxValueBytes) || maxValueBytes < 0) {
    throw new RangeError(
      "replica maxValueBytes must be a non-negative safe integer"
    );
  }
  return { limit, maxValueBytes };
}

/**
 * The ceiling in force for one entity: the entity's DECLARED text ceiling when
 * it has one, else the caller's baseline. A declaration wins over the caller
 * because it is a fact about the table, not about this read.
 */
function ceilingFor(
  entity: string,
  baselineBytes: number
): {
  ceilingBytes: number;
  policy: ReplicaValuePolicy;
} {
  const policy = replicaValuePolicyOf(entity);
  const declared =
    policy.textCeilingBytes !== DEFAULT_REPLICA_TEXT_CEILING_BYTES;
  return {
    ceilingBytes: declared ? policy.textCeilingBytes : baselineBytes,
    policy,
  };
}

/**
 * Shape-neutral row page. Sealed columns are absent structurally (never
 * placeholder/ciphertext); lazy and over-ceiling values are marked deferred.
 */
export function readReplicaRows(
  vault: DatabaseSync,
  entity: string,
  options: ReadReplicaRowsOptions = {}
): ReplicaRowsPage {
  const shape = shapeOf(vault, entity);
  if (shape.primaryKey.length === 0) {
    throw new Error(`replica entity "${entity}" has no primary key`);
  }
  const { limit, maxValueBytes } = validateOptions(options);
  const selected = shape.columns.map(quoteIdentifier).join(", ");
  const order = shape.primaryKey.map(quoteIdentifier).join(", ");
  let where = "";
  let params: unknown[] = [];
  if (options.after !== undefined) {
    const values = keyValues(options.after, shape.primaryKey);
    const lhs =
      shape.primaryKey.length === 1
        ? quoteIdentifier(shape.primaryKey[0] ?? "")
        : `(${shape.primaryKey.map(quoteIdentifier).join(", ")})`;
    const rhs =
      shape.primaryKey.length === 1
        ? "?"
        : `(${values.map(() => "?").join(", ")})`;
    where = ` WHERE ${lhs} > ${rhs}`;
    params = values;
  }
  const rawRows = prepared(
    vault,
    `SELECT ${selected} FROM ${quoteIdentifier(shape.physical)}${where}
        ORDER BY ${order} LIMIT ?`
  ).all(
    ...(params as (string | number | bigint | Uint8Array | null)[]),
    limit + 1
  ) as unknown as Record<string, unknown>[];
  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
  const rowIds = pageRows.map((row) => rowIdOf(row, shape.primaryKey));
  const versions = latestRowVersions(
    vault,
    entity,
    rowIds,
    options.epoch ?? currentReplicaLogState(vault).epoch
  );
  const { ceilingBytes, policy } = ceilingFor(entity, maxValueBytes);
  const rows = pageRows.map((row) =>
    publicRow(
      row,
      shape,
      ceilingBytes,
      policy,
      versions.get(rowIdOf(row, shape.primaryKey)) ?? 0
    )
  );
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
  options: Pick<ReadReplicaRowsOptions, "maxValueBytes" | "epoch"> = {}
): ReplicaRow | undefined {
  const shape = shapeOf(vault, entity);
  if (shape.primaryKey.length === 0) {
    throw new Error(`replica entity "${entity}" has no primary key`);
  }
  const { maxValueBytes } = validateOptions({ ...options, limit: 1 });
  const values = keyValues(rowId, shape.primaryKey);
  const where = shape.primaryKey
    .map((column) => `${quoteIdentifier(column)} = ?`)
    .join(" AND ");
  const selected = shape.columns.map(quoteIdentifier).join(", ");
  const raw = prepared(
    vault,
    `SELECT ${selected} FROM ${quoteIdentifier(shape.physical)} WHERE ${where}`
  ).get(...(values as (string | number | bigint | Uint8Array | null)[])) as
    | Record<string, unknown>
    | undefined;
  if (!raw) return undefined;
  const canonicalRowId = rowIdOf(raw, shape.primaryKey);
  const version = prepared(
    vault,
    `SELECT MAX(seq) AS seq FROM replica_change
        WHERE epoch = ? AND entity = ? AND row_id = ?`
  ).get(
    options.epoch ?? currentReplicaLogState(vault).epoch,
    entity,
    canonicalRowId
  ) as { seq: number | null };
  const { ceilingBytes, policy } = ceilingFor(entity, maxValueBytes);
  return publicRow(raw, shape, ceilingBytes, policy, version.seq ?? 0);
}

export interface ReplicaSnapshotReader {
  state: ReplicaLogState;
  readRows: (
    entity: string,
    options?: ReadReplicaRowsOptions
  ) => ReplicaRowsPage;
  readRow: (
    entity: string,
    rowId: string,
    options?: Pick<ReadReplicaRowsOptions, "maxValueBytes">
  ) => ReplicaRow | undefined;
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
  read: (reader: ReplicaSnapshotReader) => T
): ReplicaSnapshotResult<T> {
  vault.exec("BEGIN");
  try {
    const state = currentReplicaLogState(vault);
    const reader: ReplicaSnapshotReader = {
      state,
      // The snapshot already pinned the epoch; threading it keeps every row
      // read to one query instead of re-deriving the log state per row.
      readRows: (entity, options) =>
        readReplicaRows(vault, entity, { ...options, epoch: state.epoch }),
      readRow: (entity, rowId, options) =>
        readReplicaRow(vault, entity, rowId, {
          ...options,
          epoch: state.epoch,
        }),
    };
    const value = read(reader);
    vault.exec("ROLLBACK");
    return { state, value };
  } catch (error) {
    vault.exec("ROLLBACK");
    throw error;
  }
}
