/*
 * A least-recently-used map for the asset caches (issue #659 G9).
 *
 * The static-asset caches are keyed by CONTENT etag, so every builder save
 * mints a fresh key and the previous generation's raw bytes plus its brotli and
 * gzip variants are retained forever. A long builder session is therefore a
 * monotonic memory leak whose rate is the user's save cadence — and the target
 * hardware is a small always-on box.
 *
 * The bound is on entry count rather than bytes because entries here are
 * mutated after insertion (a variant map gains encodings as clients ask for
 * them), so a byte total maintained at insertion time would drift. Count is a
 * bound the code can actually keep honest; per-asset size is bounded separately
 * by what the gateway is willing to compress at all.
 */

/** A Map with an entry ceiling, evicting the least recently used on overflow. */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("BoundedCache needs a positive integer ceiling");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Reading marks the entry most-recently-used. */
  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Map iterates in insertion order, so re-inserting moves it to the back.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  set(key: K, value: V): this {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  keys(): IterableIterator<K> {
    return this.entries.keys();
  }
}
