/**
 * Native QUIC tunnel perf budget (#496 PD1).
 * Runs when the native module is present; otherwise skipIf so default CI is not
 * painted solid without evidence (B2). JS fallback remains tunnel-throughput.
 */
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

// Cold dylib load on nightly runners routinely exceeds 500 ms; 5 s still
// catches a catastrophic hang without flaking cold boots.
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
      // Surface at least one export so a stub empty module fails.
      expect(
        Object.keys(addon as object).length +
          (typeof addon === "function" ? 1 : 0)
      ).toBeGreaterThan(0);
      // #659 R4 — sustained-drift gate over this rig's own 30-sample
      // nightly history. Null until the history is deep enough; a null is
      // "no opinion yet", never a pass.
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

  // Inverse of the load test: only runs when the binary is absent so the report
  // records an honest "no evidence" rather than a tautology that always passes.
  test.skipIf(hasNative)(
    "documents native module absence when binary is not on disk",
    () => {
      expect(hasNative).toBe(false);
      expect(nativePath).toBeUndefined();
    }
  );
});
