import { OnlineOnlyError, OnlineOnlyGuard, ReplicaProtocolError } from './errors.js';
import type {
  OptimisticMutation,
  ReplicaEntitySchema,
  ReplicaFilterClause,
  ReplicaReadRequest,
  ReplicaRow,
  ReplicaRowEnvelope,
  ReplicaScalar,
  ReplicaValue,
} from './types.js';
import { REPLICA_SYNTHETIC_PRIMARY_KEY } from './types.js';

function unavailableReason(row: ReplicaRowEnvelope, column: string): string | undefined {
  if (row.oversizedFields.includes(column)) return `oversized field ${column}`;
  if (row.hasUnavailableFields && !(column in row.values)) return 'undisclosed unavailable field';
  return undefined;
}

function assertColumn(schema: ReplicaEntitySchema, column: string): void {
  if (!schema.columns.includes(column)) {
    if (schema.hasUnavailableFields) {
      throw new OnlineOnlyError('an undisclosed field is required by the query');
    }
    throw new ReplicaProtocolError(`Unknown column "${column}" on ${schema.entity}`);
  }
}

function scalar(value: ReplicaValue | undefined, operation: string): ReplicaScalar | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  throw new ReplicaProtocolError(`${operation} requires scalar values`);
}

function comparable(value: ReplicaScalar | undefined): string | number | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

const textEncoder = new TextEncoder();

function compareBinaryText(left: string, right: string): number {
  const a = textEncoder.encode(left);
  const b = textEncoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function compare(left: ReplicaScalar | undefined, right: ReplicaScalar | undefined): number {
  const a = comparable(left);
  const b = comparable(right);
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  // The replica wire does not carry a physical SQLite column affinity. Mixed
  // TEXT/NUMERIC comparisons can therefore differ from the canonical SQL
  // read; transparently rerun online instead of inventing a JS type order.
  if (typeof a !== typeof b) {
    throw new OnlineOnlyError('mixed-type comparison requires canonical SQLite affinity');
  }
  return compareBinaryText(String(a), String(b));
}

function assertAvailable(row: ReplicaRowEnvelope, clause: ReplicaFilterClause): void {
  const reason = unavailableReason(row, clause.column);
  if (reason) throw new OnlineOnlyError(`${reason} is required by a filter`);
}

function matches(row: ReplicaRowEnvelope, clause: ReplicaFilterClause, nowMs: number): boolean {
  assertAvailable(row, clause);
  const rowValue = scalar(row.values[clause.column], `filter ${clause.op}`);
  if (clause.op === 'is-null') return rowValue === null || rowValue === undefined;
  if (clause.op === 'not-null') return rowValue !== null && rowValue !== undefined;
  if (clause.op === 'in') {
    if (!Array.isArray(clause.value) || clause.value.length === 0) {
      throw new ReplicaProtocolError('Filter op "in" requires a non-empty array');
    }
    if (rowValue === null || rowValue === undefined) return false;
    return clause.value.some(
      (candidate) => compare(rowValue, scalar(candidate, 'filter in')) === 0,
    );
  }
  if (clause.op === 'within-days' || clause.op === 'within-next-days') {
    const days = Number(scalar(clause.value, `filter ${clause.op}`));
    if (!Number.isFinite(days) || days <= 0) {
      throw new ReplicaProtocolError(`Filter op "${clause.op}" requires a positive number`);
    }
    const valueMs = typeof rowValue === 'string' ? Date.parse(rowValue) : Number.NaN;
    if (
      typeof rowValue !== 'string' ||
      !Number.isFinite(valueMs) ||
      new Date(valueMs).toISOString() !== rowValue
    ) {
      throw new OnlineOnlyError('non-canonical timestamp requires canonical SQLite comparison');
    }
    const span = days * 86_400_000;
    return clause.op === 'within-days'
      ? valueMs >= nowMs - span
      : valueMs >= nowMs && valueMs <= nowMs + span;
  }
  const requested = scalar(clause.value, `filter ${clause.op}`);
  if (
    rowValue === null ||
    rowValue === undefined ||
    requested === null ||
    requested === undefined
  ) {
    return false;
  }
  const result = compare(rowValue, requested);
  switch (clause.op) {
    case 'eq':
      return result === 0;
    case 'ne':
      return result !== 0;
    case 'lt':
      return result < 0;
    case 'lte':
      return result <= 0;
    case 'gt':
      return result > 0;
    case 'gte':
      return result >= 0;
  }
}

export function applyOptimisticMutations(
  canonical: ReplicaRowEnvelope[],
  mutations: OptimisticMutation[],
  schema: ReplicaEntitySchema,
): ReplicaRowEnvelope[] {
  const rows = new Map(
    canonical.map((row) => [
      row.rowId,
      {
        rowId: row.rowId,
        values: { ...row.values },
        oversizedFields: [...row.oversizedFields],
        hasUnavailableFields: row.hasUnavailableFields,
      },
    ]),
  );
  for (const mutation of mutations) {
    if (mutation.entity !== schema.entity) continue;
    try {
      validateOptimisticMutation(mutation, schema, rows.has(mutation.rowId));
    } catch (error) {
      // A legacy/bad durable intent must not poison every read of its entity.
      // New intents are rejected at enqueue; old records are ignored here.
      if (error instanceof ReplicaProtocolError || error instanceof OnlineOnlyError) continue;
      throw error;
    }
    if (mutation.op === 'delete') {
      rows.delete(mutation.rowId);
      continue;
    }
    const current = rows.get(mutation.rowId);
    const supplied = new Set(Object.keys(mutation.values));
    rows.set(mutation.rowId, {
      rowId: mutation.rowId,
      values: { ...current?.values, ...mutation.values },
      oversizedFields: (current?.oversizedFields ?? []).filter((field) => !supplied.has(field)),
      hasUnavailableFields: current?.hasUnavailableFields ?? schema.hasUnavailableFields === true,
    });
  }
  return [...rows.values()];
}

/** Validate an optimistic mutation before it enters the durable outbox. */
export function validateOptimisticMutation(
  mutation: OptimisticMutation,
  schema: ReplicaEntitySchema,
  rowAlreadyExists = true,
): void {
  if (mutation.entity !== schema.entity) {
    throw new ReplicaProtocolError(`Shape schema does not contain ${mutation.entity}`);
  }
  if (mutation.op === 'delete') return;
  for (const column of Object.keys(mutation.values)) assertColumn(schema, column);
  const predictedPrimaryKey = mutation.values[schema.primaryKey];
  if (
    (!rowAlreadyExists && predictedPrimaryKey === undefined) ||
    (predictedPrimaryKey !== undefined && String(predictedPrimaryKey) !== mutation.rowId)
  ) {
    throw new ReplicaProtocolError(
      `Optimistic row id does not match ${schema.entity}.${schema.primaryKey}`,
    );
  }
}

/** Fixed-grammar local equivalent of ctx.vault.read. No caller text becomes SQL. */
export function evaluateReplicaRead(
  canonical: ReplicaRowEnvelope[],
  schema: ReplicaEntitySchema,
  request: ReplicaReadRequest,
  mutations: OptimisticMutation[] = [],
  now: Date = new Date(),
): ReplicaRowEnvelope[] {
  if (schema.entity !== request.entity) {
    throw new ReplicaProtocolError(`Shape schema does not contain ${request.entity}`);
  }
  for (const clause of request.where ?? []) assertColumn(schema, clause.column);
  if (request.orderBy) assertColumn(schema, request.orderBy.column);

  let rows = applyOptimisticMutations(canonical, mutations, schema);
  const nowMs = now.getTime();
  rows = rows.filter((row) => (request.where ?? []).every((clause) => matches(row, clause, nowMs)));
  if (request.orderBy) {
    const { column, dir = 'asc' } = request.orderBy;
    if (dir !== 'asc' && dir !== 'desc') {
      throw new ReplicaProtocolError(`Unknown order direction ${String(dir)}`);
    }
    for (const row of rows) {
      const reason = unavailableReason(row, column);
      if (reason) throw new OnlineOnlyError(`${reason} is required for ordering`);
    }
    const visiblePrimaryKey =
      schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY ? undefined : schema.primaryKey;
    rows.sort((left, right) => {
      const ordered = compare(
        scalar(left.values[column], 'orderBy'),
        scalar(right.values[column], 'orderBy'),
      );
      if (ordered !== 0) return dir === 'desc' ? -ordered : ordered;
      if (!visiblePrimaryKey || visiblePrimaryKey === column) return 0;
      // Canonical reads append the exposed scalar PK in ascending BINARY
      // order. Mirroring that fixed tie-break makes ORDER BY ... LIMIT stable
      // across refreshes without exposing a masked/composite identity.
      return compare(
        scalar(left.values[visiblePrimaryKey], 'primary-key orderBy tie-break'),
        scalar(right.values[visiblePrimaryKey], 'primary-key orderBy tie-break'),
      );
    });
    if (!visiblePrimaryKey) {
      for (let index = 1; index < rows.length; index += 1) {
        const previous = scalar(rows[index - 1]?.values[column], 'orderBy');
        const current = scalar(rows[index]?.values[column], 'orderBy');
        if (compare(previous, current) === 0) {
          throw new OnlineOnlyError(
            'ORDER BY ties require an exposed scalar primary key or canonical SQLite ordering',
          );
        }
      }
    }
  }
  const requestedLimit = request.limit ?? 1000;
  if (!Number.isSafeInteger(requestedLimit)) {
    throw new ReplicaProtocolError('Read limit must be a safe integer');
  }
  const limit = Math.min(Math.max(requestedLimit, 1), 10_000);
  return rows.slice(0, limit);
}

export function guardReplicaRow(envelope: ReplicaRowEnvelope, guard: OnlineOnlyGuard): ReplicaRow {
  const unavailable = new Map<string, string>();
  for (const field of envelope.oversizedFields) unavailable.set(field, `oversized field ${field}`);
  const fail = (field?: PropertyKey): never => {
    const reason = typeof field === 'string' ? unavailable.get(field) : undefined;
    throw guard.mark(reason ?? 'accessing undisclosed unavailable fields');
  };
  return new Proxy(
    { ...envelope.values },
    {
      get(target, property, receiver) {
        if (typeof property === 'string' && unavailable.has(property)) fail(property);
        if (
          typeof property === 'string' &&
          envelope.hasUnavailableFields &&
          !Reflect.has(target, property)
        )
          fail(property);
        return Reflect.get(target, property, receiver) as ReplicaValue | undefined;
      },
      has(target, property) {
        if (typeof property === 'string' && unavailable.has(property)) fail(property);
        if (
          typeof property === 'string' &&
          envelope.hasUnavailableFields &&
          !Reflect.has(target, property)
        )
          fail(property);
        return Reflect.has(target, property);
      },
      getOwnPropertyDescriptor(target, property) {
        if (typeof property === 'string' && unavailable.has(property)) fail(property);
        if (
          typeof property === 'string' &&
          envelope.hasUnavailableFields &&
          !Reflect.has(target, property)
        )
          fail(property);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys(target) {
        if (unavailable.size > 0 || envelope.hasUnavailableFields) fail();
        return Reflect.ownKeys(target);
      },
    },
  );
}
