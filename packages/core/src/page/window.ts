/*
 * THE PAGE (#996 wave 4, ruling R8). One shape, imported by every handler on
 * every seat, and there is no unpaged variant of it.
 *
 * WHAT THIS REPLACES. The old read vocabulary let a caller declare no window
 * (`acceptTruncation: true`), took whatever the reader's default was, and then
 * announced after the fact that the answer had been cut (`truncated`,
 * `appliedLimit`). Three things were wrong with that and only the third is
 * fatal: it made the window invisible at the call site, it made "there is more"
 * a dead end rather than a continuation, and it made the unbounded read the
 * cheapest thing to write — which is why there were roughly two hundred of
 * them. `PageRequest.limit` is REQUIRED, so a handler that wants everything
 * does not typecheck; that is the whole enforcement mechanism.
 *
 * KEYSET, NEVER OFFSET. The cursor is the sort key itself — `(sortKey, pk)` —
 * so a continuation is one index seek. `LIMIT n OFFSET k` makes the store walk
 * and discard k rows, so the hundredth page costs a hundred pages; nothing a
 * caller is handed here can be turned back into an offset.
 *
 * THE PK IS IN THE KEY BECAUSE THE SORT KEY IS NOT UNIQUE. Two rows can share
 * a timestamp. Keyed on the timestamp alone, a page boundary that falls between
 * them either repeats one or drops one, depending on which way the comparison
 * is written, and both are silent. The primary key is the tiebreak, and the
 * store compares the pair as a row value.
 *
 * Zero runtime dependencies and no `node:` imports — `packages/core` is
 * consumed from source by React Native.
 */

/**
 * Where a page stopped: the last row's sort key and primary key.
 *
 * Opaque to the member, not to the handler — it is the ORDER BY, spelled out,
 * and a handler that continues from it must be ordering by the same thing or
 * the walk is not a walk.
 */
export interface PageCursor {
  sortKey: string;
  pk: string;
}

/**
 * A window, and where to start it. `limit` has no default on purpose: a default
 * is how an unbounded read gets written by accident.
 */
export interface PageRequest {
  limit: number;
  /** Absent means the first page. */
  after?: PageCursor;
}

/**
 * One page of rows, and the cursor to continue from.
 *
 * `next` is ABSENT when the rows ended, never `null` and never a `truncated`
 * boolean: the two states a caller has to tell apart are "continue from here"
 * and "there is nothing after this", and a cursor is exactly that pair.
 */
export interface Page<Row> {
  rows: Row[];
  next?: PageCursor;
}

/**
 * The handler host's one measured safety net.
 *
 * It is a CEILING, not a policy: a handler picks the window its screen needs,
 * and this is the number past which no request is honoured whatever it asked
 * for. It clamps rather than refusing, because a member who scrolled fast is
 * not doing anything wrong and a screen that goes dark is a worse answer than a
 * shorter page followed by another one. The clamp is visible where it belongs —
 * in the work counters the host records — not in the member's way.
 *
 * Five hundred rows: two orders of magnitude over the largest screenful any
 * first-party app draws, and small enough that a page of the widest row shape
 * in the vault stays well inside a worker message.
 */
export const MAX_PAGE_ROWS = 500;

/**
 * The number of rows a handler asks the store for: the window plus ONE.
 *
 * That extra row is the probe, and it is the only thing that separates "the
 * window filled" from "the rows ended here". A handler that fetched exactly
 * `limit` rows and got `limit` back cannot tell the two apart, which is the
 * position the old reader was in when it had to announce a truncation it was
 * not sure of. The probe is dropped in `pageOf` and never reaches a caller.
 */
export function probeLimit(request: PageRequest): number {
  const limit = request.limit;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error(
      `page limit must be a positive whole number of rows, got ${String(limit)}`
    );
  return Math.min(limit, MAX_PAGE_ROWS) + 1;
}

/**
 * The page a store's `probeLimit` rows make: the probe dropped, and the cursor
 * derived from the last row that survived.
 *
 * `keyOf` is the handler's own ORDER BY, restated as a function, so the cursor
 * and the ordering come from one place in each handler rather than two that can
 * drift apart.
 */
export function pageOf<Row>(
  fetched: readonly Row[],
  request: PageRequest,
  keyOf: (row: Row) => PageCursor
): Page<Row> {
  const window = Math.min(request.limit, MAX_PAGE_ROWS);
  if (!Number.isSafeInteger(window) || window < 1)
    throw new Error(
      `page limit must be a positive whole number of rows, got ${String(request.limit)}`
    );
  const filled = fetched.length > window;
  const rows = (filled ? fetched.slice(0, window) : [...fetched]) as Row[];
  const last = rows.at(-1);
  return filled && last ? { rows, next: keyOf(last) } : { rows };
}
