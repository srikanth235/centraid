import { describe, expect, test } from "vitest";

import { parseShareScope } from "./share-contracts.js";

describe(parseShareScope, () => {
  test("snapshot item ids are strings and live scopes are named objects", () => {
    expect(parseShareScope("snapshot", ["item-a", "item-b"])).toStrictEqual({
      mode: "snapshot",
      itemIds: ["item-a", "item-b"],
    });
    expect(() => parseShareScope("snapshot", ["item-a", {}])).toThrow(
      /item ids/u
    );
    expect(
      parseShareScope("live", {
        containerType: "core.collection",
        containerId: "collection-a",
      })
    ).toStrictEqual({
      mode: "live",
      containerType: "core.collection",
      containerId: "collection-a",
    });
    expect(() => parseShareScope("live", ["collection-a"])).toThrow(
      /must be an object/u
    );
  });
});
