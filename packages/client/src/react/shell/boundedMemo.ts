export interface BoundedMemo<T> {
  (key: string): T;
  readonly size: number;
}

export function boundedMemo<T>(
  compute: (key: string) => T,
  capacity: number
): BoundedMemo<T> {
  if (capacity < 1) throw new Error("boundedMemo capacity must be at least 1");
  const cache = new Map<string, T>();
  const memo = (key: string): T => {
    if (cache.has(key)) {
      const hit = cache.get(key) as T;
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
