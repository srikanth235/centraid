// Search grouping scaffold (#712): combinator only (find, cap, order); matching stays app-owned.
// Honest states: resting / searching (never a spinner) / ready / unreachable (must not collapse to "no results").
// Browser ES module, no bundler: framework-free (no React/DOM/`@centraid/vault`) so mobile can import the pure pieces.

/** From query + in-flight/reached, never from the UI. */
export type SearchStatus = "resting" | "searching" | "ready" | "unreachable";

/** Never inspects `Source` or `Hit` — cannot branch on app. */
export interface SearchEntity<Source, Hit> {
  key: string;
  label: string;
  /** App-ranked; scaffold caps, never reorders or invents. Named `match` not `find`: oxlint `unicorn/no-array-method-this-argument` flags any two-arg `.find(...)`. */
  match: (term: string, source: Source) => Hit[];
}

const DEFAULT_MAX_PER_GROUP = 3;

/** Declaration order, capped and concatenated — reorder the array, never this. */
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

/** Render-boundary row; never widen per app. */
export interface SearchGroupRow {
  /** Namespaces `key` across kinds — React must not confuse two hits. */
  kind: string;
  key: string;
  title: string;
  meta: string;
  /** Omit where it restates `meta`. */
  here?: string;
  /** Opaque; the app's `onOpenGroup` interprets it. */
  openTarget: string;
}

/** Keep announced name in step with what the row opens. */
export function searchOpenLabel(row: Pick<SearchGroupRow, "title">): string {
  return `Open ${row.title}`;
}

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
 * Three states, never collapsed into "no matches" (#726 D11): reached (rows trustworthy);
 * unreached (could not be asked — a STATE, never zero hits); refused (mask excluded an
 * indexed column — D10 — do not pass a narrower index off as the whole).
 * `row_filter_json` is NOT a fourth state: it compiles into the origin projection before
 * any row crosses the wire. Gateway enforces.
 */
export interface ScopeSearchReach {
  scope: string;
  state: "reached" | "unreached" | "refused";
  /** Present for unreached/refused; omit for reached. */
  detail?: string;
}

/** `refusedScopes` are known before any query (D10). `refused` wins over `unreached`. */
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

/** For `SearchStateCopy.unreachable.facts` — which scopes are short and why. */
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

/** Count plus the seat-honest scope the CALLER supplies — never pick scope text here. */
export function searchStatusLine(count: number, scope: string): string {
  return `${count} ${count === 1 ? "result" : "results"} · searched ${scope}`;
}

/**
 * The resting eyebrow is the HOUSE's word, not the seat's (#1015, S11): a
 * search at rest tells a member what to do in the app's own noun ("Search your
 * photos"), never reports the state it is in ("Nothing typed", "Search"). Five
 * seats had drifted across three strings; the string is written once, here, and
 * a seat supplies only its noun.
 */
export function searchRestingEyebrow(noun: string): string {
  return `Search your ${noun}`;
}

/** Copy as config: values/formatters only, never a branch on which app is asking. */
export interface SearchStateCopy {
  resting: {
    /** The app's own plural noun, lower case ("photos", "expenses") — the
     *  eyebrow is built from it by `searchRestingEyebrow`, never typed here. */
    noun: string;
    title: string;
    body: string;
  };
  searching: {
    lead: string;
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
