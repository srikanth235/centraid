import { describe, expect, it } from "vitest";

import { structuralEqual } from "./structuralEqual.js";

describe(structuralEqual, () => {
  it("treats equal JSON-shaped values as equal regardless of identity", () => {
    expect(
      structuralEqual(
        { kind: "ai", calls: [{ tool: "vault_sql", rows: 3 }], feedback: null },
        { kind: "ai", calls: [{ tool: "vault_sql", rows: 3 }], feedback: null }
      )
    ).toBe(true);
  });

  it("notices a changed leaf anywhere in the tree", () => {
    expect(
      structuralEqual(
        { calls: [{ state: "run" }, { state: "ok" }] },
        { calls: [{ state: "run" }, { state: "error" }] }
      )
    ).toBe(false);
  });

  it("notices an added or removed key rather than only compared ones", () => {
    expect(structuralEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(structuralEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it("distinguishes an array from an object with numeric keys", () => {
    expect(structuralEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  it("distinguishes arrays of different length that share a prefix", () => {
    expect(structuralEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("separates null from an object and from undefined", () => {
    expect(structuralEqual(null, {})).toBe(false);
    expect(structuralEqual(null, undefined)).toBe(false);
    expect(structuralEqual(null, null)).toBe(true);
  });

  it("compares NaN as equal to itself so a numeric field never churns", () => {
    expect(structuralEqual({ n: Number.NaN }, { n: Number.NaN })).toBe(true);
  });
});
