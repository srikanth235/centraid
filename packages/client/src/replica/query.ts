import { PENDING_OVERLAY_FIELDS } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { fieldNotOnThisDevice } from "@centraid/blueprints/apps/_shared/shared-copy";

import type { OnlineOnlyGuard } from "./errors.js";
import { OnlineOnlyError, ReplicaProtocolError } from "./errors.js";
import type {
  OptimisticMutation,
  ReplicaEntitySchema,
  ReplicaFilterClause,
  ReplicaReadRequest,
  ReplicaRow,
  ReplicaRowEnvelope,
  ReplicaScalar,
  ReplicaValue,
} from "./types.js";
import { REPLICA_SYNTHETIC_PRIMARY_KEY } from "./types.js";

function unavailableReason(
  row: ReplicaRowEnvelope,
  column: string
): string | undefined {
  if (row.oversizedFields.includes(column)) return fieldNotOnThisDevice(column);
  if (row.hasUnavailableFields && !(column in row.values))
    return "undisclosed unavailable field";
  return undefined;
}

function assertColumn(schema: ReplicaEntitySchema, column: string): void {
  if (!schema.columns.includes(column)) {
    if (schema.hasUnavailableFields) {
      throw new OnlineOnlyError(
        "an undisclosed field is required by the query"
      );
    }
    throw new ReplicaProtocolError(
      `Unknown column "${column}" on ${schema.entity}`
    );
  }
}

function scalar(
  value: ReplicaValue | undefined,
  operation: string
): ReplicaScalar | undefined {
  if (value === undefined || value === null) return value;
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  throw new ReplicaProtocolError(`${operation} requires scalar values`);
}

function comparable(
  value: ReplicaScalar | undefined
): string | number | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

// Lifting surrogates above `U+FFFF` makes UTF-16 unit order match UTF-8 byte
// order (SQLite BINARY). Well-formed text only.
const SURROGATE_LIFT = 0x28_00;

function compareBinaryText(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a !== b) return codePointKey(a) - codePointKey(b);
  }
  return left.length - right.length;
}

function codePointKey(unit: number): number {
  return unit >= 0xd8_00 && unit <= 0xdf_ff ? unit + SURROGATE_LIFT : unit;
}

function compare(
  left: ReplicaScalar | undefined,
  right: ReplicaScalar | undefined
): number {
  const a = comparable(left);
  const b = comparable(right);
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  // No column affinity on the wire: mixed TEXT/NUMERIC can differ from the
  // canonical read — rerun online, never invent a JS type order.
  if (typeof a !== typeof b) {
    throw new OnlineOnlyError(
      "mixed-type comparison requires canonical SQLite affinity"
    );
  }
  return compareBinaryText(String(a), String(b));
}

function assertAvailable(
  row: ReplicaRowEnvelope,
  clause: ReplicaFilterClause
): void {
  const reason = unavailableReason(row, clause.column);
  if (reason) throw new OnlineOnlyError(`${reason} is required by a filter`);
}

function matches(
  row: ReplicaRowEnvelope,
  clause: ReplicaFilterClause,
  nowMs: number
): boolean {
  assertAvailable(row, clause);
  const rowValue = scalar(row.values[clause.column], `filter ${clause.op}`);
  if (clause.op === "is-null")
    return rowValue === null || rowValue === undefined;
  if (clause.op === "not-null")
    return rowValue !== null && rowValue !== undefined;
  if (clause.op === "in") {
    if (!Array.isArray(clause.value) || clause.value.length === 0) {
      throw new ReplicaProtocolError(
        'Filter op "in" requires a non-empty array'
      );
    }
    if (rowValue === null || rowValue === undefined) return false;
    return clause.value.some(
      (candidate) => compare(rowValue, scalar(candidate, "filter in")) === 0
    );
  }
  if (clause.op === "within-days" || clause.op === "within-next-days") {
    const days = Number(scalar(clause.value, `filter ${clause.op}`));
    if (!Number.isFinite(days) || days <= 0) {
      throw new ReplicaProtocolError(
        `Filter op "${clause.op}" requires a positive number`
      );
    }
    const valueMs =
      typeof rowValue === "string" ? Date.parse(rowValue) : Number.NaN;
    if (
      typeof rowValue !== "string" ||
      !Number.isFinite(valueMs) ||
      new Date(valueMs).toISOString() !== rowValue
    ) {
      throw new OnlineOnlyError(
        "non-canonical timestamp requires canonical SQLite comparison"
      );
    }
    const span = days * 86_400_000;
    return clause.op === "within-days"
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
    case "eq":
      return result === 0;
    case "ne":
      return result !== 0;
    case "lt":
      return result < 0;
    case "lte":
      return result <= 0;
    case "gt":
      return result > 0;
    case "gte":
      return result >= 0;
  }
}

export function applyOptimisticMutations(
  canonical: ReplicaRowEnvelope[],
  mutations: OptimisticMutation[],
  schema: ReplicaEntitySchema
): ReplicaRowEnvelope[] {
  const rows = new Map(
    canonical.map((row) => [
      row.rowId,
      {
        rowId: row.rowId,
        values: { ...row.values },
        oversizedFields: [...row.oversizedFields],
        hasUnavailableFields: row.hasUnavailableFields,
        ...(row.rowVersion === undefined ? {} : { rowVersion: row.rowVersion }),
      },
    ])
  );
  for (const mutation of mutations) {
    if (mutation.entity !== schema.entity) continue;
    try {
      validateOptimisticMutation(mutation, schema, rows.has(mutation.rowId));
    } catch (error) {
      // A bad durable intent must not poison every read of its entity; new
      // ones are rejected at enqueue.
      if (
        error instanceof ReplicaProtocolError ||
        error instanceof OnlineOnlyError
      )
        continue;
      throw error;
    }
    if (mutation.op === "delete") {
      rows.delete(mutation.rowId);
      continue;
    }
    const current = rows.get(mutation.rowId);
    const supplied = new Set(Object.keys(mutation.values));
    rows.set(mutation.rowId, {
      rowId: mutation.rowId,
      values: { ...current?.values, ...mutation.values },
      oversizedFields: (current?.oversizedFields ?? []).filter(
        (field) => !supplied.has(field)
      ),
      hasUnavailableFields:
        current?.hasUnavailableFields ?? schema.hasUnavailableFields === true,
      ...(current?.rowVersion === undefined
        ? {}
        : { rowVersion: current.rowVersion }),
    });
  }
  return [...rows.values()];
}

export function validateOptimisticMutation(
  mutation: OptimisticMutation,
  schema: ReplicaEntitySchema,
  rowAlreadyExists = true
): void {
  if (mutation.entity !== schema.entity) {
    throw new ReplicaProtocolError(
      `Shape schema does not contain ${mutation.entity}`
    );
  }
  if (mutation.op === "delete") return;
  const metadataFields = new Set<string>(Object.values(PENDING_OVERLAY_FIELDS));
  for (const column of Object.keys(mutation.values)) {
    if (!metadataFields.has(column)) assertColumn(schema, column);
  }
  const predictedPrimaryKey = mutation.values[schema.primaryKey];
  if (
    (!rowAlreadyExists && predictedPrimaryKey === undefined) ||
    (predictedPrimaryKey !== undefined &&
      String(predictedPrimaryKey) !== mutation.rowId)
  ) {
    throw new ReplicaProtocolError(
      `Optimistic row id does not match ${schema.entity}.${schema.primaryKey}`
    );
  }
}

/**
 * Fixed-grammar local equivalent of ctx.vault.read. No caller text becomes SQL.
 * The store compiles the grammar to SQL (`read-plan.ts`); with no production
 * caller left, this survives as the pushdown parity oracle.
 */
export function evaluateReplicaRead(
  canonical: ReplicaRowEnvelope[],
  schema: ReplicaEntitySchema,
  request: ReplicaReadRequest,
  mutations: OptimisticMutation[] = [],
  now: Date = new Date()
): ReplicaRowEnvelope[] {
  if (schema.entity !== request.entity) {
    throw new ReplicaProtocolError(
      `Shape schema does not contain ${request.entity}`
    );
  }
  for (const clause of request.where ?? []) assertColumn(schema, clause.column);
  if (request.orderBy) assertColumn(schema, request.orderBy.column);

  let rows = applyOptimisticMutations(canonical, mutations, schema);
  const nowMs = now.getTime();
  rows = rows.filter((row) =>
    (request.where ?? []).every((clause) => matches(row, clause, nowMs))
  );
  if (request.orderBy) {
    const { column, dir = "asc" } = request.orderBy;
    if (dir !== "asc" && dir !== "desc") {
      throw new ReplicaProtocolError(`Unknown order direction ${String(dir)}`);
    }
    for (const row of rows) {
      const reason = unavailableReason(row, column);
      if (reason)
        throw new OnlineOnlyError(`${reason} is required for ordering`);
    }
    const visiblePrimaryKey =
      schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY
        ? undefined
        : schema.primaryKey;
    rows.sort((left, right) => {
      const ordered = compare(
        scalar(left.values[column], "orderBy"),
        scalar(right.values[column], "orderBy")
      );
      if (ordered !== 0) return dir === "desc" ? -ordered : ordered;
      if (!visiblePrimaryKey || visiblePrimaryKey === column) return 0;
      // Canonical reads tie-break on the exposed scalar PK, ascending BINARY —
      // mirror it or ORDER BY ... LIMIT drifts across refreshes.
      return compare(
        scalar(left.values[visiblePrimaryKey], "primary-key orderBy tie-break"),
        scalar(right.values[visiblePrimaryKey], "primary-key orderBy tie-break")
      );
    });
    if (!visiblePrimaryKey) {
      for (let index = 1; index < rows.length; index += 1) {
        const previous = scalar(rows[index - 1]?.values[column], "orderBy");
        const current = scalar(rows[index]?.values[column], "orderBy");
        if (compare(previous, current) === 0) {
          throw new OnlineOnlyError(
            "ORDER BY ties require an exposed scalar primary key or canonical SQLite ordering"
          );
        }
      }
    }
  }
  const requestedLimit = request.limit ?? 1000;
  if (!Number.isSafeInteger(requestedLimit)) {
    throw new ReplicaProtocolError("Read limit must be a safe integer");
  }
  // Local SQLite-derived data, not a network response; a ten-year Photos
  // library exceeds 10k rows.
  const limit = Math.min(Math.max(requestedLimit, 1), 100_000);
  return rows.slice(0, limit);
}

/**
 * Wrap one row so touching a field this replica does not hold escalates online
 * instead of reading `undefined`. Never gate it behind a dev flag.
 */
export function guardReplicaRow(
  envelope: ReplicaRowEnvelope,
  guard: OnlineOnlyGuard
): ReplicaRow {
  if (envelope.oversizedFields.length === 0 && !envelope.hasUnavailableFields)
    return { ...envelope.values };
  const unavailable = new Map<string, string>();
  for (const field of envelope.oversizedFields)
    unavailable.set(field, fieldNotOnThisDevice(field));
  const fail = (field?: PropertyKey): never => {
    const reason =
      typeof field === "string" ? unavailable.get(field) : undefined;
    throw guard.mark(reason ?? "accessing undisclosed unavailable fields");
  };
  return new Proxy(
    { ...envelope.values },
    {
      get(target, property, receiver) {
        if (typeof property === "string" && unavailable.has(property))
          fail(property);
        if (
          typeof property === "string" &&
          envelope.hasUnavailableFields &&
          !Reflect.has(target, property)
        )
          fail(property);
        return Reflect.get(target, property, receiver) as
          | ReplicaValue
          | undefined;
      },
      has(target, property) {
        if (typeof property === "string" && unavailable.has(property))
          fail(property);
        if (
          typeof property === "string" &&
          envelope.hasUnavailableFields &&
          !Reflect.has(target, property)
        )
          fail(property);
        return Reflect.has(target, property);
      },
      getOwnPropertyDescriptor(target, property) {
        if (typeof property === "string" && unavailable.has(property))
          fail(property);
        if (
          typeof property === "string" &&
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
    }
  );
}
