import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { runFire } from "@centraid/automation";
import type { OpenDispatch } from "@centraid/automation";
import {
  qualityRegressionBudget,
  recordQualityResult,
} from "@centraid/test-kit/quality-result";
import { tempDir } from "@centraid/test-kit/temp-dir";

const OWNER = "tests/perf/automation-fire.perf.test.ts";
const FIRES = 10;

describe("automation-fire.perf", () => {
  test("fires a real no-agent automation through its ledger", async () => {
    const appsDir = await tempDir("automation-fire-perf-");
    const automationDir = path.join(appsDir, "notes", "automations", "digest");
    await mkdir(automationDir, { recursive: true });
    await writeFile(
      path.join(automationDir, "automation.json"),
      JSON.stringify({
        name: "Digest",
        version: "0.1.0",
        enabled: true,
        prompt: "digest",
        triggers: [{ kind: "cron", expr: "0 9 * * *" }],
        requires: {},
        history: { keep: { count: 100 } },
        generated: { by: "perf", at: "2026-07-29" },
      })
    );
    await writeFile(
      path.join(automationDir, "handler.js"),
      "export default async () => ({ ok: true });"
    );
    const openDispatch: OpenDispatch = async () => ({
      delegateDispatcher: async () => "",
      close: async () => undefined,
    });
    const journalDbFile = path.join(appsDir, "journal.db");
    const started = performance.now();
    await Array.from({ length: FIRES }, (_, index) => index).reduce(
      async (previous, index) => {
        await previous;
        const { outcome } = await runFire(
          {
            automationRef: "notes/digest",
            appsDir,
            journalDbFile,
            runId: `perf-fire-${index}`,
          },
          { openDispatch }
        );
        expect(outcome.ok).toBe(true);
      },
      Promise.resolve()
    );
    const durationMs = performance.now() - started;
    const budget = await qualityRegressionBudget("perf", OWNER);
    const passed = budget == null || durationMs < budget;
    await recordQualityResult({
      lane: "perf",
      owner: OWNER,
      name: `${FIRES} automation fires`,
      status: passed ? "passed" : "failed",
      measurements: [
        {
          name: "wall clock",
          value: durationMs,
          unit: "ms",
          ...(budget == null ? {} : { budget }),
        },
        { name: "mean fire", value: durationMs / FIRES, unit: "ms" },
      ],
    });
    expect(passed).toBe(true);
  });
});
