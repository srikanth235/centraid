import { describe, expect, test } from "vitest";

import { MobileIntentIds } from "./mobile-intent-id";

describe("mobile intent ids", () => {
  test("coalesces a double-tap even when object key insertion order differs", () => {
    let serial = 0;
    let now = 1_000;
    const ids = new MobileIntentIds(
      () => `intent-${++serial}`,
      () => now
    );
    expect(
      ids.forWrite("docs", "create-folder", { name: "Trips", parent: null })
    ).toBe("intent-1");
    expect(
      ids.forWrite("docs", "create-folder", { parent: null, name: "Trips" })
    ).toBe("intent-1");
    now += 2_001;
    expect(
      ids.forWrite("docs", "create-folder", { name: "Trips", parent: null })
    ).toBe("intent-2");
  });

  test("preserves a caller-provided cross-restart intent id", () => {
    const ids = new MobileIntentIds(() => "generated");
    expect(
      ids.forWrite("photos", "upload", { sha256: "abc" }, "durable-upload")
    ).toBe("durable-upload");
  });
});
