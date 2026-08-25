// The one search grouping scaffold (#712): entity rows -> states -> chip
// suggestions, shared so eight apps do not grow three grammars for "no results".
// Four honest states: `resting`, `searching` (determinate copy, never a
// spinner), `ready` (hits, or "no matches" with the query echoed back), and
// `unreachable` — search WILL NOT PRETEND TO HAVE LOOKED, so that last one never
// collapses into "no results".
//
// Matching stays APP-OWNED. Only the combinator — find, cap, order — lives here.
// Genericising the match itself would either flatten a real difference between
// apps or reintroduce the per-app switch this scaffold exists to avoid.
//
// BROWSER ES MODULE, NO BUNDLER (as `placement-registry.ts`): served straight to
// a browser with nothing to tree-shake a stray import away, so this module stays
// framework-free — no React, no DOM, no `@centraid/vault`. That is also what
// lets mobile import the pure pieces directly (docs/blueprint-seats.md).

/** Derived from query + in-flight/reached facts, never guessed from the UI. */
export type SearchStatus = "resting" | "searching" | "ready" | "unreachable";

/** The scaffold never inspects `Source` or `Hit`, so it cannot branch on app. */
export interface SearchEntity<Source, Hit> {
  key: string;
  /** The noun a caller's `meta` formatting uses; declared once per entity. */
  label: string;
  /** In the app's own ranked order. The scaffold caps, never reorders and never
   *  invents a hit. Named `match`, not `find`: oxlint's
   *  `unicorn/no-array-method-this-argument` pattern-matches any two-argument
   *  `.find(...)` call regardless of receiver type. */
  match: (term: string, source: Source) => Hit[];
}

const DEFAULT_MAX_PER_GROUP = 3;

/** Declaration order, capped and concatenated. No entity is special-cased: a
 *  caller wanting another order changes the array it passes, never this. */
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

/** One row above the primary results. App hits carrying more fields map DOWN to
 *  this at the render boundary; never widen it per app. */
export interface SearchGroupRow {
  /** Namespaces `key` across kinds so React never confuses two hits. */
  kind: string;
  key: string;
  title: string;
  /** The app formats this: only it knows its own unit. */
  meta: string;
  /** Omit where it would answer the same question as `meta`. */
  here?: string;
  /** Opaque to the scaffold; the app's own `onOpenGroup` interprets it. */
  openTarget: string;
}

/** Here so an announced name stays in step with what the row navigates to. */
export function searchOpenLabel(row: Pick<SearchGroupRow, "title">): string {
  return `Open ${row.title}`;
}

/** From the facts a fetch actually knows, so no app reinvents this branch. */
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
 * THREE honest states, never two collapsed into "no matches" (#726 D11):
 *   - 'reached'   the scope answered; its rows are trustworthy.
 *   - 'unreached' it could not be asked at all — a STATE, never zero hits.
 *   - 'refused'   it answered but a field mask excluded an indexed column
 *                 (D10), so it refuses rather than passing a narrower index
 *                 off as the whole one.
 *
 * A row filter is deliberately NOT a fourth state: `row_filter_json` compiles
 * into the origin's projection before any row crosses the wire, so there is no
 * client-side fact left to report. Enforcement is entirely the gateway's.
 */
export interface ScopeSearchReach {
  scope: string;
  state: "reached" | "unreached" | "refused";
  /** Present for 'unreached' and 'refused'; omitted for 'reached'. */
  detail?: string;
}

/**
 * `refusedScopes` carries scopes known to refuse BEFORE any query runs (the
 * mask-selection half of D10). `refused` wins over `unreached` for a scope that
 * is both: naming the mask is the more specific truth.
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

/** Shaped for `SearchStateCopy.unreachable.facts`, so the same renderable list
 *  can name WHICH scopes are short and why. */
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
 * Exact count plus the seat-honest scope the CALLER supplies
 * (docs/blueprint-seats.md). Never choose the scope text here: picking the wrong
 * one for a seat is a fact bug, and it belongs to the caller.
 */
export function searchStatusLine(count: number, scope: string): string {
  return `${count} ${count === 1 ? "result" : "results"} · searched ${scope}`;
}

/** Copy as config, not enumeration: every field is a plain value or a small
 *  formatter, never a branch on which app is asking. */
export interface SearchStateCopy {
  resting: { eyebrow: string; title: string; body: string };
  searching: {
    lead: string;
    /** After the count, already pluralised for it. */
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
