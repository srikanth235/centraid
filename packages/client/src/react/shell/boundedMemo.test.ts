import { describe, expect, it, vi } from "vitest";

import { boundedMemo } from "./boundedMemo.js";

describe(boundedMemo, () => {
  it("computes once per distinct key", () => {
    const compute = vi.fn<(key: string) => string>((key) => `<p>${key}</p>`);
    const memo = boundedMemo(compute, 8);
    expect(memo("a")).toBe("<p>a</p>");
    expect(memo("a")).toBe("<p>a</p>");
    expect(memo("b")).toBe("<p>b</p>");
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("hands back the identical value object so callers can compare by reference", () => {
    const memo = boundedMemo((key: string) => ({ html: key }), 8);
    expect(memo("same")).toBe(memo("same"));
  });

  it("never retains more than its capacity", () => {
    const memo = boundedMemo((key: string) => key, 2);
    memo("a");
    memo("b");
    memo("c");
    expect(memo.size).toBe(2);
  });

  it("evicts the least recently USED entry, not the least recently inserted", () => {
    const compute = vi.fn<(key: string) => string>((key) => key);
    const memo = boundedMemo(compute, 2);
    memo("a");
    memo("b");
    memo("a"); // refreshes "a", so "b" is now the coldest
    memo("c");
    expect(compute).toHaveBeenCalledTimes(3);
    memo("a");
    expect(compute).toHaveBeenCalledTimes(3); // still cached
    memo("b");
    expect(compute).toHaveBeenCalledTimes(4); // was evicted
  });

  it("refuses a capacity that could not hold anything", () => {
    expect(() => boundedMemo((key: string) => key, 0)).toThrow(/capacity/u);
  });
});
