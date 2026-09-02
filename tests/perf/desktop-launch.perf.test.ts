import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/perf/desktop-launch.perf.test.ts";

/**
 * Nightly gate for the REAL Electron launch (issue #659 R3b).
 *
 * The measurement happens in `apps/desktop/tests/e2e/launch-time.spec.ts` —
 * Electron cannot be launched from the vitest perf lane, which runs on a
 * headless ubuntu runner with no X display and no keyring — and is handed to
 * this lane as `nightly-evidence-desktop`, exactly the way the PWA waterfall
 * report reaches `pwa-waterfall.perf.test.ts`.
 *
 * `tests/perf/desktop-cold.perf.test.ts` stays: it is a continuous,
 * CI-runnable floor on the desktop main module graph. It is NOT a launch, its
 * own comment says so, and its 3,000 ms ceiling must never be transplanted
 * here — the two numbers measure different things and the honest gap between
 * them is the point of this file.
 *
 * NO ABSOLUTE CEILING BY DESIGN. A cold Electron launch on a shared CI runner
 * has no distribution yet; the gate is the trailing-median drift budget every
 * other rig now uses (30 samples, 1.5x — tests/budgets.json#qualityRigs). An
 * absolute ceiling lands in tests/experience-budgets/desktop.json once ~10
 * green nightlies justify one, and not before.
 *
 * Year-3 declared volume: NONE — the launch is measured against the mock
 * gateway with a one-app fixture and a fresh userData, i.e. an EMPTY vault.
 * See the header of launch-time.spec.ts.
 */
const input = "artifacts/perf-input/desktop-launch-report.json";

/**
 * The owner-facing ceilings live in tests/experience-budgets/desktop.json and
 * are asserted HERE. A budget file nobody reads is the failure #659 R4 exists
 * to close, so this rig consumes both gates: the absolute ceiling (measured
 * 2026-07-31 + headroom) and the sustained-drift budget.
 */
const budgets = JSON.parse(
  await readFile("tests/experience-budgets/desktop.json", "utf8")
) as {
  metrics: {
    coldOpenToUsable: { ceilingMs: number };
    tapToVisualResponse: { ceilingMs: number };
  };
};

interface LaunchReport {
  volume: string;
  measurements: {
    processToFirstWindowMs: number;
    firstWindowToHomeMs: number;
    coldOpenToUsableMs: number;
    tapToVisualResponseMs: number;
  };
}

const report = await readFile(input, "utf8").then(
  (raw) => JSON.parse(raw) as LaunchReport,
  () => undefined
);

// Missing locally is expected (the desktop e2e job produces it). Missing in CI
// means this gate silently guarded nothing — the exact defect the #656 reorg
// closed for the PWA report, and the same rule applies here.
if (process.env.CI && !report) {
  throw new Error(
    `${OWNER}: missing ${input}. The nightly desktop-e2e job must publish the ` +
      `Electron launch report before the perf lane runs; a missing artifact is ` +
      `a hard failure in CI (it would otherwise gate nothing).`
  );
}

describe("desktop-launch.perf", () => {
  test.skipIf(!report)(
    "a real Electron cold launch stays within its sustained-drift budget",
    async () => {
      const { measurements, volume } = report!;
      const drift = await rigDriftBudgetMs("perf", OWNER);
      const withinDrift =
        drift === null || measurements.coldOpenToUsableMs <= drift;
      const coldCeiling = budgets.metrics.coldOpenToUsable.ceilingMs;
      const tapCeiling = budgets.metrics.tapToVisualResponse.ceilingMs;
      const withinCeilings =
        measurements.coldOpenToUsableMs <= coldCeiling &&
        measurements.tapToVisualResponseMs <= tapCeiling;
      await recordQualityResult({
        lane: "perf",
        owner: OWNER,
        name: `Desktop cold launch to a usable Home (volume: ${volume})`,
        status: withinDrift && withinCeilings ? "passed" : "failed",
        measurements: [
          {
            name: "cold open to usable",
            value: measurements.coldOpenToUsableMs,
            unit: "ms",
            budget: drift === null ? coldCeiling : Math.min(drift, coldCeiling),
          },
          {
            name: "process to first window",
            value: measurements.processToFirstWindowMs,
            unit: "ms",
          },
          {
            name: "first window to Home",
            value: measurements.firstWindowToHomeMs,
            unit: "ms",
          },
          {
            name: "tap to visual response",
            value: measurements.tapToVisualResponseMs,
            unit: "ms",
            budget: tapCeiling,
          },
        ],
      });
      expect(
        measurements.coldOpenToUsableMs,
        "cold open to a usable Home"
      ).toBeLessThanOrEqual(coldCeiling);
      expect(
        measurements.tapToVisualResponseMs,
        "tap to visual response"
      ).toBeLessThanOrEqual(tapCeiling);
      expect(
        withinDrift,
        `sustained drift: ${measurements.coldOpenToUsableMs} ms vs drift budget ${drift} ms (1.5x the trailing median of the last 30 nightly samples)`
      ).toBe(true);
    }
  );
});
