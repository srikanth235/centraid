/**
 * K-way merge of per-scope pages into ONE cross-scope list (#599, #726 D11).
 * Pure. Only `sortKey`/`direction` and `dedupeIdentity` vary per app; ordering,
 * dedupe, the safe horizon and the undated tail bucket are the same algorithm
 * for every caller — subtle and already correct, so no app gets a copy.
 *
 * ORDERING. Ties break by `dedupeIdentity` so the view is byte-stable across
 * re-reads (every survivor's identity is unique). A null `sortKey` sorts AFTER
 * every keyed row in both directions — where SQLite puts it within one scope —
 * keeping one stable null-keyed tail bucket.
 *
 * DEDUPE. A shared row exists in both the sharer's and the audience scope; the
 * OWN copy wins, because that is the one the member can edit, trash and
 * un-share. Between two audience copies the earlier input page wins.
 *
 * THE SHARED SAFE HORIZON — the subtle part. A truncated scope is COMPLETE at or
 * before its `tail`, UNKNOWN beyond. Merging windows of different depths is the
 * danger: with one scope back to March and another only to July, a May row from
 * the shallower scope would later be INSERTED above rows already on screen. So
 * the list may only extend to the SHALLOWEST truncated tail. Non-truncated
 * scopes constrain nothing.
 *
 * A truncated scope with a null `tail` ran out inside the null bucket: it still
 * knows every keyed row, so it must NOT drag the keyed horizon toward itself. It
 * does cap the null bucket — hence null rows are withheld while ANY scope is
 * truncated.
 */

/** Which end is "first": `desc` = highest `sortKey`, `asc` = lowest. */
export type MergeDirection = "asc" | "desc";

/** One scope's page of already-fetched rows. */
export interface ScopePage<Row> {
  scopeId: string;
  rows: readonly Row[];
  /** Closest to the deep/unknown end; null for an empty page or one that ran
   *  out inside the null-keyed tail. */
  tail: string | null;
  truncated: boolean;
}

/** Tagged with the scope it is shown FROM. */
export type MergedRow<Row> = Row & { scope_id: string };

export interface MergeResult<Row> {
  /** In `direction` order, deduped, horizon-safe. */
  rows: MergedRow<Row>[];
  /** Furthest value safe to show; null when nothing is withheld. */
  horizon: string | null;
  /** Re-query exactly these for "load more". */
  horizonScopeIds: string[];
  /** Deduped rows the horizon held back. */
  withheld: number;
  /** Any scope still truncated — i.e. "load more" is meaningful. */
  truncated: boolean;
}

export interface MergeOptions<Row> {
  /** The dedupe winner. */
  ownScopeId: string;
  /** Orders and windows on this; null for a row with nothing to sort by. */
  sortKey: (row: Row) => string | null | undefined;
  direction: MergeDirection;
  /** Cross-scope dedupe identity; also the tie-break, unique by then. */
  dedupeIdentity: (row: Row) => string;
}

/** `a` closer to the shallow (fully known) end than `b`. */
function shallower(a: string, b: string, direction: MergeDirection): boolean {
  return direction === "desc" ? a > b : a < b;
}

/** `value` is on the safe side of `horizon`. */
function atOrBeforeHorizon(
  value: string,
  horizon: string,
  direction: MergeDirection
): boolean {
  return direction === "desc" ? value >= horizon : value <= horizon;
}

/** Shallowest first; null `sortKey` last; ties by identity (unique by then). */
function compareRows<Row>(
  sortKey: (row: Row) => string | null | undefined,
  direction: MergeDirection,
  dedupeIdentity: (row: Row) => string
): (a: MergedRow<Row>, b: MergedRow<Row>) => number {
  return (a, b) => {
    const av = sortKey(a) ?? null;
    const bv = sortKey(b) ?? null;
    if (av !== bv) {
      if (av == null) return 1;
      if (bv == null) return -1;
      return shallower(av, bv, direction) ? -1 : 1;
    }
    const ai = dedupeIdentity(a);
    const bi = dedupeIdentity(b);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  };
}

/** The horizon + the scopes sitting at it. Reasoning: module header. */
function horizonOf<Row>(
  pages: readonly ScopePage<Row>[],
  direction: MergeDirection
) {
  const truncated = pages.filter((page) => page.truncated);
  const dated = truncated.filter((page) => page.tail != null);
  let horizon: string | null = null;
  for (const page of dated) {
    if (horizon == null || shallower(page.tail!, horizon, direction))
      horizon = page.tail!;
  }
  // Null-tailed truncated scopes belong here too: they cap the null-keyed
  // bucket, and paging them is the only way to lift that cap.
  const atHorizon = truncated.filter(
    (page) => page.tail === horizon || page.tail == null
  );
  return {
    horizon,
    horizonScopeIds: atHorizon.map((page) => page.scopeId),
    anyTruncated: truncated.length > 0,
  };
}

export function mergeScopePages<Row>(
  pages: readonly ScopePage<Row>[],
  options: MergeOptions<Row>
): MergeResult<Row> {
  const { ownScopeId, sortKey, direction, dedupeIdentity } = options;
  const byIdentity = new Map<string, MergedRow<Row>>();
  for (const page of pages) {
    for (const row of page.rows) {
      const key = dedupeIdentity(row);
      const seen = byIdentity.get(key);
      // Own wins over any audience copy; otherwise first page order wins.
      if (seen && (seen.scope_id === ownScopeId || page.scopeId !== ownScopeId))
        continue;
      byIdentity.set(key, { ...row, scope_id: page.scopeId });
    }
  }

  const { horizon, horizonScopeIds, anyTruncated } = horizonOf(
    pages,
    direction
  );
  const merged = [...byIdentity.values()].sort(
    compareRows(sortKey, direction, dedupeIdentity)
  );
  // Null-keyed rows sit below every keyed one, so any truncation can hide one
  // the merge has not seen — withhold the whole bucket meanwhile.
  const safe = merged.filter((row) => {
    const value = sortKey(row);
    if (value == null) return !anyTruncated;
    return horizon == null || atOrBeforeHorizon(value, horizon, direction);
  });

  return {
    rows: safe,
    horizon,
    horizonScopeIds,
    withheld: merged.length - safe.length,
    truncated: anyTruncated,
  };
}
