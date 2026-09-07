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

import { pageCursorOf, pageOf, pageStatement } from "@centraid/core/page";
import type { Page, PageQuery, PageRequest } from "@centraid/core/page";

import { bumpClientWorkCounter } from "../work-counters.js";
import type { SeatSqliteDriver } from "./driver.js";

/*
 * The statement shape, its cursor and its assembler now live in
 * `@centraid/core/page` — the gateway's paged door (W4-D2) runs the SAME
 * statement for a seat that holds no file, and `packages/vault` cannot import
 * a client module. What stays here is the half that is a SEAT's: running the
 * statement against this seat's own driver, and counting the work.
 */

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
  query: PageQuery<Row>,
  request: PageRequest
): Page<Row> {
  const statement = pageStatement(query, request);
  const rows = driver.all<Row>(statement.sql, statement.bind);
  countSeatPageWork(rows.length);
  return pageOf(rows, request, (row) =>
    pageCursorOf(row as Record<string, unknown>, query.order)
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
