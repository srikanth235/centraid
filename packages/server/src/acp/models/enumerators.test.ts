import { describe, expect, it } from "vitest";

import type { HarnessKind } from "@centraid/server/engine";

import { enumerateHarnessModels } from "./enumerators.js";

describe(enumerateHarnessModels, () => {
  it("returns [] for a harness kind with no enumerator", async () => {
    const models = await enumerateHarnessModels({
      kind: "unknown" as HarnessKind,
    });
    expect(models).toStrictEqual([]);
  });
});
