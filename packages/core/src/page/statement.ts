/*
 * THE STATEMENT, AS DATA (#996 wave 4, rulings R8 and W4-D2).
 *
 * A handler does not hold a closure and does not hold a string of SQL it
 * assembled itself. It holds this shape, and the same shape is executed by
 * three different things:
 *
 *   the seat, in process, against its own copy of the vault file;
 *   the shell, across the seat worker's `postMessage` seam;
 *   the gateway, for a seat that chose to hold no file (R9), through the
 *   paged door, which runs it under the caller's principal with
 *   `evaluateAccess`, the R17 field mask and the manifest row filters applied.
 *
 * A closure survives none of those seams, and a pre-assembled string survives
 * the first two but cannot be checked at the third: the door has to know which
 * TABLES and which COLUMNS a statement touches before it will run it, and a
 * string is exactly the shape that hides both. So the parts a handler owns are
 * named parts, and everything the host owns — the keyset, the probe row, the
 * LIMIT, the ORDER BY — is spliced in HERE, in one function, for all three.
 *
 * W4-D2, recorded: an app handler's statement never runs on the gateway as raw
 * SQL. The gateway serves the same statement-as-data through the paged door,
 * and the door's checks are never bypassed.
 *
 * Zero runtime dependencies and no `node:` imports — `packages/core` is
 * consumed from source by React Native.
 */

import { probeLimit } from "./window.js";
import type { PageCursor, PageRequest } from "./window.js";

/** What a statement's placeholders may be bound to. */
export type PageBindValue = string | number | null;

/** The ORDER BY, as the columns the keyset compares. */
export interface PageOrder {
  sortColumn: string;
  /** The tiebreak. The sort key is not unique; the primary key is. */
  pkColumn: string;
  descending: boolean;
}

/**
 * One handler's statement, minus the parts the host owns.
 *
 * There is NO `keyOf`. The cursor is read off the row by the same two columns
 * the ORDER BY names — one declaration, so the walk and the cursor cannot
 * disagree — which also means `select` MUST carry both of them.
 */
export interface PageQuery<Row extends object = Record<string, unknown>> {
  /** Names the handler in the work-counter row and the plan snapshot. */
  name: string;
  /** The projection. Must include the order's two columns. */
  select: string;
  /** The table, with any JOINs a page of it needs. */
  from: string;
  /** The handler's own predicate. Absent means every row of `from`. */
  where?: string;
  /** Binds the statement's own placeholders take, before the keyset's. */
  bind?: readonly PageBindValue[];
  order: PageOrder;
  /** Marker only; a handler's row type never reaches the SQL. */
  readonly __row?: Row;
}

/** The cursor of one row, by the columns its handler orders on. */
export function pageCursorOf(
  row: Record<string, unknown>,
  order: PageOrder
): PageCursor {
  const sortKey = row[order.sortColumn];
  const pk = row[order.pkColumn];
  if (typeof pk !== "string")
    throw new Error(
      `page cursor: ${order.pkColumn} must be a string, got ${typeof pk}`
    );
  return { sortKey: sortKey === null ? "" : String(sortKey), pk };
}

/** A handler's statement, assembled: the text and the binds, in order. */
export interface PageStatement {
  sql: string;
  bind: PageBindValue[];
}

/**
 * Assemble one handler's statement for one request.
 *
 * SEPARATE FROM RUNNING IT because there are three ends that must run the SAME
 * statement, and three assemblers would be three keyset dialects. The one that
 * drifted would drift silently — the rows still come back, just the wrong ones
 * at a page boundary, which is where nobody looks.
 *
 * THE KEYSET IS A ROW VALUE. `(sort, pk) < (?, ?)` is what SQLite turns into
 * an index seek; the equivalent `sort < ? OR (sort = ? AND pk < ?)` is what an
 * optimiser has to be talked into, and the difference is a scan from the top of
 * the index on every page. Row values are SQLite 3.15, far under the seat
 * floor.
 *
 * `extraWhere` is the paged door's one splice point: the manifest row filters
 * for every table the statement names, compiled by the gateway and ANDed in
 * with the handler's own predicate. It is never reachable from a handler.
 */
/**
 * The page's ordering, with the tiebreaker stated ONCE.
 *
 * A handler that sorts on its own primary key names the same column twice, and
 * `ORDER BY id, id` is not free: SQLite satisfies the first term from an index
 * and then builds a temp B-tree for "the last term of ORDER BY", which is a
 * sort of one-row groups that answers nothing (#996, W5 — four of the plans in
 * `app-query-plans.snapshot.md` printed exactly that). `ORDER BY id` is the
 * same order and no sort.
 */
function orderBy(
  sortColumn: string,
  pkColumn: string,
  direction: string
): string {
  return sortColumn === pkColumn
    ? `${pkColumn} ${direction}`
    : `${sortColumn} ${direction}, ${pkColumn} ${direction}`;
}

export function pageStatement<Row extends object>(
  query: PageQuery<Row>,
  request: PageRequest,
  extraWhere?: { sql: string; bind: readonly PageBindValue[] }
): PageStatement {
  const { sortColumn, pkColumn, descending } = query.order;
  const direction = descending ? "DESC" : "ASC";
  const comparison = descending ? "<" : ">";
  // The first page carries NO predicate rather than a tautological one, and
  // the handler's own `where` decides whether the keyset needs an `AND`.
  const keyset = request.after
    ? `(${sortColumn}, ${pkColumn}) ${comparison} (?, ?)`
    : "";
  const predicates = [query.where, extraWhere?.sql, keyset].filter(Boolean);
  // Bind order follows the text: the handler's own placeholders, then the
  // door's row filters, then the keyset, then the probe limit.
  const bind: PageBindValue[] = [...(query.bind ?? [])];
  if (extraWhere) bind.push(...extraWhere.bind);
  if (request.after) bind.push(request.after.sortKey, request.after.pk);
  bind.push(probeLimit(request));
  return {
    sql: `SELECT ${query.select}
      FROM ${query.from}
      ${predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : ""}
      ORDER BY ${orderBy(sortColumn, pkColumn, direction)}
      LIMIT ?`,
    bind,
  };
}
