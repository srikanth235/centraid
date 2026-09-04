#!/usr/bin/env node
/*
 * THE RUNG-0 DEVELOPER COMMAND (#927): `bun run perf:waterfall`.
 *
 * One command, on the developer's own machine, that opens each of the eight
 * bundled apps against the golden year-3 vault and prints what each one cost —
 * the span waterfall from the trace contract, the always-on work counters, and
 * the delta against the last baseline TAKEN ON THIS MACHINE.
 *
 * Why the baseline is machine-local. A number from a CI runner is not a number
 * about this laptop, and a developer asking "did my change make Photos slower"
 * is asking about the machine in front of them. `--save` writes the baseline;
 * every later run compares against it and prints the difference beside the
 * journey's own tolerance from `tests/journeys.json`. That is the same
 * comparison the candidate rung makes between two trees, done between two runs.
 *
 * It must stay under a minute for the in-process journeys, which is why it
 * mounts the golden artifact (built once, cached, then copied) rather than
 * seeding a vault per app, and why it makes ONE first-paint read per app rather
 * than driving a browser.
 *
 * The measuring half lives in `app-waterfall.run.ts` beside this file: the
 * golden fixture's generator is `@centraid/test-kit`, which ships TypeScript
 * sources and no build, so the driver runs under the repo's TypeScript runner.
 * Everything that can be tested without booting a gateway — the comparison, the
 * verdicts, the rendering — is here, and is.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { waterfall } from "@centraid/core/protocol";

import { journeyLedger } from "../lib/journey-ledger.mjs";

/** The eight bundled apps and the query each one paints first. */
export const FIRST_PAINT = Object.freeze([
  { app: "agenda", query: "upcoming" },
  { app: "docs", query: "drive" },
  { app: "locker", query: "autofill-candidates" },
  { app: "notes", query: "library" },
  { app: "people", query: "people" },
  { app: "photos", query: "library" },
  { app: "tally", query: "dashboard" },
  { app: "tasks", query: "board" },
]);

export const BASELINE = path.join(
  "artifacts",
  "perf",
  "waterfall-baseline.json"
);

/**
 * The tolerance this run reads for one app, from the ledger rather than from a
 * constant here: one place decides what a meaningful slow-down is.
 * @param {object} ledger Parsed ledger.
 * @returns {number} Percent.
 */
export function warmSwitchTolerance(ledger = journeyLedger()) {
  const entry = Object.values(ledger.entries ?? {}).find(
    (candidate) =>
      candidate.surface === "gateway" && candidate.journey === "warm-switch"
  );
  return entry?.tolerancePercent ?? 20;
}

/**
 * Compare this run against the machine's own baseline.
 * @param {Array<{ app: string, durationMs: number, statements: number }>} rows This run.
 * @param {{ rows?: Array<{ app: string, durationMs: number, statements: number }> }} baseline Saved run.
 * @param {number} tolerancePercent Meaningful move.
 * @returns {Array<object>} Rows with a delta and a verdict.
 */
export function compareToBaseline(rows, baseline, tolerancePercent) {
  const prior = new Map((baseline?.rows ?? []).map((row) => [row.app, row]));
  return rows.map((row) => {
    const was = prior.get(row.app);
    if (!was) return { ...row, deltaMs: null, verdict: "new" };
    const deltaMs = row.durationMs - was.durationMs;
    const limit = (was.durationMs * tolerancePercent) / 100;
    return {
      ...row,
      deltaMs,
      deltaStatements: row.statements - was.statements,
      // A STATEMENT COUNT is deterministic, so any change in it is real and is
      // reported first; wall clock on a developer machine is not, so it needs
      // the tolerance before it is worth a word.
      verdict:
        row.statements === was.statements
          ? deltaMs > limit
            ? "slower"
            : deltaMs < -limit
              ? "faster"
              : "same"
          : "work changed",
    };
  });
}

/**
 * Render the per-app table and, under each app, its span waterfall.
 * @param {Array<object>} rows Compared rows.
 * @param {Map<string, object>} traces Trace record per app.
 * @returns {string} The report.
 */
export function renderWaterfall(rows, traces = new Map()) {
  const lines = [
    "app        first paint   statements   Δ vs baseline   verdict",
  ];
  for (const row of rows) {
    lines.push(
      `${row.app.padEnd(10)} ${`${row.durationMs.toFixed(1)}ms`.padStart(11)} ` +
        `${String(row.statements).padStart(12)}   ` +
        `${row.deltaMs === null ? "—" : `${row.deltaMs >= 0 ? "+" : ""}${row.deltaMs.toFixed(1)}ms`}`.padEnd(
          15
        ) +
        ` ${row.verdict}`
    );
    const record = traces.get(row.app);
    if (!record) continue;
    for (const span of waterfall(record))
      lines.push(
        `    ${"  ".repeat(span.depth)}${span.name.padEnd(34 - 2 * span.depth)} ` +
          `+${span.offsetMs.toFixed(1)}ms  ${span.durationMs.toFixed(1)}ms  ${span.hop}`
      );
  }
  return lines.join("\n");
}

/**
 * Read the machine's baseline, or nothing on the first run.
 * @param {string} [file] Baseline path.
 * @returns {object | null} The saved run.
 */
export function readBaseline(file = BASELINE) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write the machine's baseline.
 * @param {object} run This run.
 * @param {string} [file] Baseline path.
 */
export function saveBaseline(run, file = BASELINE) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
}
