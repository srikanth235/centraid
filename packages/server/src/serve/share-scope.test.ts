/*
 * The scope a durable access receipt is written from is PARSED, not cast
 * (#750 abstraction 5). A `JSON.parse(scope_json) as string[]` cast turns
 * every malformed row into a silently empty audit record — the one failure a
 * receipt exists to prevent.
 */

import { describe, expect, test } from "vitest";

import {
  parseEdgeScope,
  parseTargetItemIds,
  ShareScopeError,
  validateItemIds,
} from "./share-scope.js";

describe(parseEdgeScope, () => {
  test("accepts a snapshot scope and de-duplicates it in first-seen order", () => {
    expect(
      parseEdgeScope("snapshot", JSON.stringify(["b", "a", "b"]))
    ).toStrictEqual({ mode: "snapshot", itemIds: ["b", "a"] });
  });

  test.each([
    ["a null scope", null],
    ["invalid JSON", "{not json"],
    ["an empty set", "[]"],
    ["a non-array", '{"itemIds":["a"]}'],
    ["a non-string member", '["a",7]'],
    ["an empty-string member", '["a",""]'],
  ])("refuses %s loudly", (_label, scopeJson) => {
    expect(() => parseEdgeScope("snapshot", scopeJson)).toThrow(
      ShareScopeError
    );
  });

  test("refuses a live scope — the mode was removed in #731, not hidden", () => {
    expect(() => parseEdgeScope("live", '["a"]')).toThrow(/#731/u);
  });
});

describe("validateItemIds — the wire door uses the same definition", () => {
  test("accepts a non-empty list of item ids", () => {
    expect(validateItemIds(["a", "a", "c"])).toStrictEqual(["a", "c"]);
  });

  test.each([[undefined], [[]], ["a"], [[""]], [[1]]])(
    "refuses %s",
    (value) => {
      expect(() => validateItemIds(value)).toThrow(ShareScopeError);
    }
  );
});

describe(parseTargetItemIds, () => {
  test("an unexecuted edge has no audience ids yet", () => {
    expect(parseTargetItemIds(null)).toStrictEqual([]);
  });

  test("refuses a malformed audience list rather than degrading it", () => {
    expect(() => parseTargetItemIds('["a",null]')).toThrow(ShareScopeError);
    expect(() => parseTargetItemIds("7")).toThrow(ShareScopeError);
  });
});
