// The server-search round trip (issue #352 phase 3): debounced like Docs'
// own search box (docs/app.tsx). app.tsx keeps `searchQuery`/`searchResults`
// as its own state (same as `assets`/`albums`) and merges the server hits
// with the client-side day/month/album-name match itself — this module owns
// only the fetch-and-debounce plumbing, not the merge, so it stays a thin
// sibling of albums-actions.ts/selection-actions.ts rather than a second copy
// of app.tsx's search logic.
// MULTI-SCOPE (issue #599): search fans out. It is contained because a search
// page is UNBOUNDED — it reaches each scope's whole live library — so there is
// no window to reconcile and none of scope-merge.ts's horizon reasoning
// applies. Only its ordering, cross-scope dedupe and `scope_id` tagging do,
// which is exactly what merging N untruncated pages gives. The tagging is not
// cosmetic: a hit that reached the grid without one would paint the wrong
// photo, since content ids collide across scopes by design.
// PER-SCOPE REACH (issue #726 D10/D11): a scope that failed to answer is a
// NAMED STATE (`reachFacts`), never a reason to blank a scope that DID
// answer. Own results (or any other reached scope's) still render when a
// borrowed scope could not be asked — the whole search only collapses to
// `unreachable` when NOTHING reached, which is the one case with nothing
// honest left to show.
import { mountedScopes, ownScopeId } from "../_shared/scope-kit.ts";
import { mergeScopePages } from "../_shared/scope-merge.ts";
import { perScopeReach, scopeReachFacts } from "../_shared/search-scaffold.ts";
import { debounce } from "./kit.ts";
import {
  photoDedupeIdentity,
  photosScopeDeclaration,
} from "./scope-declaration.ts";
import type { MergeableAsset } from "./scope-declaration.ts";
import type { Asset } from "./types.ts";

/**
 * Which of §9's states the search shelf is in. It is derived HERE, not in the
 * view, because only this module knows whether the index answered:
 *
 *  * `resting`     — no query. The shelf shows what it searches and five real
 *                    example queries.
 *  * `searching`   — a request is in flight. Determinate copy, never a spinner:
 *                    what is already on screen is the local match over the
 *                    loaded window, and the shelf says so.
 *  * `ready`       — at least one mounted scope answered. Hits from every
 *                    scope that answered, or the honest "no matches" line
 *                    with the query echoed back — plus `reachFacts` naming
 *                    any scope that did NOT answer (issue #726 D10), rather
 *                    than pretending the whole answer is complete.
 *  * `unreachable` — NO mounted scope answered — nothing genuine to show.
 *                    Search WILL NOT PRETEND TO HAVE LOOKED (§9), so this is
 *                    never collapsed into "no results".
 */
export type SearchStatus = "resting" | "searching" | "ready" | "unreachable";

export function createSearch({
  getQuery,
  setResults,
  setStatus,
  renderGrid,
  setReachFacts,
}: {
  getQuery: () => string;
  setResults: (r: Asset[] | null) => void;
  /** Where §9's four states land. */
  setStatus: (status: SearchStatus) => void;
  renderGrid: () => void;
  /**
   * Per-scope reach for the current answer (issue #726 D10/D11) — empty when
   * every mounted scope answered, otherwise one `{label, value}` fact per
   * scope that did not, named ready for a caller's UI to render BESIDE
   * whatever results the other scopes still have (never in place of them).
   * Optional so a host that has not yet wired a facts panel keeps compiling
   * unchanged; the underlying reach is still computed and gates `status`
   * either way.
   */
  setReachFacts?: (facts: readonly { label: string; value: string }[]) => void;
}): { run: () => void; invalidate: () => void } {
  let seq = 0;

  const run = debounce(async () => {
    const term = getQuery();
    if (!term) {
      setResults(null);
      setStatus("resting");
      setReachFacts?.([]);
      renderGrid();
      return;
    }
    const mySeq = (seq += 1);
    let assets: Asset[] = [];
    // `reached` gates whether THIS search has anything genuine to show at
    // all (the multi-scope path sets it below from per-scope reach; the
    // single-scope/catch paths below still use the plain try/catch
    // all-or-nothing reading, since there is only ever one scope to ask).
    let reached = true;
    let reachFacts: Array<{ label: string; value: string }> = [];
    try {
      const client = window.centraid;
      if (typeof client.readAll === "function") {
        const results = await client.readAll<{ assets?: Asset[] }>({
          query: "search",
          input: { term },
        });
        // A scope that failed must not be silently absorbed as "zero hits",
        // AND must not blank a scope that DID answer — either reading claims
        // more or less than what actually happened. `perScopeReach` names
        // each scope's own state; `reached` here means "at least one scope
        // has a genuine answer to show", so this search stays `ready` with
        // whatever it has and names the short scope in `reachFacts`, rather
        // than collapsing a healthy own-library answer to `unreachable`
        // because one friend's machine is asleep (issue #726 D10/D11).
        const reach = perScopeReach(results);
        reached = reach.some((entry) => entry.state === "reached");
        reachFacts = scopeReachFacts(reach);
        const pages = results.map((result) => ({
          scopeId: result.scope,
          rows: (result.ok
            ? (result.data?.assets ?? [])
            : []) as unknown as readonly MergeableAsset[],
          // Untruncated by construction: nothing is withheld, and every hit
          // comes back tagged with the scope it is shown from.
          tail: null,
          truncated: false,
        }));
        const merged = mergeScopePages(pages, {
          ownScopeId: ownScopeId(mountedScopes()),
          sortKey: photosScopeDeclaration.mergeKey,
          direction: "desc",
          dedupeIdentity: photoDedupeIdentity,
        });
        assets = merged.rows as unknown as Asset[];
      } else {
        const res = await client.read<{ assets?: Asset[] }>({
          query: "search",
          input: { term },
        });
        assets = res?.assets ?? [];
      }
    } catch {
      assets = [];
      reached = false;
    }
    if (mySeq !== seq) return; // superseded by a newer keystroke's request
    // A totally failed reach contributes NO results rather than an empty
    // answer: nothing genuine came back from anywhere, so the shelf says the
    // index could not be reached instead of claiming nothing matched. A
    // PARTIAL reach still renders what the reached scope(s) have — the short
    // scope is named in `reachFacts`, never silently absorbed into either
    // the results or the "no matches" line.
    setResults(reached ? assets : null);
    setStatus(reached ? "ready" : "unreachable");
    setReachFacts?.(reached ? reachFacts : []);
    renderGrid();
  }, 150);

  // Called on every keystroke and on clear: a stale in-flight response must
  // never land after the query it answered no longer matches the input.
  function invalidate() {
    seq += 1;
  }

  return { run, invalidate };
}
