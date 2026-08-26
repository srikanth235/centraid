/*
 * Async FTS bridge for the synchronous ⌘K palette (#420): results() reads a
 * sync cache; ensure() debounces fetches into it and fires onResults().
 */

export interface PaletteConversationHit {
  id: string;
  title: string;
  snippet: string;
}

export interface PaletteConversationSearch {
  /** Cached hits for the trimmed query. */
  results: (query: string) => PaletteConversationHit[];
  ensure: (query: string) => void;
  reset: () => void;
  /** Rebind the "hits landed" callback; refresh() exists only post-mount. */
  setOnResults: (fn: (() => void) | null) => void;
}

export interface PaletteConversationSearchOptions {
  search: (query: string, limit?: number) => Promise<PaletteConversationHit[]>;
  onResults?: (() => void) | undefined;
  limit?: number;
  debounceMs?: number;
}

const MIN_QUERY_CHARS = 2;

export function createPaletteConversationSearch(
  opts: PaletteConversationSearchOptions
): PaletteConversationSearch {
  const cache = new Map<string, PaletteConversationHit[]>();
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingQuery: string | undefined;
  let onResults: (() => void) | null = opts.onResults ?? null;
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
        // Cache empty so a broken endpoint isn't hammered.
        cache.set(key, []);
      })
      .finally(() => {
        inFlight.delete(key);
        onResults?.();
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
    setOnResults(fn: (() => void) | null): void {
      onResults = fn;
    },
  };
}
