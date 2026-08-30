/**
 * THE REPLICA READ GRAMMAR, COMPILED TO SQL (#883): a clause compiles to a
 * VERDICT — -1 dropped, 0 kept, >0 escalates — because a value this seat
 * cannot compare as the canonical vault would must rerun online. SQLite's own
 * BINARY collation over UTF-8 bytes IS that comparison.
 */
import { OnlineOnlyError, ReplicaProtocolError } from "./errors.js";
import {
  assertColumn,
  clauseBody,
  clauseGuards,
  jsonType,
  jsonValue,
  NUMERIC_TYPES,
  OVERSIZED,
  oversized,
  PAYLOAD,
  quoted,
  TEXT_TYPES,
  undisclosed,
  UNORDERED_TYPES,
} from "./read-plan-clauses.js";
import type { PlanBuilder, ReplicaEscalation } from "./read-plan-clauses.js";
// Type-only: erases the `store-core.ts` cycle.
import type { ReplicaBindValue } from "./store-core.js";
import { REPLICA_SYNTHETIC_PRIMARY_KEY } from "./types.js";
import type { ReplicaEntitySchema, ReplicaReadRequest } from "./types.js";

export const REPLICA_PUSHDOWN_DIVERGENCES = [
  "D1 request-shape errors raise while compiling, not on the first row",
  "D2 a heterogeneous `in` list escalates instead of depending on candidate order",
  "D3 order-by and tie-break refusals are set-wide, not comparison-wide",
  "D4 timestamps outside years 1000-9999 escalate",
  "D5 a column name outside SAFE_COLUMN escalates",
  "D6 an unordered read's `row_id` order is declared rather than inherited",
] as const;

export type {
  ReplicaEscalation,
  ReplicaEscalationKind,
} from "./read-plan-clauses.js";

export interface ReplicaOverlayBinding {
  rowIds: string;
  /** `{i,p,o,v}`: row id, payload, oversized fields, version. */
  rows: string;
}

export interface ReplicaOrderGuard {
  column: string;
  escalation: ReplicaEscalation;
}

/** ONE DATABASE'S COPY OF THE ENTITY (#883): a composed scan UNION ALLs one
 *  arm per source, ordered and limited ONCE, so guards span EVERY one. */
export interface ReplicaPlanSource {
  table?: string;
  /** THIS database's shape id; vaults differ. */
  shapeId: string;
  overlay?: ReplicaOverlayBinding;
}

const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/u;

export const REPLICA_PLAN_SOURCE_COLUMN = "source_index";

export interface ReplicaReadPlan {
  sql: string;
  binds: ReplicaBindValue[];
  /** Verdict code `n` names `escalations[n - 1]`. */
  escalations: ReplicaEscalation[];
  orderGuards: ReplicaOrderGuard[];
  tieCensus?: { sql: string; binds: ReplicaBindValue[] };
}

export interface ReplicaPlannedRow {
  row_id: string;
  payload_json: string;
  oversized_json: string;
  server_version: number;
  verdict: number;
  source_index?: number;
  [guard: string]: unknown;
}

export interface ReplicaTieCensusRow {
  kept: number;
  distinct_values: number;
  non_null: number;
}

function raise(escalation: ReplicaEscalation): never {
  throw escalation.kind === "online"
    ? new OnlineOnlyError(escalation.message)
    : new ReplicaProtocolError(escalation.message);
}

export function assertReplicaPage(
  rows: readonly ReplicaPlannedRow[],
  plan: ReplicaReadPlan
): void {
  const first = rows[0];
  if (first === undefined) return;
  // Escalating rows sort first: row zero is necessary and sufficient.
  if (first.verdict > 0) {
    const escalation = plan.escalations[first.verdict - 1];
    if (!escalation) {
      throw new ReplicaProtocolError(
        `Replica read plan reported unknown verdict ${first.verdict}`
      );
    }
    raise(escalation);
  }
  for (const guard of plan.orderGuards) {
    if (first[guard.column] === 1) raise(guard.escalation);
  }
}

/** A tie under an opaque primary key makes `ORDER BY ... LIMIT` unstable.
 *  NULLs form ONE group. */
export function assertReplicaTieCensus(row: ReplicaTieCensusRow): void {
  const groups = row.distinct_values + (row.non_null < row.kept ? 1 : 0);
  if (row.kept > groups) {
    throw new OnlineOnlyError(
      "ORDER BY ties require an exposed scalar primary key or canonical SQLite ordering"
    );
  }
}

function orderGuards(
  column: string,
  role: "order" | "key",
  schema: ReplicaEntitySchema,
  select: string[]
): ReplicaOrderGuard[] {
  const guards: ReplicaOrderGuard[] = [];
  const add = (
    name: string,
    test: string,
    escalation: ReplicaEscalation
  ): void => {
    const alias = `${role}_${name}`;
    select.push(`max(CASE WHEN ${test} THEN 1 ELSE 0 END) OVER () AS ${alias}`);
    guards.push({ column: alias, escalation });
  };
  if (role === "order") {
    add("oversized", oversized(column), {
      kind: "online",
      message: `oversized field ${column} is required for ordering`,
    });
    if (schema.hasUnavailableFields) {
      add("undisclosed", undisclosed(column), {
        kind: "online",
        message: "undisclosed unavailable field is required for ordering",
      });
    }
  }
  add("unordered", `${jsonType(column)} IN (${quoted(UNORDERED_TYPES)})`, {
    kind: "protocol",
    message:
      role === "order"
        ? "orderBy requires scalar values"
        : "primary-key orderBy tie-break requires scalar values",
  });
  // D3: either class ALONE is fine, hence the PRODUCT of two maxima.
  const alias = `${role}_straddle`;
  select.push(
    `(max(CASE WHEN ${jsonType(column)} IN (${quoted(TEXT_TYPES)})` +
      " THEN 1 ELSE 0 END) OVER ()" +
      ` * max(CASE WHEN ${jsonType(column)} IN (${quoted(NUMERIC_TYPES)})` +
      ` THEN 1 ELSE 0 END) OVER ()) AS ${alias}`
  );
  guards.push({
    column: alias,
    escalation: {
      kind: "online",
      message: "mixed-type comparison requires canonical SQLite affinity",
    },
  });
  return guards;
}

/** Local SQLite rows, not a network response; a ten-year library exceeds 10k. */
export const REPLICA_MAX_LOCAL_ROWS = 100_000;
export const REPLICA_DEFAULT_LOCAL_ROWS = 1000;

function plannedLimit(request: ReplicaReadRequest): number {
  const requested = request.limit ?? REPLICA_DEFAULT_LOCAL_ROWS;
  if (!Number.isSafeInteger(requested)) {
    throw new ReplicaProtocolError("Read limit must be a safe integer");
  }
  return Math.min(Math.max(requested, 1), REPLICA_MAX_LOCAL_ROWS);
}

const SOURCE_COLUMNS = `row_id, ${PAYLOAD}, ${OVERSIZED}, server_version`;

function sourceSql(
  overlay: ReplicaOverlayBinding | undefined,
  table = "replica_row"
): {
  sql: string;
  binds: ReplicaBindValue[];
} {
  if (!SAFE_TABLE.test(table)) {
    throw new ReplicaProtocolError(
      `Replica plan source ${table} is not a table identifier`
    );
  }
  const base = `SELECT ${SOURCE_COLUMNS} FROM ${table}
                 WHERE shape_id = ? AND entity = ?`;
  if (!overlay) return { sql: base, binds: [] };
  // O(mutations), never O(rows), bound as ONE JSON value, so filter, order
  // and limit still run once.
  return {
    sql: `${base} AND row_id NOT IN (SELECT value FROM json_each(?))
       UNION ALL
       SELECT json_extract(value, '$.i'), json_extract(value, '$.p'),
              json_extract(value, '$.o'), json_extract(value, '$.v')
         FROM json_each(?)`,
    binds: [overlay.rowIds, overlay.rows],
  };
}

/** `now` is threaded in to keep `within-days` pure. */
export function planReplicaRead(
  schema: ReplicaEntitySchema,
  request: ReplicaReadRequest,
  now: Date,
  overlay?: ReplicaOverlayBinding
): ReplicaReadPlan {
  return planComposedReplicaRead(schema, request, now, [
    { shapeId: request.shapeId, ...(overlay ? { overlay } : {}) },
  ]);
}

/** Clauses compile ONCE and repeat per arm: one verdict code, every source. */
export function planComposedReplicaRead(
  schema: ReplicaEntitySchema,
  request: ReplicaReadRequest,
  now: Date,
  sources: readonly ReplicaPlanSource[]
): ReplicaReadPlan {
  if (sources.length === 0) {
    throw new ReplicaProtocolError("A replica read plan needs a source");
  }
  const where = request.where ?? [];
  for (const clause of where) assertColumn(schema, clause.column);
  if (request.orderBy) assertColumn(schema, request.orderBy.column);
  const dir = request.orderBy?.dir ?? "asc";
  if (dir !== "asc" && dir !== "desc") {
    throw new ReplicaProtocolError(`Unknown order direction ${String(dir)}`);
  }
  const limit = plannedLimit(request);

  const builder: PlanBuilder = { binds: [], escalations: [] };
  const branches: string[] = [];
  for (const clause of where) {
    const guards = clauseGuards(clause, schema, builder);
    const body = clauseBody(clause, builder, now.getTime());
    branches.push(
      ...guards,
      ...body.guards,
      // `IFNULL`: a comparison against SQL NULL is NULL, and reads as false.
      `WHEN NOT IFNULL(${body.match}, 0) THEN -1`
    );
  }
  const verdict =
    branches.length === 0 ? "0" : `CASE ${branches.join(" ")} ELSE 0 END`;

  const composed = sources.length > 1;
  const select = [SOURCE_COLUMNS, "verdict"];
  if (composed) select.push(REPLICA_PLAN_SOURCE_COLUMN);
  const guards: ReplicaOrderGuard[] = [];
  const order: string[] = [];
  // Only when a clause can escalate: an unfiltered read keeps index order.
  if (builder.escalations.length > 0) order.push("(verdict = 0) ASC");
  if (request.orderBy) {
    const column = request.orderBy.column;
    guards.push(...orderGuards(column, "order", schema, select));
    order.push(`${jsonValue(column)} ${dir === "desc" ? "DESC" : "ASC"}`);
    const visiblePrimaryKey =
      schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY
        ? undefined
        : schema.primaryKey;
    if (visiblePrimaryKey !== undefined && visiblePrimaryKey !== column) {
      assertColumn(schema, visiblePrimaryKey);
      guards.push(...orderGuards(visiblePrimaryKey, "key", schema, select));
      // Mirrors the canonical read's fixed ASC tie-break; keeps paging stable.
      order.push(`${jsonValue(visiblePrimaryKey)} ASC`);
    }
  }
  // D6: unordered the source is the OUTER key, ordered the INNERMOST.
  if (composed && !request.orderBy)
    order.push(`${REPLICA_PLAN_SOURCE_COLUMN} ASC`);
  order.push("row_id ASC");
  if (composed && request.orderBy)
    order.push(`${REPLICA_PLAN_SOURCE_COLUMN} ASC`);

  // Bind order follows STATEMENT order: the CASE precedes its source, per arm.
  const scanBinds: ReplicaBindValue[] = [];
  const scan = sources
    .map((entry, index) => {
      const source = sourceSql(entry.overlay, entry.table);
      scanBinds.push(
        ...builder.binds,
        entry.shapeId,
        request.entity,
        ...source.binds
      );
      const tag = composed ? `, ${index} AS ${REPLICA_PLAN_SOURCE_COLUMN}` : "";
      return `SELECT ${SOURCE_COLUMNS}, ${verdict} AS verdict${tag}
                  FROM (${source.sql})`;
    })
    .join(" UNION ALL ");
  const plan: ReplicaReadPlan = {
    sql: `SELECT ${select.join(", ")}
            FROM (${scan})
           WHERE verdict >= 0
           ORDER BY ${order.join(", ")}
           LIMIT ?`,
    binds: [...scanBinds, limit],
    escalations: builder.escalations,
    orderGuards: guards,
  };
  if (request.orderBy && schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY) {
    const ordered = jsonValue(request.orderBy.column);
    plan.tieCensus = {
      sql: `SELECT count(*) AS kept,
                   count(DISTINCT ${ordered}) AS distinct_values,
                   count(${ordered}) AS non_null
              FROM (${scan})
             WHERE verdict = 0`,
      binds: scanBinds,
    };
  }
  return plan;
}
