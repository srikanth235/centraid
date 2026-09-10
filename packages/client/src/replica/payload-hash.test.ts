import { describe, expect, test } from "vitest";

import {
  baseVersionSortKey,
  canonicalJson,
  compareBaseVersionKeys,
  intentPayloadHash,
} from "./payload-hash.js";

describe("intent payload hash", () => {
  test("canonicalJson preserves array boundaries and sorts nested object keys", () => {
    expect(canonicalJson(["first", { zulu: 1, alpha: true }])).toBe(
      '["first",{"alpha":true,"zulu":1}]'
    );
  });

  test("is stable across object key insertion order and changes with payload", async () => {
    const first = await intentPayloadHash({
      appId: "agenda",
      action: "create",
      input: { title: "Meeting", attendees: ["a", "b"] },
    });
    const reordered = await intentPayloadHash({
      appId: "agenda",
      action: "create",
      input: { attendees: ["a", "b"], title: "Meeting" },
    });
    const changed = await intentPayloadHash({
      appId: "agenda",
      action: "create",
      input: { attendees: ["a"], title: "Meeting" },
    });
    expect(first).toBe(reordered);
    expect(first).not.toBe(changed);
  });
  // #1014 C20: `localeCompare` is the runtime's ICU collation — it puts "a"
  // before "B", while code points put "B" first. The seat and the gateway hash
  // the SAME array or every intent is refused as a hash mismatch, so the order
  // and the digest are pinned here and in
  // `packages/server/src/routes/replica-intent-shape.test.ts`.
  test("base versions sort by code point, not by locale, and pin a digest", async () => {
    expect("a".localeCompare("B")).toBeLessThan(0);
    const hashed = await intentPayloadHash({
      appId: "photos",
      action: "update-asset",
      input: { asset_id: "a1" },
      baseVersions: [
        { entity: "media.asset", rowId: "a1", version: 2 },
        { entity: "media.asset", rowId: "B1", version: 5 },
      ],
    });
    expect(hashed).toBe(
      "6984dd9170404c63cc70a4f109ef8cd713bcbff03800158992e5fd072f601f9e"
    );
  });

  test("the sort key comparator orders by UTF-16 code unit", () => {
    expect(
      compareBaseVersionKeys(
        baseVersionSortKey({ entity: "media.asset", rowId: "a1" }),
        baseVersionSortKey({ entity: "media.asset", rowId: "B1" })
      )
    ).toBe(1);
  });
});
