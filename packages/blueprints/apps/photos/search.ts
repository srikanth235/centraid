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
import { debounce } from './kit.ts';
import { mergeScopePages, type MergeAsset } from './merge.ts';
import { mountedScopes, ownScopeId } from './scopes.ts';
import type { Asset } from './types.ts';

export function createSearch({
  getQuery,
  setResults,
  renderGrid,
}: {
  getQuery: () => string;
  setResults: (r: Asset[] | null) => void;
  renderGrid: () => void;
}): { run: () => void; invalidate: () => void } {
  let seq = 0;

  const run = debounce(async () => {
    const term = getQuery();
    if (!term) {
      setResults(null);
      renderGrid();
      return;
    }
    const mySeq = (seq += 1);
    let assets: Asset[] = [];
    try {
      const client = window.centraid;
      if (typeof client.readAll === 'function') {
        const results = await client.readAll<{ assets?: Asset[] }>({
          query: 'search',
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
        const merged = mergeScopePages(pages, { ownScopeId: ownScopeId(mountedScopes()) });
        assets = merged.assets as unknown as Asset[];
      } else {
        const res = await client.read<{ assets?: Asset[] }>({ query: 'search', input: { term } });
        assets = res?.assets ?? [];
      }
    } catch {
      assets = [];
    }
    if (mySeq !== seq) return; // superseded by a newer keystroke's request
    setResults(assets);
    renderGrid();
  }, 150);

  // Called on every keystroke and on clear: a stale in-flight response must
  // never land after the query it answered no longer matches the input.
  function invalidate() {
    seq += 1;
  }

  return { run, invalidate };
}
