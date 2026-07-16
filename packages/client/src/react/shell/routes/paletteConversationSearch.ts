/*
 * Async conversation search source for the ⌘K palette (issue #420, Wave 3).
 *
 * The palette's `buildPaletteGroups` is synchronous — it's re-run on every
 * keystroke and again whenever the palette's injected `refresh()` fires. FTS
 * conversation search is a server round-trip, so this source bridges the two:
 * `results(query)` reads a synchronous cache (empty while a fetch is in
 * flight), and `ensure(query)` schedules a debounced fetch that, on arrival,
 * fills the cache and calls `onResults()` — which the shell wires to the
 * palette's `refresh()`, re-running `buildPaletteGroups` so the hits appear.
 *
 * Kept framework-free and dependency-injected (the `search` fn + `onResults`
 * callback) so it's unit-testable with fake timers and a stub searcher.
 */

export interface PaletteConversationHit {
  id: string;
  title: string;
  snippet: string;
}

export interface PaletteConversationSearch {
  /** Cached hits for the trimmed query (`[]` until a fetch settles). */
  results(query: string): PaletteConversationHit[];
  /** Schedule a debounced FTS fetch for `query` unless already cached/in-flight. */
  ensure(query: string): void;
  /** Drop the cache + any pending fetch (call when the palette closes). */
  reset(): void;
}

export interface PaletteConversationSearchOptions {
  search: (query: string, limit?: number) => Promise<PaletteConversationHit[]>;
  onResults: () => void;
  limit?: number;
  debounceMs?: number;
}

const MIN_QUERY_CHARS = 2;

export function createPaletteConversationSearch(
  opts: PaletteConversationSearchOptions,
): PaletteConversationSearch {
  const cache = new Map<string, PaletteConversationHit[]>();
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingQuery: string | undefined;
  const debounceMs = opts.debounceMs ?? 150;

  const norm = (q: string): string => q.trim().toLowerCase();

  const run = (key: string): void => {
    if (cache.has(key) || inFlight.has(key)) return;
    inFlight.add(key);
    void opts
      .search(key, opts.limit ?? 20)
      .then((hits) => {
        cache.set(key, hits);
      })
      .catch(() => {
        // A failed search caches empty so we don't hammer a broken endpoint;
        // the next distinct query still tries.
        cache.set(key, []);
      })
      .finally(() => {
        inFlight.delete(key);
        opts.onResults();
      });
  };

  return {
    results(query: string): PaletteConversationHit[] {
      const key = norm(query);
      if (key.length < MIN_QUERY_CHARS) return [];
      return cache.get(key) ?? [];
    },
    ensure(query: string): void {
      const key = norm(query);
      if (key.length < MIN_QUERY_CHARS) return;
      if (cache.has(key) || inFlight.has(key)) return;
      pendingQuery = key;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (pendingQuery) run(pendingQuery);
      }, debounceMs);
    },
    reset(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pendingQuery = undefined;
      cache.clear();
      inFlight.clear();
    },
  };
}
