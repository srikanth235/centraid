import { fieldNotOnThisDevice } from "@centraid/blueprints/apps/_shared/shared-copy";

/**
 * THE `where` LIST, COMPILED TO A VERDICT (#883 C3): oversized, undisclosed,
 * non-scalar, wrong comparison class, then the comparison — one input always
 * escalates for one reason. Refusal MESSAGES are compared verbatim by
 * `read-plan-parity.test.ts`, so rewording one is a behaviour change.
 */
import { OnlineOnlyError, ReplicaProtocolError } from "./errors.js";
import type { ReplicaBindValue } from "./store-core.js";
import type {
  ReplicaEntitySchema,
  ReplicaFilterClause,
  ReplicaScalar,
  ReplicaValue,
} from "./types.js";

export type ReplicaEscalationKind = "online" | "protocol";

export interface ReplicaEscalation {
  kind: ReplicaEscalationKind;
  message: string;
}

export interface PlanBuilder {
  binds: ReplicaBindValue[];
  escalations: ReplicaEscalation[];
}

const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const PAYLOAD = "payload_json";
export const OVERSIZED = "oversized_json";

export const NUMERIC_TYPES = ["integer", "real", "true", "false"] as const;
export const TEXT_TYPES = ["text"] as const;
export const UNORDERED_TYPES = ["object", "array"] as const;

const CANONICAL_ISO_GLOB =
  "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z";
const ISO_RANGE_MIN_MS = Date.UTC(1000, 0, 1);
const ISO_RANGE_MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

const COMPARISON: Readonly<Record<string, string>> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

export function code(
  builder: PlanBuilder,
  escalation: ReplicaEscalation
): number {
  builder.escalations.push(escalation);
  return builder.escalations.length;
}

export function quoted(names: readonly string[]): string {
  return names.map((name) => `'${name}'`).join(", ");
}

export function jsonValue(column: string): string {
  return `json_extract(${PAYLOAD}, '$.${column}')`;
}

export function jsonType(column: string): string {
  return `json_type(${PAYLOAD}, '$.${column}')`;
}

export function oversized(column: string): string {
  // Quoted needle: `instr` would else match a longer name containing this.
  return `instr(${OVERSIZED}, '"${column}"') > 0`;
}

export function undisclosed(column: string): string {
  // `json_type` tells an ABSENT path from a JSON null; `json_extract` cannot.
  return `${jsonType(column)} IS NULL`;
}

type Bucket = readonly string[];

function bucketOf(value: ReplicaScalar): Bucket {
  return typeof value === "string" ? TEXT_TYPES : NUMERIC_TYPES;
}

function foreignTypes(bucket: Bucket): string[] {
  return [...NUMERIC_TYPES, ...TEXT_TYPES].filter(
    (name) => !bucket.includes(name)
  );
}

function scalarOrRaise(
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
  // D1: raised while compiling, so an empty entity raises too.
  throw new ReplicaProtocolError(`${operation} requires scalar values`);
}

function bindScalar(value: ReplicaScalar): ReplicaBindValue {
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

export function assertColumn(
  schema: ReplicaEntitySchema,
  column: string
): void {
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
  if (!SAFE_COLUMN.test(column)) {
    // D5: never spliced into the statement, declared or not.
    throw new OnlineOnlyError(
      `column ${column} cannot be expressed as a local JSON path`
    );
  }
}

export function clauseGuards(
  clause: ReplicaFilterClause,
  schema: ReplicaEntitySchema,
  builder: PlanBuilder
): string[] {
  const branches = [
    `WHEN ${oversized(clause.column)} THEN ${code(builder, {
      kind: "online",
      message: `${fieldNotOnThisDevice(clause.column)} is required by a filter`,
    })}`,
  ];
  if (schema.hasUnavailableFields) {
    branches.push(
      `WHEN ${undisclosed(clause.column)} THEN ${code(builder, {
        kind: "online",
        message: "undisclosed unavailable field is required by a filter",
      })}`
    );
  }
  return branches;
}

/** Both refusals are one `json_type` question, so they share ONE call. */
function typeBranch(
  builder: PlanBuilder,
  column: string,
  op: string,
  bucket?: Bucket
): string {
  const type = jsonType(column);
  const nonScalar = code(builder, {
    kind: "protocol",
    message: `filter ${op} requires scalar values`,
  });
  if (!bucket)
    return `WHEN ${type} IN (${quoted(UNORDERED_TYPES)}) THEN ${nonScalar}`;
  const mixed = code(builder, {
    kind: "online",
    message: "mixed-type comparison requires canonical SQLite affinity",
  });
  const escalating = [...UNORDERED_TYPES, ...foreignTypes(bucket)];
  return (
    `WHEN ${type} IN (${quoted(escalating)})` +
    ` THEN CASE WHEN ${type} IN (${quoted(UNORDERED_TYPES)})` +
    ` THEN ${nonScalar} ELSE ${mixed} END`
  );
}

interface ClauseBody {
  guards: string[];
  match: string;
}

export function clauseBody(
  clause: ReplicaFilterClause,
  builder: PlanBuilder,
  nowMs: number
): ClauseBody {
  const value = jsonValue(clause.column);
  const plain = (match: string): ClauseBody => ({
    guards: [typeBranch(builder, clause.column, clause.op)],
    match,
  });
  if (clause.op === "is-null") return plain(`${value} IS NULL`);
  if (clause.op === "not-null") return plain(`${value} IS NOT NULL`);
  if (clause.op === "in") return inBody(clause, builder, value);
  if (clause.op === "within-days" || clause.op === "within-next-days")
    return dayRangeBody(clause, builder, value, nowMs);

  const requested = scalarOrRaise(clause.value, `filter ${clause.op}`);
  // A null on either side is `false` WITHOUT comparing, so it never escalates.
  if (requested === null || requested === undefined) return plain("0");
  const bucket = bucketOf(requested);
  const guard = typeBranch(builder, clause.column, clause.op, bucket);
  builder.binds.push(bindScalar(requested));
  return { guards: [guard], match: `${value} ${COMPARISON[clause.op]} ?` };
}

function inBody(
  clause: ReplicaFilterClause,
  builder: PlanBuilder,
  value: string
): ClauseBody {
  if (!Array.isArray(clause.value) || clause.value.length === 0) {
    throw new ReplicaProtocolError('Filter op "in" requires a non-empty array');
  }
  const candidates = clause.value.map((entry) =>
    scalarOrRaise(entry, "filter in")
  );
  // A null candidate: neither a match nor a comparison class.
  const present = candidates.filter(
    (entry): entry is ReplicaScalar => entry !== null && entry !== undefined
  );
  if (present.length === 0)
    return { guards: [typeBranch(builder, clause.column, "in")], match: "0" };
  const buckets = new Set(present.map((entry) => bucketOf(entry)));
  if (buckets.size > 1) {
    // D2.
    throw new OnlineOnlyError(
      "mixed-type comparison requires canonical SQLite affinity"
    );
  }
  const guard = typeBranch(builder, clause.column, "in", [...buckets][0]);
  // ONE bound parameter: `json_each` over a bound array cannot hit a build's
  // `SQLITE_MAX_VARIABLE_NUMBER`.
  builder.binds.push(JSON.stringify(present.map(bindScalar)));
  return {
    guards: [guard],
    match: `${value} IN (SELECT value FROM json_each(?))`,
  };
}

/** Canonical ISO-8601 UTC strings are fixed width, so they order
 *  lexicographically as their instants do — once the GLOB proves them
 *  canonical. */
function dayRangeBody(
  clause: ReplicaFilterClause,
  builder: PlanBuilder,
  value: string,
  nowMs: number
): ClauseBody {
  const days = Number(scalarOrRaise(clause.value, `filter ${clause.op}`));
  if (!Number.isFinite(days) || days <= 0) {
    throw new ReplicaProtocolError(
      `Filter op "${clause.op}" requires a positive number`
    );
  }
  const type = jsonType(clause.column);
  const nonCanonical = {
    kind: "online",
    message: "non-canonical timestamp requires canonical SQLite comparison",
  } as const;
  const guards = [
    typeBranch(builder, clause.column, clause.op),
    `WHEN ${type} IS NULL OR ${type} = 'null' THEN ${code(
      builder,
      nonCanonical
    )}`,
    // Non-text, or a stamp the canonical form does not cover (D4).
    `WHEN ${type} NOT IN (${quoted(TEXT_TYPES)})` +
      ` OR ${value} NOT GLOB '${CANONICAL_ISO_GLOB}' THEN ${code(
        builder,
        nonCanonical
      )}`,
  ];
  const span = days * 86_400_000;
  // Round a fractional boundary INWARD: a canonical stamp carries whole
  // milliseconds.
  const bounds =
    clause.op === "within-days"
      ? [{ op: ">=", ms: Math.ceil(nowMs - span) }]
      : [
          { op: ">=", ms: nowMs },
          { op: "<=", ms: Math.floor(nowMs + span) },
        ];
  const tests: string[] = [];
  for (const bound of bounds) {
    // Outside the canonical range every stamp falls on one side of the bound,
    // so it admits everything or nothing.
    const beyond = bound.ms > ISO_RANGE_MAX_MS;
    const before = bound.ms < ISO_RANGE_MIN_MS;
    if (beyond || before) {
      const admitsAll = bound.op === ">=" ? before : beyond;
      if (admitsAll) continue;
      return { guards, match: "0" };
    }
    builder.binds.push(new Date(bound.ms).toISOString());
    tests.push(`${value} ${bound.op} ?`);
  }
  return { guards, match: tests.length === 0 ? "1" : tests.join(" AND ") };
}
