/**
 * PAGED READS, AS AN APP WRITES THEM (#996 wave 4, rulings R8 and W4-D2).
 *
 * `ctx.vault.page` hands back ONE page, because a handler that could ask for
 * everything is a handler somebody eventually will. What an app usually wants
 * on top of that is one of two things, and both are here so that neither is
 * re-invented per app:
 *
 *   A JOIN OVER A SET ALREADY BOUNDED. A board has fetched its window of tasks
 *   and now needs those tasks' attachments. The set is bounded by the window,
 *   not by the table, so the read is finite and the only honest way to fetch it
 *   is to walk pages until they run out — `readPages`. The walk is CAPPED, and
 *   the cap is not a silent truncation: it is a stated fan-out bound, and a
 *   handler that hits it is asking a question about a set it did not bound.
 *
 *   AN `IN` LIST. `inList` builds the placeholders and the binds together, so
 *   the two cannot get out of step, and refuses an empty set rather than
 *   emitting `IN ()`, which SQLite parses and which matches nothing in a way
 *   that reads like a filter rather than a mistake.
 *
 * WHY THIS IS NOT THE TRUNCATION FLAG WITH EXTRA STEPS. The flag declared that
 * the caller did not care where the answer stopped. A walk states where it
 * stops (`fanOutPages` × `pageSize` rows), states it at the call site, and
 * throws rather than returning a short answer that looks whole.
 */

import { MAX_PAGE_ROWS } from "@centraid/core/page";
import type { PageCursor, PageQuery } from "@centraid/core/page";

/** One `IN (…)` fragment and the binds it takes, built together. */
export interface InListFragment {
  /** `column IN (?, ?, ?)`. */
  sql: string;
  bind: string[];
}

/**
 * An `IN` over a bounded set of ids.
 *
 * Refuses an empty set: `IN ()` matches nothing, which is the right ANSWER for
 * an empty set and the wrong SHAPE for a handler to have written — the caller
 * should not be reading at all. Every call site here guards on the set being
 * non-empty already, and this is what keeps that guard honest.
 */
export function inList(column: string, ids: readonly string[]): InListFragment {
  if (ids.length === 0)
    throw new Error(`inList(${column}): an empty set is not a read`);
  return {
    sql: `${column} IN (${ids.map(() => "?").join(", ")})`,
    bind: [...ids],
  };
}

/** How far a fan-out may walk before it is a question about an unbounded set. */
export interface FanOutBound {
  /** Rows per page. */
  pageSize: number;
  /** Pages, at most. `pageSize * fanOutPages` is the stated ceiling. */
  fanOutPages: number;
}

/** The default fan-out: 500 rows a page, eight pages, so 4,000 joined rows. */
export const JOIN_FAN_OUT: FanOutBound = { pageSize: 500, fanOutPages: 8 };

/**
 * THE CAP A BOUND ACTUALLY REACHES (#1020, R-1020-35).
 *
 * `pageSize * fanOutPages` is what a call site declares, and until this
 * existed it was not what the walk could reach: `probeLimit` clamps every
 * request to `MAX_PAGE_ROWS` (500), so a bound of `{ pageSize: 1000,
 * fanOutPages: 8 }` declared 8,000 rows, walked eight pages of 500, and threw
 * "fan-out passed 8000 rows" having seen 4,000 — a message naming the half it
 * never read. Tally's `LEDGER_FAN_OUT` (8,000) and `ALLOCATION_FAN_OUT`
 * (32,000) were both of that shape.
 *
 * So the declared PRODUCT is the contract and the page size is an
 * implementation detail of the walk: the page is clamped to the ceiling the
 * host will honour, and the page count is raised to keep the product. A bound
 * of N reaches N rows and the refusal names N.
 */
export function reachableBound(bound: FanOutBound): {
  pageSize: number;
  pages: number;
  cap: number;
} {
  const cap = bound.pageSize * bound.fanOutPages;
  if (!Number.isSafeInteger(cap) || cap < 1)
    throw new Error(
      `fan-out bound must state a positive whole number of rows, got ${String(bound.pageSize)} × ${String(bound.fanOutPages)}`
    );
  const pageSize = Math.min(bound.pageSize, MAX_PAGE_ROWS);
  return { pageSize, pages: Math.ceil(cap / pageSize), cap };
}

/**
 * WALK A STATED WINDOW TO ITS END (#1020, R-1020-35).
 *
 * A window bigger than `MAX_PAGE_ROWS` cannot be one request, and asking for
 * one got a caller 500 rows and a `next` cursor saying there were more. Six
 * handlers did exactly that — Tally's ledger at 2,000, Locker's logins, trash
 * and watchtower at 2,000, Photos' duplicate clusters and face queue at 4,000
 * — and every one of them then folded or grouped over what it got. A balance
 * over a silently short ledger is a WRONG NUMBER, which is what the doctrine
 * above Tally's window declarations already said in those words.
 *
 * This walks the host's own continuation until the rows end or the stated
 * window is full, and it does NOT throw at the window: a window is a declared
 * screenful, and stopping at it is the declaration being honoured. That is the
 * difference from `readPages`, whose cap means "the set I am joining over was
 * supposed to be bounded and was not".
 */
export async function readWindow<Row extends object>(
  ctx: PagingCtx,
  query: PageQuery<Row>,
  window: number,
  overlay?: { entity: string; rowIdColumn: string }
): Promise<Row[]> {
  if (!Number.isSafeInteger(window) || window < 1)
    throw new Error(
      `${query.name}: a window must be a positive whole number of rows, got ${String(window)}`
    );
  const rows: Row[] = [];
  let after: PageCursor | undefined;
  while (rows.length < window) {
    // A keyset walk is sequential BY CONSTRUCTION: page n+1 starts at page n's
    // last row, so there is nothing here to run in parallel.
    // oxlint-disable-next-line no-await-in-loop
    const answer = await ctx.vault.page<Row>({
      query,
      limit: Math.min(window - rows.length, MAX_PAGE_ROWS),
      ...(after ? { after } : {}),
      ...(overlay ? { overlay } : {}),
    });
    rows.push(...answer.rows);
    if (!answer.next) break;
    after = answer.next;
  }
  // The last page may overshoot only if the host returned more than it was
  // asked for; trim rather than hand a window wider than the one declared.
  return rows.length > window ? rows.slice(0, window) : rows;
}

interface PagingCtx {
  vault: {
    page: <Row extends object>(request: {
      query: PageQuery<Row>;
      limit: number;
      after?: PageCursor;
      overlay?: { entity: string; rowIdColumn: string };
    }) => Promise<{ rows: Row[]; next?: PageCursor }>;
  };
}

/**
 * THE ROW A SCREEN WAS OPENED ON.
 *
 * Half the reads in these apps are "the one row this id names", and written out
 * as a page each is eleven lines of order clause for a set whose size is one.
 * The window is 1 and the ORDER BY is the primary key, so the cursor is
 * degenerate ON PURPOSE here: there is no second page to reach.
 */
export async function readById<Row extends object>(
  ctx: PagingCtx,
  spec: { name: string; select: string; from: string; idColumn: string },
  id: string
): Promise<Row | undefined> {
  const answer = await ctx.vault.page<Row>({
    query: {
      name: spec.name,
      select: spec.select,
      from: spec.from,
      where: `${spec.idColumn} = ?`,
      bind: [id],
      order: {
        sortColumn: spec.idColumn,
        pkColumn: spec.idColumn,
        descending: false,
      },
    },
    limit: 1,
  });
  return answer.rows[0];
}

/**
 * Walk a handler's pages to the end of a bounded set.
 *
 * The cap THROWS. Returning what it had would be the truncation flag again:
 * a short answer that reads as a whole one, with the app deciding what to do
 * about a fact it was never told.
 */
export async function readPages<Row extends object>(
  ctx: PagingCtx,
  query: PageQuery<Row>,
  bound: FanOutBound = JOIN_FAN_OUT,
  overlay?: { entity: string; rowIdColumn: string }
): Promise<Row[]> {
  const rows: Row[] = [];
  let after: PageCursor | undefined;
  const { pageSize, pages, cap } = reachableBound(bound);
  for (let page = 0; page < pages; page += 1) {
    // A keyset walk is sequential BY CONSTRUCTION: page n+1's cursor is page
    // n's last row, so there is no set of promises to run in parallel here.
    // oxlint-disable-next-line no-await-in-loop
    const answer = await ctx.vault.page<Row>({
      query,
      limit: pageSize,
      ...(after ? { after } : {}),
      ...(overlay ? { overlay } : {}),
    });
    rows.push(...answer.rows);
    if (!answer.next) return rows;
    after = answer.next;
  }
  throw new Error(
    `${query.name}: fan-out passed ${String(cap)} rows; the set this joins over is not bounded`
  );
}
