/*
 * THE PAGED HANDLER HOST (#996 wave 4, ruling R8).
 *
 * One place where a seat's read statements are assembled and run, so that the
 * three things every handler has to get right are got right ONCE:
 *
 *   THE KEYSET IS A ROW VALUE. `(sort, pk) < (?, ?)` is what SQLite turns into
 *   an index seek; the equivalent `sort < ? OR (sort = ? AND pk < ?)` is what
 *   an optimiser has to be talked into, and the difference is a scan from the
 *   top of the index on every page. Row values are SQLite 3.15, far under
 *   `SEAT_SQLITE_FLOOR`.
 *
 *   THE PROBE IS THE HOST'S. A handler asks for a window; the host asks the
 *   store for one row more and drops it. That extra row is the whole of "is
 *   there another page", and it is the reason nothing on this path needs the
 *   `truncated` flag it replaces — a caller gets a cursor to continue from, not
 *   a notice that it was cut off.
 *
 *   THE WORK IS COUNTED WHETHER OR NOT THE HANDLER REMEMBERS. R8's gate is
 *   measured work per handler at year-3 scale, and a gate a handler has to
 *   opt into is a gate the one handler that regresses will have skipped. The
 *   host counts, because the host is what runs the statement.
 *
 * WHY THE HANDLER STILL WRITES ITS OWN SQL. The alternative — a query compiler
 * over a declarative shape — is exactly what wave 5 deletes, and for the reason
 * this module exists: nobody could see the statement, so nobody could see the
 * scan. A handler here is plain SQL with one hole in it, and `EXPLAIN QUERY
 * PLAN` over it is a review diff.
 */

import { pageOf, probeLimit } from "@centraid/core/page";
import type { Page, PageCursor, PageRequest } from "@centraid/core/page";

import { bumpClientWorkCounter } from "../work-counters.js";
import type { SeatBindValue, SeatSqliteDriver } from "./driver.js";

/** The ORDER BY, as the columns the keyset compares. */
export interface SeatPageOrder {
  sortColumn: string;
  /** The tiebreak. The sort key is not unique; the primary key is. */
  pkColumn: string;
  descending: boolean;
}

/**
 * One handler's statement, minus the parts the host owns — AS DATA, never as a
 * function.
 *
 * THREE REASONS IT IS DATA. It crosses boundaries: the same handler runs inline
 * in the shell, across the seat worker's `postMessage` seam, and on the gateway
 * through a bridge that serialises every call, and a closure survives none of
 * those. It is inspectable: R8's review diff is `EXPLAIN QUERY PLAN` over the
 * statement, which needs a statement something other than the handler can hold.
 * And it is checkable: `where` is the only place a handler contributes a
 * predicate, so the keyset is spliced by the host in exactly one way.
 *
 * There is NO `keyOf`. The cursor is read from the row by the same two columns
 * the ORDER BY names — one declaration, so the walk and the cursor cannot
 * disagree — which also means `select` MUST carry both of them.
 */
export interface SeatPageQuery<Row extends object = Record<string, unknown>> {
  /** Names the handler in the work-counter row and the plan snapshot. */
  name: string;
  /** The projection. Must include the order's two columns. */
  select: string;
  /** The table, with any JOINs a page of it needs. */
  from: string;
  /** The handler's own predicate. Absent means every row of `from`. */
  where?: string;
  /** Binds the statement's own placeholders take, before the keyset's. */
  bind?: readonly SeatBindValue[];
  order: SeatPageOrder;
  /** Marker only; a handler's row type never reaches the SQL. */
  readonly __row?: Row;
}

/** The cursor of one row, by the columns its handler orders on. */
export function seatPageCursor(
  row: Record<string, unknown>,
  order: SeatPageOrder
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
export interface SeatPageStatement {
  sql: string;
  bind: SeatBindValue[];
}

/**
 * Assemble one handler's statement for one request.
 *
 * SEPARATE FROM RUNNING IT because there are two ends that must run the SAME
 * statement: the seat's own in-process read (`seatPage`, below) and the
 * shell's read across the worker boundary (`seat-page-reader.ts`). Two
 * assemblers would be two keyset dialects, and the one that drifted would drift
 * silently — the rows still come back, just the wrong ones at a page boundary.
 */
export function seatPageStatement<Row extends object>(
  query: SeatPageQuery<Row>,
  request: PageRequest
): SeatPageStatement {
  const { sortColumn, pkColumn, descending } = query.order;
  const direction = descending ? "DESC" : "ASC";
  const comparison = descending ? "<" : ">";
  // The first page carries NO predicate rather than a tautological one, and
  // the handler's own `where` decides whether the keyset needs an `AND`.
  const keyset = request.after
    ? `(${sortColumn}, ${pkColumn}) ${comparison} (?, ?)`
    : "";
  const predicates = [query.where, keyset].filter(Boolean);
  const bind: SeatBindValue[] = [...(query.bind ?? [])];
  if (request.after) bind.push(request.after.sortKey, request.after.pk);
  bind.push(probeLimit(request));
  return {
    sql: `SELECT ${query.select}
      FROM ${query.from}
      ${predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : ""}
      ORDER BY ${sortColumn} ${direction}, ${pkColumn} ${direction}
      LIMIT ?`,
    bind,
  };
}

/**
 * Run one handler's statement and return one page.
 *
 * The window is clamped to `MAX_PAGE_ROWS` inside `probeLimit`/`pageOf` rather
 * than refused: a member who scrolled fast is not doing anything wrong, and a
 * dark screen is a worse answer than a shorter page followed by another one.
 * The clamp shows up where it can be acted on — in `rowsScanned` against the
 * window the handler asked for — not in the member's way.
 */
export function seatPage<Row extends object>(
  driver: SeatSqliteDriver,
  query: SeatPageQuery<Row>,
  request: PageRequest
): Page<Row> {
  const statement = seatPageStatement(query, request);
  const rows = driver.all<Row>(statement.sql, statement.bind);
  countSeatPageWork(rows.length);
  return pageOf(rows, request, (row) =>
    seatPageCursor(row as Record<string, unknown>, query.order)
  );
}

/**
 * The work one paged read spent, counted for EVERY handler on either end of
 * the worker boundary.
 *
 * R8's gate is measured work per handler at year-3 scale, and a gate a handler
 * opts into is a gate the one handler that regresses will have skipped. The
 * probe row is counted: the seat really did visit it, even though nobody saw
 * it.
 */
export function countSeatPageWork(rowsVisited: number): void {
  bumpClientWorkCounter("statements");
  bumpClientWorkCounter("rowsScanned", rowsVisited);
}
