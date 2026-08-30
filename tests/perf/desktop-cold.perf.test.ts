import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

/**
 * Desktop cold-path budget (#496 PD3, re-instrumented in #883 C1).
 *
 * WHAT THIS OWNS. The measured desktop cold start on the record is 4.54 s, and
 * 4.49 s of it is main-process boot before any window exists
 * (`apps/desktop/tests/e2e/launch-time.spec.ts`, 2026-07-31). The dominant
 * controllable term inside that is the main process's IMPORT GRAPH. This rig
 * is the continuous, CI-runnable gate on that term.
 *
 * WHAT IT REPLACED, AND WHY. Until #883 this rig imported
 * `apps/desktop/src/main/gateway-supervisor-core.ts` — a file with ZERO
 * imports. It timed one module parse (~64 ms) and called the result "desktop
 * cold". A rig that cannot move when the graph it claims to measure doubles is
 * not a gate; it is a green light. The probe imports the real `local-gateway`
 * graph in a fresh child process, with `electron` stubbed (see the fixture's
 * header).
 *
 * WHAT #883 C5 THEN MOVED. C1 measured this graph at 1,001-1,003 modules and
 * 752-1,105 ms, because three main-process modules reached for the whole
 * `@centraid/server` BARREL (900 modules on its own): `gateway-paths.ts` for
 * one pure path resolver, `detached-gateway.ts` for one HMAC helper, and
 * `embedded-gateway.ts` for `serve()`. C5 pointed the first two at narrow
 * `@centraid/server` subpath exports and made `embedded-gateway.js` a DYNAMIC
 * import inside `startEmbedded` — the only caller, and one a production launch
 * never takes (`CENTRAID_EMBEDDED_GATEWAY=1` selects it, for tests). The graph
 * is now ~430 modules / ~400 ms on a quiet host, and the main entry's whole
 * direct dependency set fell from 1,034 modules / 815 ms to 461 / 365 ms. What is LEFT is
 * dominated by the `@centraid/vault` barrel (296 modules), which
 * `gateway-secrets.ts` needs for `KeyStore`; narrowing that wants vault
 * subpath exports and is the next cut available here.
 *
 * WHAT IT STILL DOES NOT MEASURE. Electron's own runtime start, V8 snapshot
 * restore, and window creation. Full cold start remains the nightly Playwright
 * `_electron.launch` spec; this owns the matrix cell with a continuous floor.
 */
import { recordQualityResult } from "@centraid/test-kit/quality-result";

import { rigBudgetMs, rigDriftBudgetMs } from "../helpers/rig-budgets.js";

const OWNER = "tests/perf/desktop-cold.perf.test.ts";
const BUDGET_MS = rigBudgetMs(OWNER);

const execFileAsync = promisify(execFile);

/**
 * The BUILT main modules, not the TypeScript sources: the desktop ships
 * `dist/main.js`, and importing the sources would additionally time a
 * transpiler that never runs on a vault owner's machine.
 */
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

/**
 * A module count is the honest cross-host number here: it is exactly what
 * de-barreling (#883 C5) moved, and unlike wall clock it does not vary with
 * runner contention. The ceiling is a catastrophe bound over the measured 430-431
 * — a graph that grew past 650 modules has taken a barrel back onto the
 * critical path, not drifted. Ratcheted down from 1,500 when C5 landed.
 */
const MAX_MODULES = 650;

describe("desktop-cold.perf", () => {
  test("the desktop main-process import graph stays under budget", async () => {
    const entryPath = path.resolve(ENTRY);
    // A missing build is a broken rig, not a pass: `bun run build` produces
    // apps/desktop/dist, and the nightly perf lane runs after it.
    expect(
      existsSync(entryPath),
      `${ENTRY} is missing — run \`bun run build\` (or \`turbo run build --filter=@centraid/desktop\`) before the perf lane`
    ).toBe(true);

    // A FRESH process per run: an in-vitest dynamic import would measure a
    // module cache that the rest of the perf lane has already warmed.
    const { stdout } = await execFileAsync(
      process.execPath,
      [FIXTURE, entryPath],
      { cwd: path.resolve(import.meta.dirname, "../.."), timeout: 120_000 }
    );
    const line = stdout.trim().split("\n").at(-1) ?? "";
    const report = JSON.parse(line) as GraphReport;
    const durationMs = report.importMs;

    // Anti-vacuity: the graph really evaluated and really is the big one.
    expect(report.exportCount).toBeGreaterThan(0);
    // 250, not 100: the `@centraid/vault` KeyStore graph alone is 296 modules,
    // so anything under this floor means the probe resolved a stub rather than
    // the real main-process graph.
    expect(
      report.modulesLoaded,
      "modules pulled in by the desktop main-process graph"
    ).toBeGreaterThan(250);

    // #659 R4 — sustained-drift gate over this rig's own 30-sample
    // nightly history. Null until the history is deep enough; a null is
    // "no opinion yet", never a pass.
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
