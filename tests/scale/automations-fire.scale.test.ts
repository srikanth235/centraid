import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { computeMissedWindows } from "../../packages/server/src/automation/fire/scheduler-ledger.js";
import { rigBudgetMs, rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/scale/automations-fire.scale.test.ts";
const AUTOMATION_COUNT = 200;
const BUDGET_MS = rigBudgetMs(OWNER);

describe("automations-fire.scale", () => {
  test("computeMissedWindows at volume: one entry per automation, no backfill storm", async () => {
    const lastTickAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date("2026-01-01T06:00:00.000Z");
    const entries = Array.from({ length: AUTOMATION_COUNT }, (_, i) => ({
      ref: `auto-${i}`,
      crons: ["*/15 * * * *"] as const,
    }));

    const started = performance.now();
    const missed = computeMissedWindows({ lastTickAt, now, entries });
    const durationMs = performance.now() - started;

    expect(missed).toHaveLength(AUTOMATION_COUNT);
    const seen = new Set<string>();
    const gapStart = lastTickAt.getTime();
    const gapEnd = now.getTime();
    for (const entry of missed) {
      expect(entry.reason).toBe("gateway-down");
      expect(entry.automationRef.startsWith("auto-")).toBe(true);
      expect(seen.has(entry.automationRef)).toBe(false);
      seen.add(entry.automationRef);
      const at = Date.parse(entry.scheduledFor);
      expect(at).toBeGreaterThan(gapStart);
      expect(at).toBeLessThan(gapEnd);
    }
    expect(missed).toHaveLength(AUTOMATION_COUNT);
    expect(missed.length).toBeLessThan(360 * AUTOMATION_COUNT);

    const drift = await rigDriftBudgetMs("scale", OWNER);
    const passed = durationMs < BUDGET_MS && missed.length === AUTOMATION_COUNT;
    const withinDrift = drift === null || durationMs <= drift;
    await recordQualityResult({
      lane: "scale",
      owner: OWNER,
      name: `Automations missed-window scan (${AUTOMATION_COUNT} autos, 6h gap, hourly cron)`,
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
          budget: BUDGET_MS,
        },
        { name: "missed entries", value: missed.length, unit: "count" },
      ],
    });
    expect(
      withinDrift,
      `sustained drift: ${durationMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(durationMs).toBeLessThan(BUDGET_MS);
  });
});
