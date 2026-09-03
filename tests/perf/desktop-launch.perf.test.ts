import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/perf/desktop-launch.perf.test.ts";

const input = "artifacts/perf-input/desktop-launch-report.json";

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
