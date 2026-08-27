// Replica read grammar as SQL. SUPERSET PREFILTER ONLY: keep every row the
// evaluator keeps AND every row it throws on. What cannot, is left unpushed.

import { ReplicaProtocolError } from "@centraid/client/replica/native";
import type {
  ReplicaBindValue,
  ReplicaFilterClause,
  ReplicaReadRequest,
  ReplicaValue,
} from "@centraid/client/replica/native";

import {
  REPLICA_CAN_WRITE,
  REPLICA_SCOPE_ID,
  REPLICA_SCOPE_IDS,
  REPLICA_SCOPE_LABEL,
  REPLICA_SCOPE_LABELS,
  REPLICA_WRITABLE_SCOPE_IDS,
} from "./multi-vault-provenance";

const PAYLOAD = "r.payload_json";
const OVERSIZED = "r.oversized_json";
const UNAVAILABLE = "es.has_unavailable_fields";

const NUMERIC_TYPES = ["integer", "real", "true", "false"] as const;
const TEXT_TYPES = ["text"] as const;
const UNORDERED_TYPES = ["array", "object"] as const;
const ALL_TYPES = [
  "integer",
  "real",
  "true",
  "false",
  "text",
  "array",
  "object",
] as const;

/** Interpolated into JSON paths, not bound — anything else stays in JS. */
const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Mounted-scope provenance is composed onto the envelope AFTER SQL has run, so
 * `payload_json` never holds it. A pushed predicate or ORDER BY on one of these
 * would read NULL for every row while the evaluator reads a real value, so they
 * are never pushed.
 */
const PROVENANCE_COLUMNS = new Set<string>([
  REPLICA_SCOPE_ID,
  REPLICA_SCOPE_LABEL,
  REPLICA_SCOPE_IDS,
  REPLICA_SCOPE_LABELS,
  REPLICA_WRITABLE_SCOPE_IDS,
  REPLICA_CAN_WRITE,
]);

/**
 * Ceiling on one pushed per-scope page. It mirrors `evaluateReplicaRead`'s own
 * 100,000-row cap, so clamping here can never drop a row the unpushed read
 * would have returned. It is still less than the caller asked for: when a
 * request above this ceiling actually fills a scope page, the mounted reader
 * reports `coverage: "partial"` rather than presenting a capped page as the
 * whole answer.
 */
const MAX_PUSHED_LIMIT = 100_000;

export interface ReplicaReadPlan {
  filterSql: string;
  filterParams: ReplicaBindValue[];
  /** Per-scope `ORDER BY`; empty unless the page below is an ordered one. */
  orderSql: string;
  /** Set only when the whole `where` list pushed; a partial one truncates early. */
  perScopeLimit?: number;
  /** True when `MAX_PUSHED_LIMIT` cut the caller's limit down to size. */
  clampedLimit?: boolean;
}

/** Proof, from `replicaOrderProbeSql`, that an order column pages safely. */
export interface ReplicaOrderPushdown {
  /** The evaluator's fixed tie-break: the exposed scalar primary key, ASC. */
  primaryKey: string;
}

export interface ReplicaReadPlanInput {
  request: Pick<ReplicaReadRequest, "where" | "orderBy" | "limit">;
  /** Per-scope truncation drops a badge on collapsed rows. */
  contentHashed: boolean;
  scopeCount: number;
  /** Absent means the order column was not proven pageable; the read stays whole. */
  orderPushdown?: ReplicaOrderPushdown;
}

export interface ReplicaFilterPlan {
  sql: string;
  params: ReplicaBindValue[];
  /** False when a clause stayed in JavaScript, which forbids any page. */
  complete: boolean;
}

/**
 * An ordered pushed read is a per-scope top-`limit` page.
 *
 * SAFETY: under ONE total order key the global top-`limit` is contained in the
 * union of the per-scope top-`limit` pages — a row outside its own scope's page
 * already has `limit` rows ahead of it in that scope alone, so it cannot be
 * inside the global page either. The union is therefore a superset that the JS
 * evaluator re-sorts and truncates, which keeps the evaluator the authority on
 * the final order rather than SQLite's collation.
 *
 * That argument needs the SQL key to be the SAME total order the evaluator
 * uses. Two things supply it. The page carries the evaluator's primary-key
 * tie-break, so a tied order value cannot hand back a different subset than the
 * unpushed read. And `replicaOrderProbeSql` must first prove both columns
 * type-uniform and disclosed: SQLite orders NULL < numeric < text, while the
 * evaluator ESCALATES a mixed-type comparison and an undisclosed column, so a
 * page could otherwise hide the very row that escalates. Within one class the
 * two agree — numbers compare numerically, and text compares BINARY over the
 * same UTF-8 bytes as the evaluator's `compareBinaryText`.
 */
export function planReplicaRead(input: ReplicaReadPlanInput): ReplicaReadPlan {
  const filter = replicaFilterSql(input.request.where);
  const page = perScopePage(input, filter.complete);
  return {
    filterSql: filter.sql,
    filterParams: filter.params,
    orderSql: page?.orderSql ?? "",
    ...(page === undefined
      ? {}
      : { perScopeLimit: page.limit, clampedLimit: page.clamped }),
  };
}

/** The `where` list as SQL, shared by the read plan and the order probe. */
export function replicaFilterSql(
  where: readonly ReplicaFilterClause[] | undefined
): ReplicaFilterPlan {
  const params: ReplicaBindValue[] = [];
  const fragments: string[] = [];
  let complete = true;
  for (const clause of where ?? []) {
    const fragment = clauseSql(clause, params);
    if (fragment === undefined) complete = false;
    else fragments.push(fragment);
  }
  return {
    sql: fragments.length === 0 ? "" : ` AND ${fragments.join(" AND ")}`,
    params,
    complete,
  };
}

interface PerScopePage {
  limit: number;
  clamped: boolean;
  orderSql: string;
}

function perScopePage(
  input: ReplicaReadPlanInput,
  pushedEveryClause: boolean
): PerScopePage | undefined {
  if (!pushedEveryClause) return undefined;
  if (input.contentHashed && input.scopeCount > 1) return undefined;
  const requested = input.request.limit;
  if (requested === undefined) return undefined;
  if (!Number.isSafeInteger(requested)) {
    throw new ReplicaProtocolError("Read limit must be a safe integer");
  }
  const orderSql = pagedOrderSql(input);
  if (orderSql === undefined) return undefined;
  const limit = Math.min(Math.max(requested, 1), MAX_PUSHED_LIMIT);
  return { limit, clamped: limit < requested, orderSql };
}

/** `""` for an unordered page, `undefined` when the order forbids paging. */
function pagedOrderSql(input: ReplicaReadPlanInput): string | undefined {
  const orderBy = input.request.orderBy;
  if (!orderBy) return "";
  const proof = input.orderPushdown;
  if (!proof) return undefined;
  if (!pushableColumn(orderBy.column) || !pushableColumn(proof.primaryKey))
    return undefined;
  const direction = orderBy.dir === "desc" ? "DESC" : "ASC";
  return ` ORDER BY ${jsonValue(orderBy.column)} ${direction}, ${jsonValue(proof.primaryKey)} ASC`;
}

/** One row per scope; `max()` over an empty scope yields NULL, read as absent. */
export interface ReplicaOrderProbeRow {
  order_text: number | null;
  order_numeric: number | null;
  order_unordered: number | null;
  order_withheld: number | null;
  key_text: number | null;
  key_numeric: number | null;
  key_unordered: number | null;
}

/**
 * Select list that decides, in one aggregate pass inside SQLite, whether an
 * ordered page is safe: are the order column and the tie-break key each of ONE
 * comparable type across the whole filtered set, and is the order column
 * disclosed on every row? No payload crosses into JS to answer it. Undefined
 * when either column cannot be expressed as a JSON path.
 */
export function replicaOrderProbeSql(
  column: string,
  primaryKey: string
): string | undefined {
  if (!pushableColumn(column) || !pushableColumn(primaryKey)) return undefined;
  return [
    typeFlags("order", column),
    `max(CASE WHEN instr(${OVERSIZED}, '"${column}"') > 0 THEN 1 ELSE 0 END) AS order_withheld`,
    typeFlags("key", primaryKey),
  ].join(", ");
}

function typeFlags(prefix: string, column: string): string {
  const type = `json_type(${PAYLOAD}, '$.${column}')`;
  return [
    `max(${type} IN (${quoted(TEXT_TYPES)})) AS ${prefix}_text`,
    `max(${type} IN (${quoted(NUMERIC_TYPES)})) AS ${prefix}_numeric`,
    `max(${type} IN (${quoted(UNORDERED_TYPES)})) AS ${prefix}_unordered`,
  ].join(", ");
}

/** Fold every scope's probe row into one verdict for the merged read. */
export function replicaOrderPagesSafely(
  rows: readonly ReplicaOrderProbeRow[]
): boolean {
  const seen = (pick: (row: ReplicaOrderProbeRow) => number | null): boolean =>
    rows.some((row) => (pick(row) ?? 0) === 1);
  // An oversized order column, and an array or object under it, are what the
  // evaluator refuses outright; a page could hide the row that carries them.
  if (seen((row) => row.order_withheld)) return false;
  if (seen((row) => row.order_unordered) || seen((row) => row.key_unordered))
    return false;
  // Both classes present anywhere in the MERGED set is exactly the comparison
  // the evaluator escalates on, so neither column may straddle them.
  if (seen((row) => row.order_text) && seen((row) => row.order_numeric))
    return false;
  return !(seen((row) => row.key_text) && seen((row) => row.key_numeric));
}

/** Every fragment carries the availability escape: hidden or oversized fields
 *  must reach the evaluator. */
function clauseSql(
  clause: ReplicaFilterClause,
  params: ReplicaBindValue[]
): string | undefined {
  if (!pushableColumn(clause.column)) return undefined;
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
  // Day ranges escalate non-canonical stamps; SQL cannot spot them.
  if (clause.op === "within-days" || clause.op === "within-next-days")
    return undefined;
  if (clause.op === "in") return inPredicate(clause.value, value, type, pushed);

  const bucket = comparableBucket(clause.value);
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

function comparableBucket(value: ReplicaValue | undefined): Bucket | undefined {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return TEXT_TYPES;
  if (typeof value === "number" || typeof value === "boolean")
    return NUMERIC_TYPES;
  return undefined;
}

/** Types the evaluator throws on; `'null'` compares false, so it is out. */
function escalatingTypes(bucket: readonly string[]): string[] {
  return ALL_TYPES.filter((name) => !bucket.includes(name));
}

function pushableColumn(column: string): boolean {
  return SAFE_COLUMN.test(column) && !PROVENANCE_COLUMNS.has(column);
}

function jsonValue(column: string): string {
  return `json_extract(${PAYLOAD}, '$.${column}')`;
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `'${name}'`).join(", ");
}

function bindValue(value: ReplicaValue | undefined): ReplicaBindValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  throw new ReplicaProtocolError("Pushdown requires scalar filter values");
}
