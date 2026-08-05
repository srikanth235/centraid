// The server-search round trip (issue #352 phase 3): debounced like Docs'
// own search box (docs/app.tsx). app.tsx keeps `searchQuery`/`searchResults`
// as its own state (same as `assets`/`albums`) and merges the server hits
// with the client-side day/month/album-name match itself — this module owns
// only the fetch-and-debounce plumbing, not the merge, so it stays a thin
// sibling of albums-actions.ts/selection-actions.ts rather than a second copy
// of app.tsx's search logic.
// MULTI-SCOPE (issue #599): search fans out. It is contained because a search
// page is UNBOUNDED — it reaches each scope's whole live library — so there is
// no window to reconcile and none of merge.ts's horizon reasoning applies. Only
// its ordering, cross-scope dedupe and `scope_id` tagging do, which is exactly
// what merging N untruncated pages gives. The tagging is not cosmetic: a hit
// that reached the grid without one would paint the wrong photo, since content
// ids collide across scopes by design.
import { debounce } from "./kit.ts";
import { mergeScopePages } from "./merge.ts";
import type { MergeAsset } from "./merge.ts";
import { mountedScopes, ownScopeId } from "./scopes.ts";
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
 *  * `ready`       — the index answered. Hits, or the honest "no matches" line
 *                    with the query echoed back.
 *  * `unreachable` — the index lives on the gateway and could not be reached.
 *                    Search WILL NOT PRETEND TO HAVE LOOKED (§9), so this is
 *                    never collapsed into "no results".
 */
export type SearchStatus = "resting" | "searching" | "ready" | "unreachable";

export function createSearch({
  getQuery,
  setResults,
  setStatus,
  renderGrid,
}: {
  getQuery: () => string;
  setResults: (r: Asset[] | null) => void;
  /** Where §9's four states land. */
  setStatus: (status: SearchStatus) => void;
  renderGrid: () => void;
}): { run: () => void; invalidate: () => void } {
  let seq = 0;

  const run = debounce(async () => {
    const term = getQuery();
    if (!term) {
      setResults(null);
      setStatus("resting");
      renderGrid();
      return;
    }
    const mySeq = (seq += 1);
    let assets: Asset[] = [];
    let reached = true;
    try {
      const client = window.centraid;
      if (typeof client.readAll === "function") {
        const results = await client.readAll<{ assets?: Asset[] }>({
          query: "search",
          input: { term },
        });
        const pages = results.map((result) => ({
          scopeId: result.scope,
          // A scope that failed contributes no hits; the others still answer.
          assets: (result.ok
            ? (result.data?.assets ?? [])
            : []) as unknown as readonly MergeAsset[],
          // Untruncated by construction: nothing is withheld, and every hit
          // comes back tagged with the scope it is shown from.
          tail: null,
          truncated: false,
        }));
        const merged = mergeScopePages(pages, {
          ownScopeId: ownScopeId(mountedScopes()),
        });
        assets = merged.assets as unknown as Asset[];
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
    // A failed reach contributes NO results rather than an empty answer: the
    // local match over the loaded window stays on screen, and the shelf says
    // the index could not be reached instead of claiming nothing matched.
    setResults(reached ? assets : null);
    setStatus(reached ? "ready" : "unreachable");
    renderGrid();
  }, 150);

  // Called on every keystroke and on clear: a stale in-flight response must
  // never land after the query it answered no longer matches the input.
  function invalidate() {
    seq += 1;
  }

  return { run, invalidate };
}
