// The one search grouping scaffold (issue #712 S1): entity rows -> states ->
// chip suggestions, shared across every blueprint app's search surface so
// eight apps do not grow three grammars for "no results".
//
// Photos (`apps/photos/search.ts` + `search-groups.ts` + `components/
// SearchShelf.tsx`) is the canonical pattern this was extracted from: a
// debounced live query against the gateway, a short list of person/place/
// album/things ROWS above the primary results (grid, ledger, whatever the
// app's own list is), and four honest states — `resting` (nothing typed),
// `searching` (a request is in flight, determinate copy, never a spinner),
// `ready` (hits, or the honest "no matches" line with the query echoed
// back), and `unreachable` (the index lives on the gateway and could not be
// reached — search WILL NOT PRETEND TO HAVE LOOKED, so this never collapses
// into "no results").
//
// WHAT IS AND IS NOT GENERICISED. Matching a query against an app's own data
// stays app-owned: Photos' `search-groups.ts` matches a client-held person/
// place/album/tag roster, Tally's `search-groups.ts` matches groups and
// friends already loaded on the dashboard, and mobile's `search-hits.ts`
// matches replica rows against RN navigation targets — three shapes with
// nothing structurally in common except "find, then cap, then order". That
// combinator — `groupSearchHits` — is what lives here. Genericising the
// MATCH itself would either flatten a real difference between apps into a
// lowest common denominator, or reintroduce exactly the per-app switch this
// scaffold exists to avoid.
//
// BROWSER ES MODULE, NO BUNDLER (same constraint as `placement-registry.ts`).
// The web blueprint apps are served straight to a browser — nothing here
// tree-shakes a stray import away — so this module stays framework-free: no
// React, no DOM, no `@centraid/vault`. That is also what lets
// `apps/mobile/src/apps/photos/search-hits.ts` import the pure pieces
// (`groupSearchHits`) directly, the same way it already imports
// `apps/_shared/placement-registry.ts` and `apps/photos/shared-copy.ts` — see
// docs/blueprint-seats.md's north-star table for why mobile and web share
// logic modules but never UI.

/** Which of the four states a search surface is in. Derived from a query, a
 *  fetch's in-flight/reached facts — never guessed from the UI. */
export type SearchStatus = "resting" | "searching" | "ready" | "unreachable";

/**
 * One entity a search surface can honestly back with real hits — Photos'
 * person/place/album/things, Tally's group/person, and so on. `match` is the
 * app's own match function against its own data; the scaffold never inspects
 * `Source` or `Hit`, so it cannot branch on which app or which entity it is
 * looking at.
 */
export interface SearchEntity<Source, Hit> {
  /** Stable across a render, and typically also the `kind` tag on the hits
   *  this entity produces (though the scaffold does not require that — it
   *  never reads inside `Hit`). */
  key: string;
  /** The noun a caller's own `meta` formatting uses, e.g. "person" — kept on
   *  the config so it is declared once per entity, not re-typed at every
   *  call site that needs it. */
  label: string;
  /** Finds this entity's matches for `term` in `source`, in the app's own
   *  ranked order. The scaffold caps the result; it never reorders it and
   *  never invents a hit `match` did not return. Named `match`, not `find`
   *  — oxlint's `unicorn/no-array-method-this-argument` pattern-matches any
   *  two-argument `.find(...)` call as `Array.prototype.find`'s
   *  `(callback, thisArg)` shape regardless of receiver type. */
  match: (term: string, source: Source) => Hit[];
}

const DEFAULT_MAX_PER_GROUP = 3;

/**
 * The whole of what "grouping" means once every entity can already find its
 * own hits: lower-case and trim the term (empty stays empty — resting has no
 * hits to group), run each entity's `match` in the order `entities` declares,
 * cap each to `maxPerGroup`, and concatenate. No entity is special-cased; a
 * caller that wants a different order changes the array it passes in, not
 * this function.
 */
export function groupSearchHits<Source, Hit>(
  term: string,
  source: Source,
  entities: readonly SearchEntity<Source, Hit>[],
  maxPerGroup: number = DEFAULT_MAX_PER_GROUP
): Hit[] {
  const trimmed = term.trim().toLowerCase();
  if (!trimmed) return [];
  return entities.flatMap((entity) =>
    entity.match(trimmed, source).slice(0, maxPerGroup)
  );
}

/** One row in the grouped-hits list a search surface draws above its primary
 *  results (the ruled subject / kind+count / "Open ->" row from the design
 *  handoff). `SearchScaffold.tsx` renders this shape; an app's own entity
 *  hits (which may carry more fields, like Photos' `SearchGroupHit`) are
 *  mapped down to it at the render boundary rather than widening this type
 *  per app. */
export interface SearchGroupRow {
  /** Namespaces `key` across kinds so React never confuses one hit for
   *  another, and groups the row under its entity's `meta` styling. */
  kind: string;
  key: string;
  title: string;
  /** The `<kind> · ...` line under the title — the app formats it, since
   *  only the app knows its own unit ("photographs", "expenses", ...). */
  meta: string;
  /** The optional "N here" figure — omitted where a second count would
   *  answer the same question the meta line already answers. */
  here?: string;
  /** Opaque to the scaffold; the app's own `onOpenGroup` interprets it. */
  openTarget: string;
}

/** The accessible name for a group row's "Open ->" control. Kept here so a
 *  row's announced name stays in step with what it navigates to, regardless
 *  of which app built the row. */
export function searchOpenLabel(row: Pick<SearchGroupRow, "title">): string {
  return `Open ${row.title}`;
}

/**
 * Derives which of the four states a search surface is in from the facts a
 * fetch actually knows — the same decision Photos' `search.ts` makes inline
 * in its `try { } catch { reached = false }` — so a second app does not
 * reinvent that branch as its own private state machine.
 */
export function deriveSearchStatus(input: {
  query: string;
  inFlight: boolean;
  reached: boolean;
}): SearchStatus {
  if (!input.query.trim()) return "resting";
  if (input.inFlight) return "searching";
  return input.reached ? "ready" : "unreachable";
}

/**
 * Per-scope reach for a multi-scope fan-out (`window.centraid.readAll`):
 * THREE honest states, never two collapsed into "no matches" (issue #726
 * D11/item 7):
 *
 *   - 'reached'   the scope answered; its rows are trustworthy.
 *   - 'unreached' the scope could not be asked at all (offline peer, dropped
 *                 edge, timeout) — a STATE, never zero hits.
 *   - 'refused'   the scope answered but named columns it will not search —
 *                 a field mask excluded an indexed column
 *                 (`BorrowedStore.search()`'s `refusedEntities`, D10) — so it
 *                 REFUSES rather than pretending a narrower index was the
 *                 whole one.
 *
 * A row filter is deliberately NOT a fourth state here: `row_filter_json`
 * compiles into the origin's projection before any row crosses the wire
 * (`lend-origin.ts`), so a filtered-out row was never in the borrowed store
 * to page past in the first place — there is no client-side fact left to
 * report about it. Enforcement lives entirely at the gateway; this scaffold
 * has nothing to add there and nothing to get wrong.
 */
export interface ScopeSearchReach {
  scope: string;
  state: "reached" | "unreached" | "refused";
  /** Present for 'unreached' (what the transport said) or 'refused' (which
   *  column/entity the mask excluded) — omitted for 'reached'. */
  detail?: string;
}

/**
 * Build the per-scope reach list from a multi-scope fan-out's own results
 * (`window.centraid.readAll`'s `InlineScopeRead<T>[]` shape: `{scope, ok,
 * error?}`) plus which scopes are KNOWN to refuse before any query even runs
 * — the mask-selection-time half of D10 (`searchReachFor` on the gateway
 * names these when a live edge is lent; a caller threads that answer through
 * to `refusedScopes` here rather than discovering it query by query).
 *
 * `refused` wins over `unreached` for a scope that is BOTH: a scope whose
 * mask already refuses does not need reachability to explain why it has
 * nothing — naming the mask is the more useful, more specific truth.
 */
export function perScopeReach(
  results: readonly {
    scope: string;
    ok: boolean;
    error?: { code?: string; message?: string };
  }[],
  refusedScopes?: ReadonlyMap<string, string>
): ScopeSearchReach[] {
  return results.map((result) => {
    const refusedReason =
      refusedScopes?.get(result.scope) ??
      (result.error?.code === "REPLICA_SEARCH_REFUSED"
        ? result.error.message
        : undefined);
    if (refusedReason !== undefined) {
      return { scope: result.scope, state: "refused", detail: refusedReason };
    }
    if (result.ok) return { scope: result.scope, state: "reached" };
    return {
      scope: result.scope,
      state: "unreached",
      ...(result.error?.message ? { detail: result.error.message } : {}),
    };
  });
}

/** Per-scope reach, shaped for `SearchStateCopy.unreachable.facts` — so the
 *  SAME renderable list the four-state copy contract already expects can
 *  name which scopes are short and why, not just that the search overall
 *  is `unreachable`. */
export function scopeReachFacts(
  reach: readonly ScopeSearchReach[]
): Array<{ label: string; value: string }> {
  return reach
    .filter((row) => row.state !== "reached")
    .map((row) => ({
      label: row.scope,
      value:
        row.state === "refused"
          ? (row.detail ?? "search refused here")
          : (row.detail ?? "could not be reached"),
    }));
}

/**
 * The one-line footer every populated result view carries (Photos' §9
 * honesty line): an exact count plus the seat-honest scope the caller
 * supplies. Viewer seats say "the live library" (or an app-appropriate noun
 * for the same fact); origin seats say "the whole replica on this device"
 * (docs/blueprint-seats.md §Worked example: search). This function does not
 * choose the scope text — picking the wrong one for a seat is a fact bug,
 * not a copy bug, and stays on the caller who knows which seat it is.
 */
export function searchStatusLine(count: number, scope: string): string {
  return `${count} ${count === 1 ? "result" : "results"} · searched ${scope}`;
}

/** The copy a `SearchScaffold` render needs for its four states, plus the
 *  chip suggestions for the resting panel — the "per-app entity lists /
 *  copy as config, not enumeration" half of the scaffold. Every field is a
 *  plain value or a small formatter, never a branch on which app is asking. */
export interface SearchStateCopy {
  resting: { eyebrow: string; title: string; body: string };
  searching: {
    /** The sentence before the count, e.g. "Searching your whole library." */
    lead: string;
    /** The words after the count, already pluralised for it. */
    trail: (count: number) => string;
  };
  miss: {
    eyebrow: string;
    title: (query: string) => string;
    body: string;
    clear: string;
  };
  unreachable: {
    eyebrow: string;
    title: string;
    body: string;
    facts: readonly { label: string; value: string }[];
    retry: string;
  };
}
