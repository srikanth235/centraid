export interface PaletteConversationHit {
  id: string;
  title: string;
  snippet: string;
}

export interface PaletteConversationSearch {
  results: (query: string) => PaletteConversationHit[];
  ensure: (query: string) => void;
  reset: () => void;
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
