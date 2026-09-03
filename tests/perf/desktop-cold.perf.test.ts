import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { rigBudgetMs, rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/perf/desktop-cold.perf.test.ts";
const BUDGET_MS = rigBudgetMs(OWNER);

const execFileAsync = promisify(execFile);

const ENTRY = "apps/desktop/dist/main/local-gateway.js";
const FIXTURE = path.resolve(
  import.meta.dirname,
  "fixtures/desktop-main-graph.mjs"
);

interface GraphReport {
  entry: string;
  importMs: number;
  modulesLoaded: number;
  exportCount: number;
  heapUsedBytes: number;
}

const MAX_MODULES = 650;

describe("desktop-cold.perf", () => {
  test("the desktop main-process import graph stays under budget", async () => {
    const entryPath = path.resolve(ENTRY);
    expect(
      existsSync(entryPath),
      `${ENTRY} is missing — run \`bun run build\` (or \`turbo run build --filter=@centraid/desktop\`) before the perf lane`
    ).toBe(true);

    const { stdout } = await execFileAsync(
      process.execPath,
      [FIXTURE, entryPath],
      { cwd: path.resolve(import.meta.dirname, "../.."), timeout: 120_000 }
    );
    const line = stdout.trim().split("\n").at(-1) ?? "";
    const report = JSON.parse(line) as GraphReport;
    const durationMs = report.importMs;

    expect(report.exportCount).toBeGreaterThan(0);
    expect(
      report.modulesLoaded,
      "modules pulled in by the desktop main-process graph"
    ).toBeGreaterThan(250);

    const drift = await rigDriftBudgetMs("perf", OWNER);
    const passed =
      durationMs < BUDGET_MS && report.modulesLoaded <= MAX_MODULES;
    const withinDrift = drift === null || durationMs <= drift;
    await recordQualityResult({
      lane: "perf",
      owner: OWNER,
      name: "Desktop main-process import graph",
      status: passed && withinDrift ? "passed" : "failed",
      measurements: [
        {
          name: "import wall clock",
          value: durationMs,
          unit: "ms",
          budget: BUDGET_MS,
        },
        {
          name: "modules loaded",
          value: report.modulesLoaded,
          unit: "modules",
          budget: MAX_MODULES,
        },
        {
          name: "heap after import",
          value: report.heapUsedBytes,
          unit: "bytes",
        },
      ],
    });
    console.log(
      `desktop main-process import graph: ${durationMs.toFixed(1)} ms, ` +
        `${report.modulesLoaded} modules, ` +
        `${(report.heapUsedBytes / 1024 / 1024).toFixed(1)} MiB heap`
    );
    expect(
      withinDrift,
      `sustained drift: ${durationMs} vs drift budget ${drift} (1.5x the trailing median of the last 30 nightly samples)`
    ).toBe(true);
    expect(
      report.modulesLoaded,
      "modules in the desktop main-process import graph"
    ).toBeLessThanOrEqual(MAX_MODULES);
    expect(durationMs).toBeLessThan(BUDGET_MS);
  });
});
