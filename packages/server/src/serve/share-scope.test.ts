/*
 * Placement item ids are validated at the route boundary, not cast (#750).
 * Malformed input must fail loudly instead of becoming an empty audit record.
 */

import { describe, expect, test } from "vitest";

import { ShareScopeError, validateItemIds } from "./share-scope.js";

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
