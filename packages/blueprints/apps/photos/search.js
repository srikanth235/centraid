// The server-search round trip (issue #352 phase 3): debounced like Docs'
// own search box (docs/app.jsx). app.jsx keeps `searchQuery`/`searchResults`
// as its own state (same as `assets`/`albums`) and merges the server hits
// with the client-side day/month/album-name match itself — this module owns
// only the fetch-and-debounce plumbing, not the merge, so it stays a thin
// sibling of albums-actions.js/selection-actions.js rather than a second copy
// of app.jsx's search logic.
import { debounce } from './kit.js';

export function createSearch({ getQuery, setResults, renderGrid }) {
  let seq = 0;

  const run = debounce(async () => {
    const term = getQuery();
    if (!term) {
      setResults(null);
      renderGrid();
      return;
    }
    const mySeq = (seq += 1);
    let assets = [];
    try {
      const res = await window.centraid.read({ query: 'search', input: { term } });
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
