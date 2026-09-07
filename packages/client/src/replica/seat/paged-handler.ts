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

/** One handler's statement, minus the parts the host owns. */
export interface SeatPageQuery<Row extends object> {
  /** Names the handler in the work-counter row and the plan snapshot. */
  name: string;
  /**
   * The statement, given the keyset predicate to splice into its WHERE.
   *
   * A function rather than a string with a token because the predicate is
   * EMPTY on the first page: a handler that interpolates it into a live `WHERE`
   * gets a valid statement either way, and one that receives `1=1` instead
   * pays for a predicate that means nothing.
   */
  sql: (keyset: string) => string;
  /** Binds the statement's own placeholders take, before the keyset's. */
  bind?: readonly SeatBindValue[];
  order: SeatPageOrder;
  /** The handler's ORDER BY restated as a value, so the two cannot drift. */
  keyOf: (row: Row) => PageCursor;
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
  const { sortColumn, pkColumn, descending } = query.order;
  const direction = descending ? "DESC" : "ASC";
  const comparison = descending ? "<" : ">";
  const keyset = request.after
    ? `AND (${sortColumn}, ${pkColumn}) ${comparison} (?, ?)`
    : "";
  const bind: SeatBindValue[] = [...(query.bind ?? [])];
  if (request.after) bind.push(request.after.sortKey, request.after.pk);
  bind.push(probeLimit(request));
  const rows = driver.all<Row>(
    `${query.sql(keyset)}
      ORDER BY ${sortColumn} ${direction}, ${pkColumn} ${direction}
      LIMIT ?`,
    bind
  );
  bumpClientWorkCounter("statements");
  bumpClientWorkCounter("rowsScanned", rows.length);
  return pageOf(rows, request, query.keyOf);
}
