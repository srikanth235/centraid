// THE GATEWAY'S HALF OF THE CANONICAL PAYLOAD (#1014, C20).
//
// `expectedPayloadHash` hashes `baseVersions` in the order `parseBaseVersions`
// produced, and the seat hashes them in the order
// `packages/client/src/replica/payload-hash.ts` produced. The two orders are
// the contract: a divergence is a `replica_intent_hash_mismatch` on a
// well-formed write, and the digest below is the same fixture the client test
// pins, so a change on either side fails on both.

import { describe, expect, test } from "vitest";

import {
  expectedPayloadHash,
  parseBaseVersions,
} from "./replica-intent-shape.js";

describe("base version ordering in the canonical payload", () => {
  test("sorts by code point, not by locale", () => {
    // The divergence itself: ICU collation puts "a" before "B".
    expect("a".localeCompare("B")).toBeLessThan(0);
    const parsed = parseBaseVersions([
      { entity: "media.asset", rowId: "a1", version: 2 },
      { entity: "media.asset", rowId: "B1", version: 5 },
    ]);
    expect(parsed.map((base) => base.rowId)).toStrictEqual(["B1", "a1"]);
  });

  test("pins the digest the seat computes for the same payload", () => {
    const parsed = parseBaseVersions([
      { entity: "media.asset", rowId: "a1", version: 2 },
      { entity: "media.asset", rowId: "B1", version: 5 },
    ]);
    expect(
      expectedPayloadHash("photos", "update-asset", { asset_id: "a1" }, parsed)
    ).toBe("6984dd9170404c63cc70a4f109ef8cd713bcbff03800158992e5fd072f601f9e");
  });
});
