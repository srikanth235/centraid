import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * Desktop cold-path budget (#496 PD3).
 * Crude first-import proxy for desktop main modules (not full Electron launch).
 * Full Electron cold-start remains nightly Playwright; this owns the matrix cell
 * with a continuous, CI-runnable floor.
 */
import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { rigBudgetMs, rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/perf/desktop-cold.perf.test.ts";
const BUDGET_MS = rigBudgetMs(OWNER);

describe("desktop-cold.perf", () => {
  test("desktop gateway-supervisor-core first import stays under budget", async () => {
    const started = performance.now();
    const modPath = path.resolve(
      "apps/desktop/src/main/gateway-supervisor-core.ts"
    );
    // Dynamic import of the pure core (no Electron). Timing is host-sensitive;
    // budget is a catastrophic-failure floor, not a tight CI gate.
    const url = pathToFileURL(modPath).href;
    const mod = await import(url);
    const durationMs = performance.now() - started;
    expect(mod).toBeTruthy();
    // #659 R4 — sustained-drift gate over this rig's own 30-sample
    // nightly history. Null until the history is deep enough; a null is
    // "no opinion yet", never a pass.
    const drift = await rigDriftBudgetMs("perf", OWNER);
    const passed = durationMs < BUDGET_MS;
    const withinDrift = drift === null || durationMs <= drift;
    await recordQualityResult({
      lane: "perf",
      owner: OWNER,
      name: "Desktop cold module import",
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "import wall clock",
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
  });
});
