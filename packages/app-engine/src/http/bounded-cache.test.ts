// Issue #659 G9: the asset caches are keyed by content, so an unbounded map
// retained every superseded generation of every file for the process lifetime.

import { describe, expect, it } from "vitest";

import { jsxVariantCache, plainCache } from "./asset-variants.js";
import { BoundedCache } from "./bounded-cache.js";

describe(BoundedCache, () => {
  it("evicts the least recently used entry once the ceiling is passed", () => {
    const cache = new BoundedCache<string, number>(3);
    cache.set("a", 1).set("b", 2).set("c", 3);
    // Touching "a" makes "b" the oldest.
    expect(cache.get("a")).toBe(1);
    cache.set("d", 4);
    expect(cache.size).toBe(3);
    expect(cache.has("b")).toBe(false);
    expect([...cache.keys()]).toStrictEqual(["c", "a", "d"]);
  });

  it("never grows past the ceiling, however many fresh keys arrive", () => {
    const cache = new BoundedCache<string, number>(8);
    // Every save in a builder session is a brand-new content etag.
    for (let index = 0; index < 5_000; index++)
      cache.set(`etag-${index}`, index);
    expect(cache.size).toBe(8);
    expect(cache.get("etag-4999")).toBe(4999);
    expect(cache.has("etag-0")).toBe(false);
  });

  it("rejects a ceiling that would make the cache unbounded or empty", () => {
    expect(() => new BoundedCache<string, number>(0)).toThrow(RangeError);
    expect(() => new BoundedCache<string, number>(1.5)).toThrow(RangeError);
  });

  it("backs the shipped asset caches, so those are bounded too", () => {
    expect(plainCache).toBeInstanceOf(BoundedCache);
    expect(jsxVariantCache).toBeInstanceOf(BoundedCache);
  });
});
