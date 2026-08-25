/**
 * K-way merge of per-scope pages into ONE cross-scope list (#599,
 * #726 D11). Pure: no DOM, no IO — it takes what each scope's own
 * query page returned and decides what the merged view may show.
 *
 * WHAT IS AND IS NOT GENERICISED. Two things vary per app and are
 * PARAMETERS: `sortKey` + `direction` (Photos: `taken_at` descending; a
 * record-only app: its own row id, since rows have no separate timestamp the
 * merge can trust across scopes) and `dedupeIdentity` (Photos: sha256-else-
 * content_id; a record-only app: its own row id — there is no separate
 * "same bytes, different row" question for a record). Everything else —
 * ordering, cross-scope dedupe, the shared safe horizon, the undated tail
 * bucket — is the SAME algorithm for every caller: it is subtle and already
 * correct, and no app gets its own copy of it.
 *
 * ORDERING. `direction` ("desc": highest `sortKey` first, "asc": lowest
 * first) determines display order, matching each page's own order. Two rows
 * tied on `sortKey` tie-break by `dedupeIdentity` ascending so the view is
 * byte-stable across re-reads — safe because, by construction, every row
 * surviving the dedupe pass below already has a UNIQUE identity. A row whose
 * `sortKey` is null (Photos: an undated import) sorts AFTER every non-null
 * row regardless of `direction` — the same place SQLite's `ORDER BY …`
 * puts it inside a single scope, so merging N scopes keeps one stable
 * null-keyed tail bucket instead of interleaving nulls anywhere.
 *
 * DEDUPE. A row shared into an audience exists in BOTH the sharer's own scope
 * and the audience scope, so the merged list would show it twice. Identity is
 * `dedupeIdentity(row)`. When a duplicate spans scopes the OWN-scope copy
 * wins: it is the copy the member can edit, retitle, trash and un-share, so
 * acting on the surviving row always acts on the thing the member controls.
 * Among two audience copies, the earlier page in the input order wins —
 * deterministic, and the caller controls that order. Each survivor is tagged
 * with `scope_id`: the scope it is shown FROM.
 *
 * THE SHARED SAFE HORIZON — the subtle part. Each page is a bounded window:
 * `truncated` says older/further rows exist beyond it, and `tail` is the
 * `sortKey` value furthest from the shallow end that the window reached. A
 * scope that is truncated is therefore COMPLETE for every `sortKey` at or
 * before its own tail (per `direction`) and UNKNOWN beyond it.
 *
 * Merging windows of different depths is what makes this dangerous: if one
 * scope reached back to March and another only to July, everything the
 * merged list shows before July is the deeper scope's only — a May row from
 * the shallower scope would appear later, INSERTED above rows already on
 * screen, once it pages deeper. So the merged list may only extend as deep as
 * the SHALLOWEST truncated scope, i.e. to the tail closest to the shallow end
 * among truncated scopes. That is the horizon. Every scope — truncated or not
 * — is fully known at or shallower than it, so rows at or before the horizon
 * are safe to show and rows strictly beyond are withheld until the horizon
 * scopes page deeper. Non-truncated scopes constrain nothing: they already
 * returned everything.
 *
 * A truncated scope whose `tail` is null ran out inside the null-keyed
 * bucket: it still knows every keyed row it has, so it must NOT drag the
 * keyed horizon toward itself — such scopes are skipped when picking the
 * horizon. They do constrain the null-keyed bucket, which is why null-keyed
 * rows are withheld while ANY scope is truncated (they sort below every
 * keyed row, hence below any horizon).
 *
 * `horizonScopeIds` names the truncated scopes sitting AT the horizon (plus,
 * when the horizon is null-tailed only, the truncated scopes generally), so
 * "load more" re-queries exactly those scopes and leaves the settled ones
 * alone.
 */

/** Which of a page's newer-vs-deeper directions is "first" in the merged
 *  view. `desc`: highest `sortKey` first (Photos: newest first). `asc`:
 *  lowest first (a record-only app reading oldest-first). */
export type MergeDirection = "asc" | "desc";

/** One scope's page of already-fetched rows. */
export interface ScopePage<Row> {
  scopeId: string;
  rows: readonly Row[];
  /** The page's `sortKey` value closest to the deep/unknown end, or null
   *  (empty page, or a page that ran out inside the null-keyed tail). */
  tail: string | null;
  truncated: boolean;
}

/** A merged row, tagged with the scope it is shown from. */
export type MergedRow<Row> = Row & { scope_id: string };

export interface MergeResult<Row> {
  /** In `direction` order, deduped, horizon-safe. */
  rows: MergedRow<Row>[];
  /** The furthest `sortKey` value safe to show, or null when nothing is
   *  withheld. */
  horizon: string | null;
  /** Scopes to re-query for "load more" — the ones sitting at the horizon. */
  horizonScopeIds: string[];
  /** How many deduped rows the horizon held back. */
  withheld: number;
  /** Whether any scope is still truncated (i.e. "load more" is meaningful). */
  truncated: boolean;
}

export interface MergeOptions<Row> {
  /** The member's own scope id — the dedupe winner. */
  ownScopeId: string;
  /** The field the merge orders and windows on. Returns null for a row with
   *  nothing to sort by (Photos: an undated import). */
  sortKey: (row: Row) => string | null | undefined;
  direction: MergeDirection;
  /** The cross-scope identity a shared row is deduped — and, since every
   *  surviving row's identity is by then unique, tie-broken — on. */
  dedupeIdentity: (row: Row) => string;
}

/** True when `a` sits closer to the shallow (already fully known) end of the
 *  scan than `b` — `desc`: numerically greater; `asc`: numerically smaller. */
function shallower(a: string, b: string, direction: MergeDirection): boolean {
  return direction === "desc" ? a > b : a < b;
}

/** True when `value` is on the safe side of `horizon` — `desc`: `value >=
 *  horizon`; `asc`: `value <= horizon`. */
function atOrBeforeHorizon(
  value: string,
  horizon: string,
  direction: MergeDirection
): boolean {
  return direction === "desc" ? value >= horizon : value <= horizon;
}

/** Newest/shallowest first per `direction`; null `sortKey` last; ties broken
 *  by `dedupeIdentity` ascending (unique by construction — see header). */
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

/** The horizon + the scopes sitting at it. See the header for the reasoning. */
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
  // At the horizon: the keyed truncated scopes whose tail IS the horizon,
  // plus every null-tailed truncated scope (they cap the null-keyed bucket,
  // and paging them is the only way to lift that cap).
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
  // Null-keyed rows sit below every keyed one, so any truncation at all can
  // still hide one the merge hasn't seen — withhold the whole bucket meanwhile.
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
