#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { writeLedgerSection } from "../check-ledgers.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const BUDGET_REL = "tests/budgets.json";
const BUDGET_SECTION = "suiteWallClock";
const BUDGET_PATH = path.join(root, BUDGET_REL);
const VITEST_PATH = path.join(root, "artifacts/test-results/vitest.json");

export function measureWallClock(report) {
  if (!report || typeof report !== "object") return null;
  const results = /** @type {{ testResults?: unknown }} */ (report).testResults;
  if (!Array.isArray(results)) return null;
  let totalMs = 0;
  for (const file of results) {
    const entry = /** @type {Record<string, unknown>} */ (file ?? {});
    const start = Number(entry.startTime);
    const end = Number(entry.endTime);
    const explicit = Number((entry.perfStats ?? {}).runtime);
    if (Number.isFinite(explicit) && explicit >= 0) totalMs += explicit;
    else if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
      totalMs += end - start;
  }
  return { totalMs: Math.round(totalMs), files: results.length };
}

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
        : `suite-wall-clock: ${fmt(totalMs)} exceeds the ${fmt(budgetMs)} ceiling by ${fmt(-slackMs)}. Make the suite faster, or widen \`budgetMs\` in tests/budgets.json#suiteWallClock with an \`approvedDeviation\` saying what the extra time buys.`,
  };
}

const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;

if (process.argv[1] === import.meta.filename) {
  const budgets = JSON.parse(readFileSync(BUDGET_PATH, "utf8"))[BUDGET_SECTION];
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
    writeLedgerSection(BUDGET_REL, BUDGET_SECTION, budgets);
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
