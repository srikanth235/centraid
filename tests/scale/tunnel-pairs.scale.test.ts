import path from "node:path";

import {
  qualityRegressionBudget,
  recordQualityResult,
} from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { DeviceStore } from "@centraid/tunnel";
import { describe, expect, test } from "vitest";

const OWNER = "tests/scale/tunnel-pairs.scale.test.ts";
const PAIRS = 200;

describe("tunnel-pairs.scale", () => {
  test("persists and resolves a multi-pair allowlist", async () => {
    const directory = await tempDir("tunnel-pairs-scale-");
    const store = DeviceStore.open(path.join(directory, "devices.json"));
    const started = performance.now();
    for (let index = 0; index < PAIRS; index += 1) {
      store.add({
        name: `Phone ${index}`,
        platform: "mobile",
        endpointId: index.toString(16).padStart(64, "0"),
      });
    }
    const durationMs = performance.now() - started;
    const budget = await qualityRegressionBudget("scale", OWNER);
    const passed = budget == null || durationMs < budget;
    expect(store.list()).toHaveLength(PAIRS);
    expect(
      store.findByEndpointId((PAIRS - 1).toString(16).padStart(64, "0"))
    ).toBeDefined();
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `${PAIRS} paired-device fan-out`,
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
          ...(budget == null ? {} : { budget }),
        },
        { name: "pairs", value: PAIRS, unit: "count" },
      ],
    });
    expect(passed).toBe(true);
  });
});
