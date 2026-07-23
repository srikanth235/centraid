// The server-search round trip (issue #352 phase 3): debounced like Docs'
// own search box (docs/app.tsx). app.tsx keeps `searchQuery`/`searchResults`
// as its own state (same as `assets`/`albums`) and merges the server hits
// with the client-side day/month/album-name match itself — this module owns
// only the fetch-and-debounce plumbing, not the merge, so it stays a thin
// sibling of albums-actions.ts/selection-actions.ts rather than a second copy
// of app.tsx's search logic.
import { debounce } from './kit.ts';
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
      const res = await window.centraid.read<{ assets?: Asset[] }>({
        query: 'search',
        input: { term },
      });
      assets = res?.assets ?? [];
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
