import { fieldNotOnThisDevice } from "@centraid/blueprints/apps/_shared/shared-copy";

/**
 * THE REPLICA READ GRAMMAR, COMPILED TO SQL (#883): a clause compiles to a
 * VERDICT — -1 dropped, 0 kept, >0 escalates — because a value this seat
 * cannot compare as the canonical vault would must rerun online. SQLite's own
 * BINARY collation over UTF-8 bytes IS that comparison.
 */
import { OnlineOnlyError, ReplicaProtocolError } from "./errors.js";
import {
  assertColumn,
  censusClass,
  clauseBody,
  clauseGuards,
  jsonValue,
  OVERSIZED,
  PAYLOAD,
  REPLICA_CENSUS_CLASSES,
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
  /** The guards' own statement; absent when the read is unordered. */
  orderCensus?: { sql: string; binds: ReplicaBindValue[] };
  /**
   * What the store needs to build the ordering index (#922 C3): the column,
   * the direction the plan asks for, and the tie-break key after it. An index
   * that disagrees on any of the three leaves a temp b-tree behind.
   */
  orderColumn?: string;
  orderDirection?: "asc" | "desc";
  orderTieBreak?: string;
  tieCensus?: { sql: string; binds: ReplicaBindValue[] };
  /**
   * The window this answer is bounded by. TRUNCATION IS NEVER SILENT (#922
   * 0a): `binds` end with `limit + 1`, so one probe row past the window is the
   * exact, statement-level evidence that rows were left behind — a full page is
   * not, because a set of exactly `limit` rows fills one without hiding
   * anything. `trimReplicaPage` drops the probe and reports the verdict.
   */
  limit: number;
  /** True when `limit` is `REPLICA_DEFAULT_LOCAL_ROWS`, not a declared window. */
  limitDefaulted: boolean;
}

/** One page's window verdict: the answer, and whether it hid anything. */
export interface ReplicaPage<Row> {
  rows: Row[];
  truncated: boolean;
}

/**
 * Drop the probe row and say whether it was there. Every consumer of a plan
 * MUST route its rows through this — the plan over-fetches by one on purpose,
 * so a caller that returns the raw rows returns one row too many.
 */
export function trimReplicaPage<Row>(
  rows: readonly Row[],
  plan: ReplicaReadPlan
): ReplicaPage<Row> {
  const truncated = rows.length > plan.limit;
  return { rows: truncated ? rows.slice(0, plan.limit) : [...rows], truncated };
}

/**
 * A read that declares no window and does not accept truncation, refused at the
 * seat's boundary rather than answered with a silently capped page (#922 0a).
 * The message names the entity and the two ways out, because the caller that
 * has to fix it is reading this string in a log or an error state.
 */
export class UnboundedReplicaReadError extends Error {
  readonly code = "UNBOUNDED_READ";
  constructor(readonly entity: string) {
    super(
      `Unbounded read of ${entity}: declare \`limit\` for the window this screen renders, ` +
        `or \`acceptTruncation: true\` to take the default ${REPLICA_DEFAULT_LOCAL_ROWS}-row window and render the truncation.`
    );
    this.name = "UnboundedReplicaReadError";
  }
}

/**
 * The one boundary rule, shared by both seats so neither can drift: a read is
 * admissible when it declares its window or accepts the default one.
 */
export function assertBoundedReplicaRead(request: {
  entity: string;
  limit?: number;
  acceptTruncation?: boolean;
}): void {
  if (request.limit === undefined && request.acceptTruncation !== true) {
    throw new UnboundedReplicaReadError(request.entity);
  }
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

/** The order guards' verdict row; one per ordered read, from its own statement. */
export function assertReplicaOrder(
  census: Record<string, number> | undefined,
  plan: ReplicaReadPlan
): void {
  if (!census) return;
  for (const guard of plan.orderGuards) {
    if (census[guard.column] === 1) raise(guard.escalation);
  }
}

/** 1 when some ordered value is carried by more than one kept row. */
export type ReplicaTieCensusRow = { tied: number };

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
}

/** A tie under an opaque primary key makes `ORDER BY ... LIMIT` unstable.
 *  NULLs form ONE group, which `GROUP BY` gives for free. */
export function assertReplicaTieCensus(row: ReplicaTieCensusRow): void {
  if (row.tied) {
    throw new OnlineOnlyError(
      "ORDER BY ties require an exposed scalar primary key or canonical SQLite ordering"
    );
  }
}

/**
 * The guards ride their OWN statement, not the paging one (#922 C3), and that
 * statement is now INDEX PROBES rather than a scan of the entity.
 *
 * As `max(...) OVER ()` window aggregates in the page's select list they made
 * every ordered read materialize and scan the WHOLE entity before it could
 * return the first row. Split out, they were still one aggregate over every
 * kept row — 20 ms on a 50 000-row library, paid again after every write,
 * because the census cache is dropped on each one. Each guard is really the
 * question "does any kept row hold a value of THIS class", so each is now one
 * seek into the census index (`censusClass`), and the escalations, their
 * priority and the tests over them are unchanged.
 */
interface CensusProbe {
  alias: string;
  column: string;
  /** `[n]` is "class n exists"; `[a, b]` is "both exist" — the straddle. */
  classes: readonly number[];
}

function orderGuards(
  column: string,
  role: "order" | "key",
  schema: ReplicaEntitySchema,
  census: CensusProbe[]
): ReplicaOrderGuard[] {
  const guards: ReplicaOrderGuard[] = [];
  const add = (
    name: string,
    classes: readonly number[],
    escalation: ReplicaEscalation
  ): void => {
    const alias = `${role}_${name}`;
    census.push({ alias, column, classes });
    guards.push({ column: alias, escalation });
  };
  if (role === "order") {
    add("oversized", [REPLICA_CENSUS_CLASSES.oversized], {
      kind: "online",
      message: `${fieldNotOnThisDevice(column)} is required for ordering`,
    });
    if (schema.hasUnavailableFields) {
      add("undisclosed", [REPLICA_CENSUS_CLASSES.undisclosed], {
        kind: "online",
        message: "undisclosed unavailable field is required for ordering",
      });
    }
  }
  add("unordered", [REPLICA_CENSUS_CLASSES.unordered], {
    kind: "protocol",
    message:
      role === "order"
        ? "orderBy requires scalar values"
        : "primary-key orderBy tie-break requires scalar values",
  });
  // D3: either class ALONE is fine, hence BOTH classes have to be present.
  add(
    "straddle",
    [REPLICA_CENSUS_CLASSES.numeric, REPLICA_CENSUS_CLASSES.text],
    {
      kind: "online",
      message: "mixed-type comparison requires canonical SQLite affinity",
    }
  );
  return guards;
}

/** One seek: the lowest class at or above `cls`, which IS `cls` iff it exists. */
function censusProbeSql(scan: string, column: string, cls: number): string {
  const expression = censusClass(column);
  return `(SELECT ${expression} FROM (${scan})
             WHERE verdict >= 0 AND ${expression} >= ${cls}
             ORDER BY ${expression} ASC LIMIT 1)`;
}

function censusSql(
  probes: readonly CensusProbe[],
  scan: string,
  scanBinds: readonly ReplicaBindValue[]
): { sql: string; binds: ReplicaBindValue[] } {
  const binds: ReplicaBindValue[] = [];
  const columns = probes.map((probe) => {
    const tests = probe.classes.map((cls) => {
      binds.push(...scanBinds);
      return `${censusProbeSql(scan, probe.column, cls)} = ${cls}`;
    });
    return `CASE WHEN ${tests.join(" AND ")} THEN 1 ELSE 0 END AS ${probe.alias}`;
  });
  return { sql: `SELECT ${columns.join(", ")}`, binds };
}

/** Local SQLite rows, not a network response; a ten-year library exceeds 10k. */
export const REPLICA_MAX_LOCAL_ROWS = 100_000;
export const REPLICA_DEFAULT_LOCAL_ROWS = 1000;

function plannedLimit(request: ReplicaReadRequest): {
  limit: number;
  defaulted: boolean;
} {
  const requested = request.limit ?? REPLICA_DEFAULT_LOCAL_ROWS;
  if (!Number.isSafeInteger(requested)) {
    throw new ReplicaProtocolError("Read limit must be a safe integer");
  }
  return {
    limit: Math.min(Math.max(requested, 1), REPLICA_MAX_LOCAL_ROWS),
    defaulted: request.limit === undefined,
  };
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
  const { limit, defaulted } = plannedLimit(request);

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
  const census: CensusProbe[] = [];
  const order: string[] = [];
  // Only when a clause can escalate: an unfiltered read keeps index order.
  if (builder.escalations.length > 0) order.push("(verdict = 0) ASC");
  if (request.orderBy) {
    const column = request.orderBy.column;
    guards.push(...orderGuards(column, "order", schema, census));
    order.push(`${jsonValue(column)} ${dir === "desc" ? "DESC" : "ASC"}`);
    const visiblePrimaryKey =
      schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY
        ? undefined
        : schema.primaryKey;
    if (visiblePrimaryKey !== undefined && visiblePrimaryKey !== column) {
      assertColumn(schema, visiblePrimaryKey);
      guards.push(...orderGuards(visiblePrimaryKey, "key", schema, census));
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
    // One row past the window: the probe `trimReplicaPage` drops (#922 0a).
    binds: [...scanBinds, limit + 1],
    escalations: builder.escalations,
    orderGuards: guards,
    ...(census.length > 0
      ? { orderCensus: censusSql(census, scan, scanBinds) }
      : {}),
    ...(request.orderBy
      ? {
          orderColumn: request.orderBy.column,
          orderDirection: dir === "desc" ? ("desc" as const) : ("asc" as const),
          ...(schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY ||
          schema.primaryKey === request.orderBy.column
            ? {}
            : { orderTieBreak: schema.primaryKey }),
        }
      : {}),
    limit,
    limitDefaulted: defaulted,
  };
  if (request.orderBy && schema.primaryKey === REPLICA_SYNTHETIC_PRIMARY_KEY) {
    const ordered = jsonValue(request.orderBy.column);
    // THE TIE CENSUS ASKS ONE QUESTION (#922 E3): does any ordered value
    // repeat? `count(*) / count(DISTINCT …)` answered it by building a temp
    // b-tree over every kept value — 22 ms of a 22 ms ordered read at 50 000
    // rows, the largest O(entity) term left on this path once the ORDER census
    // became a seek. `GROUP BY` over the SAME expression the ordering index is
    // built on walks that index in order instead, needs no b-tree, and stops
    // at the FIRST repeated value, so the case that escalates costs almost
    // nothing. `EXISTS` keeps the answer one row, and NULLs still form one
    // group, so the rule is unchanged.
    plan.tieCensus = {
      sql: `SELECT EXISTS (SELECT 1
                             FROM (${scan})
                            WHERE verdict = 0
                            GROUP BY ${ordered}
                           HAVING count(*) > 1) AS tied`,
      binds: scanBinds,
    };
  }
  return plan;
}
