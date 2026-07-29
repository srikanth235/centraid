import { describe, expect, test } from "vitest";

import { selectBackgroundScopes } from "./background-scopes";

describe("background replica scope selection", () => {
  test("keeps the focused vault when cached order puts it after the cap", () => {
    expect(
      selectBackgroundScopes(
        ["one", "two", "three", "four", "focused"].map((vaultId) => ({
          vaultId,
        })),
        "focused"
      ).map((scope) => scope.vaultId)
    ).toStrictEqual(["focused", "one", "two", "three"]);
  });
});
