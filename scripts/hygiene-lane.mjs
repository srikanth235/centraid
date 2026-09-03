#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runGates } from "./lint-product.mjs";

const root = path.resolve(import.meta.dirname, "..");

export const HYGIENE_GATES = Object.freeze([
  "test:comment-density",
  "test:hygiene-ratchet",
  "test:env-red",
  "test:skip-inventory",
  "test:sleep-inventory",
  "lint:type-floor",
  "lint:schema-export",
]);

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

export function summaryMarkdown(summary) {
  return `### Weekly hygiene ratchets — ${summary.verdict}\n\n${gateTable(summary)}\n`;
}

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
