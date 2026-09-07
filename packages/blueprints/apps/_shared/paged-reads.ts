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
  for (let page = 0; page < bound.fanOutPages; page += 1) {
    // A keyset walk is sequential BY CONSTRUCTION: page n+1's cursor is page
    // n's last row, so there is no set of promises to run in parallel here.
    // oxlint-disable-next-line no-await-in-loop
    const answer = await ctx.vault.page<Row>({
      query,
      limit: bound.pageSize,
      ...(after ? { after } : {}),
      ...(overlay ? { overlay } : {}),
    });
    rows.push(...answer.rows);
    if (!answer.next) return rows;
    after = answer.next;
  }
  throw new Error(
    `${query.name}: fan-out passed ${String(bound.pageSize * bound.fanOutPages)} rows; the set this joins over is not bounded`
  );
}
