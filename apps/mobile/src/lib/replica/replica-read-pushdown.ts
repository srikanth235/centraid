// Replica read grammar as SQL. SUPERSET PREFILTER ONLY: keep every row the
// evaluator keeps AND every row it throws on. What cannot, is left unpushed.

import { ReplicaProtocolError } from "@centraid/client/replica/native";
import type {
  ReplicaBindValue,
  ReplicaFilterClause,
  ReplicaReadRequest,
  ReplicaValue,
} from "@centraid/client/replica/native";

const PAYLOAD = "r.payload_json";
const OVERSIZED = "r.oversized_json";
const UNAVAILABLE = "es.has_unavailable_fields";

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

/** Interpolated into JSON paths, not bound — anything else stays in JS. */
const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const MAX_PUSHED_LIMIT = 100_000;

export interface ReplicaReadPlan {
  filterSql: string;
  filterParams: ReplicaBindValue[];
  /** Set only when the whole `where` list pushed; a partial one truncates early. */
  perScopeLimit?: number;
}

export interface ReplicaReadPlanInput {
  request: Pick<ReplicaReadRequest, "where" | "orderBy" | "limit">;
  /** Per-scope truncation drops a badge on collapsed rows. */
  contentHashed: boolean;
  scopeCount: number;
}

/** `orderBy` is never pushed: SQL would page a mixed-type column the evaluator
 *  must escalate on. Pushing it needs a type-uniformity probe first. */
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
  if (input.request.orderBy) return undefined;
  if (input.contentHashed && input.scopeCount > 1) return undefined;
  const requested = input.request.limit;
  if (requested === undefined) return undefined;
  if (!Number.isSafeInteger(requested)) {
    throw new ReplicaProtocolError("Read limit must be a safe integer");
  }
  return Math.min(Math.max(requested, 1), MAX_PUSHED_LIMIT);
}

/** Every fragment carries the availability escape: hidden or oversized fields
 *  must reach the evaluator. */
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

function quoted(names: readonly string[]): string {
  return names.map((name) => `'${name}'`).join(", ");
}

function bindValue(value: ReplicaValue | undefined): ReplicaBindValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  throw new ReplicaProtocolError("Pushdown requires scalar filter values");
}
