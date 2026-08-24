// Turn the fixed replica read grammar into SQL the attached databases can run.
//
// Without pushdown the mounted reader `SELECT`s every row of an entity from
// every scope, `JSON.parse`s each payload, and only then applies the caller's
// filters and limit in JavaScript. On a ten-year library that is the whole
// projection crossing the JSI bridge to answer "give me 500 rows".
//
// This planner emits a **superset prefilter**: SQL that keeps every row
// `evaluateReplicaRead` would keep *and* every row that would make it throw. The
// JavaScript evaluator still runs unchanged on the reduced set, so filter
// semantics — BINARY text ordering, mixed-type `OnlineOnlyError`, oversized and
// undisclosed-field escalation — are exactly what they were. Pushdown only
// decides which rows are worth parsing.

import { ReplicaProtocolError } from "@centraid/client/replica/native";
import type {
  ReplicaBindValue,
  ReplicaFilterClause,
  ReplicaReadRequest,
  ReplicaValue,
} from "@centraid/client/replica/native";

/** Column references the planner emits; they must match the reader's aliases. */
const PAYLOAD = "r.payload_json";
const OVERSIZED = "r.oversized_json";
const UNAVAILABLE = "es.has_unavailable_fields";

/**
 * SQLite `json_type` names whose `json_extract` result compares as a JS number.
 * `evaluateReplicaRead` maps booleans through `comparable()` to 1/0 before
 * comparing, and `json_extract` yields the same 1/0, so `true`/`false` belong in
 * the numeric bucket rather than a bucket of their own.
 */
const NUMERIC_TYPES = ["integer", "real", "true", "false"] as const;
const TEXT_TYPES = ["text"] as const;
const ALL_TYPES = [
  "integer",
  "real",
  "true",
  "false",
  "text",
  "array",
  "object",
] as const;

/**
 * Column names are interpolated into JSON paths rather than bound, so the
 * grammar is restricted to plain identifiers. Anything else is left to the
 * JavaScript evaluator instead of being escaped — there is no app column this
 * rejects, and no caller text can reach SQL.
 */
const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const MAX_PUSHED_LIMIT = 100_000;

export interface ReplicaReadPlan {
  /**
   * Extra SQL for each per-scope `WHERE`, already `AND`-prefixed, or `""` when
   * nothing could be pushed.
   */
  filterSql: string;
  filterParams: ReplicaBindValue[];
  /**
   * Rows to take from each attached scope, or `undefined` for "every row".
   * Only set when the whole `where` list was pushed — a partially-pushed filter
   * would truncate rows the JavaScript evaluator has not rejected yet.
   */
  perScopeLimit?: number;
}

export interface ReplicaReadPlanInput {
  request: Pick<ReplicaReadRequest, "where" | "orderBy" | "limit">;
  /**
   * True when `dedupeReplicaRowsByContent` may collapse rows across scopes for
   * this entity, i.e. the shape exposes a content hash. Truncating each scope
   * independently would then drop a source badge a merged row should carry, so
   * the caller reads every row instead.
   */
  contentHashed: boolean;
  /** Number of attached scopes; one scope cannot lose a cross-scope badge. */
  scopeCount: number;
}

/**
 * Plan one mounted read.
 *
 * `orderBy` is deliberately **not** pushed. SQLite orders NULL < numbers < text
 * where the evaluator raises `OnlineOnlyError` on a mixed-type ordering column,
 * so an SQL `ORDER BY … LIMIT` could silently return a plausible page where the
 * canonical read demands going online. No mobile caller orders a replica read
 * today; one that does needs a type-uniformity probe added here first.
 */
export function planReplicaRead(input: ReplicaReadPlanInput): ReplicaReadPlan {
  const params: ReplicaBindValue[] = [];
  const fragments: string[] = [];
  let pushedEveryClause = true;
  for (const clause of input.request.where ?? []) {
    const fragment = clauseSql(clause, params);
    if (fragment === undefined) pushedEveryClause = false;
    else fragments.push(fragment);
  }
  const limit = perScopeLimit(input, pushedEveryClause);
  return {
    filterSql: fragments.length === 0 ? "" : ` AND ${fragments.join(" AND ")}`,
    filterParams: params,
    ...(limit === undefined ? {} : { perScopeLimit: limit }),
  };
}

function perScopeLimit(
  input: ReplicaReadPlanInput,
  pushedEveryClause: boolean
): number | undefined {
  if (!pushedEveryClause) return undefined;
  // Ordering happens in JavaScript, so an SQL page is only a *set* of rows; a
  // requested order would make which rows survive truncation meaningful.
  if (input.request.orderBy) return undefined;
  if (input.contentHashed && input.scopeCount > 1) return undefined;
  const requested = input.request.limit;
  if (requested === undefined) return undefined;
  if (!Number.isSafeInteger(requested)) {
    throw new ReplicaProtocolError("Read limit must be a safe integer");
  }
  return Math.min(Math.max(requested, 1), MAX_PUSHED_LIMIT);
}

/**
 * SQL for one clause, or `undefined` when the clause cannot be pushed safely.
 *
 * Every fragment ends with the availability escape: a row whose shape hides
 * fields, or whose value for this column was dropped for size, must still reach
 * the evaluator so it raises `OnlineOnlyError` rather than being filtered out on
 * data the device does not actually have.
 */
function clauseSql(
  clause: ReplicaFilterClause,
  params: ReplicaBindValue[]
): string | undefined {
  if (!SAFE_COLUMN.test(clause.column)) return undefined;
  const path = `'$.${clause.column}'`;
  const value = `json_extract(${PAYLOAD}, ${path})`;
  const type = `json_type(${PAYLOAD}, ${path})`;
  const pushed: ReplicaBindValue[] = [];
  const predicate = clausePredicate(clause, value, type, pushed);
  if (predicate === undefined) return undefined;
  params.push(...pushed);
  const oversized = `'"${clause.column}"'`;
  return `(${predicate} OR ${UNAVAILABLE} = 1 OR instr(${OVERSIZED}, ${oversized}) > 0)`;
}

function clausePredicate(
  clause: ReplicaFilterClause,
  value: string,
  type: string,
  pushed: ReplicaBindValue[]
): string | undefined {
  if (clause.op === "is-null") return `${value} IS NULL`;
  if (clause.op === "not-null") return `${value} IS NOT NULL`;
  // `within-days` / `within-next-days` escalate any row whose value is not a
  // canonical `toISOString()` string. SQLite cannot cheaply prove canonical-ness,
  // so a range predicate could drop a malformed row the evaluator is supposed to
  // send online. Left to JavaScript on purpose.
  if (clause.op === "within-days" || clause.op === "within-next-days")
    return undefined;
  if (clause.op === "in") return inPredicate(clause.value, value, type, pushed);

  const bucket = comparableBucket(clause.value);
  // A null comparison value makes every comparison op return false in the
  // evaluator, so no row can match — but rows with hidden fields must still
  // escalate, which the availability escape around this predicate preserves.
  if (bucket === "null") return "0";
  if (bucket === undefined) return undefined;
  pushed.push(bindValue(clause.value));
  return `((${type} IN (${quoted(bucket)}) AND ${value} ${COMPARISON[clause.op]} ?) OR ${type} IN (${quoted(escalatingTypes(bucket))}))`;
}

function inPredicate(
  candidates: ReplicaValue | undefined,
  value: string,
  type: string,
  pushed: ReplicaBindValue[]
): string | undefined {
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const buckets = new Set(candidates.map((entry) => comparableBucket(entry)));
  const [bucket] = [...buckets];
  if (buckets.size !== 1 || bucket === undefined || bucket === "null")
    return undefined;
  for (const candidate of candidates) pushed.push(bindValue(candidate));
  const placeholders = candidates.map(() => "?").join(", ");
  return `((${type} IN (${quoted(bucket)}) AND ${value} IN (${placeholders})) OR ${type} IN (${quoted(escalatingTypes(bucket))}))`;
}

const COMPARISON: Record<string, string> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

type Bucket = "null" | readonly string[];

/** Which `json_type` names compare against this value without escalating. */
function comparableBucket(value: ReplicaValue | undefined): Bucket | undefined {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return TEXT_TYPES;
  if (typeof value === "number" || typeof value === "boolean")
    return NUMERIC_TYPES;
  return undefined;
}

/**
 * The `json_type` names that make the evaluator throw rather than compare: a
 * stored value of a different JS type than the filter's. `'null'` is absent on
 * purpose — the evaluator returns false for it, so those rows are safe to drop.
 */
function escalatingTypes(bucket: readonly string[]): string[] {
  return ALL_TYPES.filter((name) => !bucket.includes(name));
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `'${name}'`).join(", ");
}

function bindValue(value: ReplicaValue | undefined): ReplicaBindValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  throw new ReplicaProtocolError("Pushdown requires scalar filter values");
}
