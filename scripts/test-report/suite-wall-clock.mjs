#!/usr/bin/env node
/**
 * Suite wall-clock ratchet (#656 Layer 5).
 *
 * Every other gate in this repo pushes one way: add more tests, raise more
 * floors. Nothing pushed back, so the cheapest way for an agent to look
 * thorough was to flood the suite, and the bill arrived as PR latency that
 * nobody owned. This is the backpressure — the PR lane's total wall clock is a
 * tighten-only ceiling, exactly like a perf budget, so an agent adding tests
 * has to pay for them by making something else faster or by widening the
 * ceiling in a reviewed edit with a recorded reason.
 *
 * It measures the same artifact the health report reads
 * (`artifacts/test-results/vitest.json`). When that artifact is absent this
 * exits 0 with an explicit "not measured" line rather than passing silently:
 * a budget that cannot be measured must not read as a budget that was met.
 *
 * Usage:
 *   node scripts/test-report/suite-wall-clock.mjs           # enforce
 *   node scripts/test-report/suite-wall-clock.mjs --write   # ratchet DOWN only
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const BUDGET_PATH = path.join(root, "tests/suite-wall-clock.json");
const VITEST_PATH = path.join(root, "artifacts/test-results/vitest.json");

/**
 * Total wall clock of a vitest JSON report, in milliseconds.
 *
 * Sums per-file durations rather than reading the run's own elapsed time,
 * because elapsed time includes worker startup and varies with host load and
 * `--concurrency`; the sum of file durations is the work the suite actually
 * asked for, which is the thing an added test increases.
 *
 * @param {unknown} report Parsed vitest JSON report.
 * @returns {{ totalMs: number, files: number } | null} Null when unreadable.
 */
export function measureWallClock(report) {
  if (!report || typeof report !== "object") return null;
  const results = /** @type {{ testResults?: unknown }} */ (report).testResults;
  if (!Array.isArray(results)) return null;
  let totalMs = 0;
  for (const file of results) {
    const entry = /** @type {Record<string, unknown>} */ (file ?? {});
    const start = Number(entry.startTime);
    const end = Number(entry.endTime);
    const explicit = Number(
      /** @type {Record<string, unknown>} */ (entry.perfStats ?? {}).runtime
    );
    if (Number.isFinite(explicit) && explicit >= 0) totalMs += explicit;
    else if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
      totalMs += end - start;
  }
  return { totalMs: Math.round(totalMs), files: results.length };
}

/**
 * Compare a measurement against the lane's ceiling.
 * @param {number} totalMs Measured total.
 * @param {{ budgetMs?: unknown }} lane Lane budget entry.
 * @returns {{ ok: boolean, message: string, slackMs: number }} Verdict.
 */
export function compareToBudget(totalMs, lane) {
  const budgetMs = Number(lane?.budgetMs);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0)
    return {
      ok: false,
      message: "suite-wall-clock: lane has no positive `budgetMs`",
      slackMs: 0,
    };
  const slackMs = budgetMs - totalMs;
  return {
    ok: totalMs <= budgetMs,
    slackMs,
    message:
      totalMs <= budgetMs
        ? `suite-wall-clock: ${fmt(totalMs)} of ${fmt(budgetMs)} (${fmt(slackMs)} slack)`
        : `suite-wall-clock: ${fmt(totalMs)} exceeds the ${fmt(budgetMs)} ceiling by ${fmt(-slackMs)}. Make the suite faster, or widen \`budgetMs\` in tests/suite-wall-clock.json with an \`approvedDeviation\` saying what the extra time buys.`,
  };
}

const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;

if (process.argv[1] === import.meta.filename) {
  const budgets = JSON.parse(readFileSync(BUDGET_PATH, "utf8"));
  const lane = budgets.lanes?.["pr-vitest"];
  if (!existsSync(VITEST_PATH)) {
    console.log(
      "suite-wall-clock: not measured (no artifacts/test-results/vitest.json — run `bun run coverage` or the full vitest lane first)"
    );
    process.exit(0);
  }
  const measured = measureWallClock(
    JSON.parse(readFileSync(VITEST_PATH, "utf8"))
  );
  if (!measured) {
    console.error("suite-wall-clock: vitest report is unreadable");
    process.exit(1);
  }
  if (process.argv.includes("--write")) {
    const current = Number(lane?.budgetMs);
    const next = Math.ceil((measured.totalMs * 1.15) / 1000) * 1000;
    if (Number.isFinite(current) && next >= current) {
      console.log(
        `suite-wall-clock: measured ${fmt(measured.totalMs)}; ceiling stays ${fmt(current)} (this ratchet only tightens)`
      );
      process.exit(0);
    }
    budgets.lanes["pr-vitest"].budgetMs = next;
    writeFileSync(BUDGET_PATH, `${JSON.stringify(budgets, null, 2)}\n`);
    console.log(
      `suite-wall-clock: tightened ceiling to ${fmt(next)} from a measured ${fmt(measured.totalMs)}`
    );
    process.exit(0);
  }
  const verdict = compareToBudget(measured.totalMs, lane);
  console[verdict.ok ? "log" : "error"](
    `${verdict.message} across ${measured.files} files`
  );
  process.exit(verdict.ok ? 0 : 1);
}
