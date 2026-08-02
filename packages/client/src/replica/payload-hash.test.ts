import { describe, expect, test } from "vitest";

import { canonicalJson, intentPayloadHash } from "./payload-hash.js";

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
});
