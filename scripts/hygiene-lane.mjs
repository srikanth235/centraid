#!/usr/bin/env node
// The rung-5 hygiene lane (#915 Wave 4).
//
// Seven gates are tighten-only ratchets over the TEST SUITE's own quality —
// comment density, assertion-matcher families, fixed sleeps, skips,
// environment-red sites, the type floor and the schema/export fingerprint.
// They protect the suite from the agents; none of them can prove the phone
// works. Charging every push for them bought latency nobody used.
//
// Every one of them is a STANDING check over the whole tree — a count, an
// inventory, a fingerprint — not a diff-scoped one. That is the property that
// makes a weekly run on `main` see exactly what a per-push run would see, and
// it is why this move costs detection latency (push → ≤ 7 days) and nothing
// else. `test:comment-density` in particular had no CI job at all before this,
// so weekly is strictly more enforcement than it had.
//
// This is deliberately NOT the "enforced by the pre-push hook is enforcement
// in name only" regression the #782 comment block in ci.yml warns about: this
// lane runs in CI, against main, on a schedule, and files a rolling issue when
// it is red. Nothing depends on a developer's hook. See docs/decisions.md
// "Gate and ledger diet".
//
// Writes `artifacts/hygiene/summary.json` so the workflow can render a job
// summary and file one rolling issue naming exactly which ratchets are red.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runGates } from "./lint-product.mjs";

const root = path.resolve(import.meta.dirname, "..");

/**
 * The weekly membership. Longest-first (`test:comment-density` is 10.2 s and
 * dominates; everything else is under 4 s).
 */
export const HYGIENE_GATES = Object.freeze([
  "test:comment-density",
  "test:hygiene-ratchet",
  "test:env-red",
  "test:skip-inventory",
  "test:sleep-inventory",
  "lint:type-floor",
  "lint:schema-export",
]);

/**
 * The machine-readable verdict for one run of the lane.
 * @param {Array<{name: string, code: number, ms: number}>} results One entry per gate, as `runGates` returns them.
 * @param {string} at ISO timestamp the lane started at.
 * @returns {{schema: number, lane: string, rung: number, at: string, verdict: string, red: string[], gates: Array<{gate: string, verdict: string, durationMs: number}>}} The lane's machine-readable verdict.
 */
export function summarize(results, at) {
  const gates = [...results]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({
      gate: r.name,
      verdict: r.code === 0 ? "passed" : "failed",
      durationMs: r.ms,
    }));
  const red = gates.filter((g) => g.verdict === "failed").map((g) => g.gate);
  return {
    schema: 1,
    lane: "hygiene",
    rung: 5,
    at,
    verdict: red.length === 0 ? "passed" : "failed",
    red,
    gates,
  };
}

/**
 * One row per gate, verdict and cost. Shared by the job summary and the
 * rolling issue so the two can never disagree about what ran.
 * @param {ReturnType<typeof summarize>} summary The lane's verdict.
 * @returns {string} A markdown table, one row per gate.
 */
export function gateTable(summary) {
  return [
    "| Gate | Verdict | Duration |",
    "| --- | --- | --- |",
    ...summary.gates.map(
      (g) =>
        `| \`${g.gate}\` | ${g.verdict} | ${(g.durationMs / 1000).toFixed(1)}s |`
    ),
  ].join("\n");
}

/**
 * The job summary: what ran, how it went, how long it took.
 * @param {ReturnType<typeof summarize>} summary The lane's verdict.
 * @returns {string} Markdown for `$GITHUB_STEP_SUMMARY`.
 */
export function summaryMarkdown(summary) {
  return `### Weekly hygiene ratchets — ${summary.verdict}\n\n${gateTable(summary)}\n`;
}

/**
 * The rolling issue's body. One issue per lane, replaced in place every week,
 * so the body always states the lane's CURRENT condition rather than growing a
 * thread nobody reads (#915 Wave 0's rule, applied here).
 * @param {ReturnType<typeof summarize>} summary The lane's verdict.
 * @param {string} runUrl Link back to the Actions run that produced it.
 * @returns {string} The rolling issue's whole body.
 */
export function issueBody(summary, runUrl) {
  const lines = [
    `The weekly hygiene ratchets were red on ${summary.at}.`,
    "",
    gateTable(summary),
    "",
    "Each of these is a tighten-only ratchet over the test suite's own quality",
    '(docs/decisions.md, "Gate and ledger diet"). Reproduce locally with:',
    "",
    "```sh",
    ...summary.red.map((gate) => `bun run ${gate}`),
    "```",
    "",
    "Fix the code, never the ledger: a ratchet that is loosened to go green has",
    "stopped being a ratchet. Closing this issue means the lane is green.",
    "",
    `Run: ${runUrl}`,
  ];
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] === import.meta.filename) {
  const at = new Date().toISOString();
  const { results, failed } = await runGates(HYGIENE_GATES, {
    label: "hygiene ratchets",
  });
  const summary = summarize(results, at);
  const dir = path.join(root, "artifacts/hygiene");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  writeFileSync(path.join(dir, "summary.md"), summaryMarkdown(summary));
  writeFileSync(
    path.join(dir, "issue-body.md"),
    issueBody(summary, process.env.HYGIENE_RUN_URL ?? "(local run)")
  );
  if (failed.length > 0) process.exit(1);
}
