import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { rigBudgetMs, rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/perf/tunnel-native.perf.test.ts";
const nativeCandidates = [
  "packages/tunnel/native/centraid-tunnel-native.linux-x64.node",
  "packages/tunnel/native/centraid-tunnel-native.linux-arm64.node",
  "packages/tunnel/native/centraid-tunnel-native.darwin-arm64.node",
  "packages/tunnel/native/centraid-tunnel-native.darwin-x64.node",
  "packages/tunnel/native/centraid-tunnel-native.win32-x64.node",
  "packages/tunnel/native/centraid-tunnel-native.win32-arm64.node",
];
const nativePath = nativeCandidates.find((p) => existsSync(path.resolve(p)));
const hasNative = Boolean(nativePath);

const BUDGET_MS = rigBudgetMs(OWNER);

describe("tunnel-native.perf", () => {
  test.skipIf(!hasNative)(
    "native tunnel module loads and exports within budget",
    async () => {
      const started = performance.now();
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const addon = require(path.resolve(nativePath!));
      const durationMs = performance.now() - started;
      expect(addon).toBeTruthy();
      expect(addon).toBeTypeOf("object");
      expect(
        Object.keys(addon as object).length +
          (typeof addon === "function" ? 1 : 0)
      ).toBeGreaterThan(0);
      const drift = await rigDriftBudgetMs("perf", OWNER);
      const passed = durationMs < BUDGET_MS;
      const withinDrift = drift === null || durationMs <= drift;
      await recordQualityResult({
        lane: "perf",
        owner: OWNER,
        name: "Native tunnel module load",
        status: passed && withinDrift ? "passed" : "failed",
        measurements: [
          {
            name: "load wall clock",
            value: durationMs,
            unit: "ms",
            budget: BUDGET_MS,
          },
        ],
      });
      expect(
        withinDrift,
        `sustained drift: ${durationMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
      ).toBe(true);
      expect(durationMs).toBeLessThan(BUDGET_MS);
    }
  );

  test.skipIf(hasNative)(
    "documents native module absence when binary is not on disk",
    () => {
      expect(hasNative).toBe(false);
      expect(nativePath).toBeUndefined();
    }
  );
});
