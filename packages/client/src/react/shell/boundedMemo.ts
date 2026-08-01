// A bounded, string-keyed memo (issue #659). The transcript re-derives every
// finished answer's HTML on every streamed token, so the same markdown was
// re-parsed hundreds of times per turn. Memoizing the pure text→HTML step
// makes the re-derivation free AND makes the resulting string reference-stable,
// which is what lets `structuralEqual` short-circuit downstream.
//
// Bounded because a conversation is unbounded: an LRU with a cap keeps the
// cache proportional to what is on screen rather than to session length.

export interface BoundedMemo<T> {
  (key: string): T;
  /** Entries currently retained — the cap is a behaviour, so it is observable. */
  readonly size: number;
}

/**
 * Wrap a pure `key -> value` function in a least-recently-used cache holding at
 * most `capacity` entries. A hit refreshes the entry's recency; an insert past
 * the cap evicts the least recently used one.
 */
export function boundedMemo<T>(
  compute: (key: string) => T,
  capacity: number
): BoundedMemo<T> {
  if (capacity < 1) throw new Error("boundedMemo capacity must be at least 1");
  const cache = new Map<string, T>();
  const memo = (key: string): T => {
    if (cache.has(key)) {
      const hit = cache.get(key) as T;
      // Re-insert so Map iteration order stays least-recently-used first.
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const value = compute(key);
    cache.set(key, value);
    if (cache.size > capacity) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    return value;
  };
  Object.defineProperty(memo, "size", { get: () => cache.size });
  return memo as BoundedMemo<T>;
}
