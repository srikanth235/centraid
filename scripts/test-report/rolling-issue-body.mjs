#!/usr/bin/env node
/**
 * The per-lane rolling issue body (#915 Wave 0 + Wave 3).
 *
 * One issue per lane, rewritten in place, never re-created — and written from
 * the SAME attention-queue model §3 renders, so the issue and the page cannot
 * disagree about who owes what by when. That is the whole point: the previous
 * daily tracking issue carried a hand-maintained job list that covered neither
 * `fuzz-parsers` nor `dast-scan`, so the one part a reader would act on was
 * also the part most likely to be stale.
 *
 *   node scripts/test-report/rolling-issue-body.mjs \
 *     --lane <id> --summary dist/test-report/summary.json \
 *     [--evidence artifacts/evidence] [--report-url <url>]
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { readEvidenceDir } from "./read-evidence.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** The marker that makes the body idempotent: one issue, rewritten in place. */
export const ROLLING_MARKER = "<!-- centraid-rolling-lane-issue -->";

/**
 * Render the body.
 *
 * @param {{lane: string, summary: object, evidence: object|null, reportUrl?: string}} input the lane, tonight's summary, its evidence and the report URL
 * @returns {string} GitHub-flavoured markdown
 */
export function renderRollingIssueBody({
  lane,
  summary,
  evidence = null,
  reportUrl,
}) {
  const blocker =
    (summary.blockers ?? []).find((row) => row.lane === lane) ?? null;
  const park = (summary.parks ?? []).find((row) => row.lane === lane) ?? null;
  const verdict = evidence?.verdict ?? (park ? "parked" : "no-evidence");

  const state = park
    ? `parked until ${park.until}`
    : verdict === "failed"
      ? "failed"
      : verdict === "passed"
        ? "passed"
        : verdict;

  const deadline = park
    ? `park expires ${park.until} — it counts as red again that morning`
    : blocker
      ? blocker.overSla
        ? `over the 24 h SLA to owned (${blocker.ageHours} h) — fix or park it`
        : `owned by ${blocker.deadline}`
      : "no deadline: this lane is not currently red";

  const lines = [
    `## \`${lane}\` — ${state}`,
    "",
    `**Tonight's verdict:** ${verdict}${blocker ? ` · ${blocker.severity}` : ""}`,
    `**Candidate:** \`${summary.candidate ?? "none"}\``,
    `**Report verdict:** ${summary.verdict ?? "UNKNOWN"} — ${summary.why ?? ""}`,
    "",
    `**Deadline:** ${deadline}`,
    "",
  ];

  if (blocker) {
    lines.push(
      "### Bisection bounds",
      "",
      `- first red on \`${blocker.firstRed ?? "unknown"}\``,
      `- last green on \`${blocker.lastGreen ?? "unknown"}\``,
      `- owner: ${blocker.owner ?? "unowned — claim it"}`,
      ""
    );
  }

  const failing = (evidence?.cases ?? []).filter(
    (entry) => entry.verdict === "failed"
  );
  if (failing.length > 0) {
    lines.push("### Failing cases", "");
    for (const entry of failing) {
      lines.push(
        `- \`${entry.id}\` — ${Math.round((entry.durationMs ?? 0) / 1000)}s, ${entry.attempts ?? 1} attempt(s)`
      );
    }
    lines.push("");
  }

  if (park) {
    lines.push(
      "### Park",
      "",
      `Parked against #${park.issue}${park.since ? ` since ${park.since}` : ""}. ${park.why ?? ""}`.trim(),
      "",
      "A park is a date on the debt, not a mute: the lane still runs and still writes evidence, and the report counts it as parked rather than red until the expiry.",
      ""
    );
  }

  if (reportUrl) lines.push(`Full report: ${reportUrl}`, "");
  lines.push(
    "_This issue is rewritten in place every run. Its body is rendered from the same attention-queue model as §3 of the Night Watch report, so the two cannot disagree._",
    "",
    ROLLING_MARKER,
    ""
  );
  return lines.join("\n");
}

/** `--flag value` pairs. */
function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--"))
      flags[argv[index].slice(2)] = argv[index + 1];
  }
  return flags;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.lane) {
    const summary = JSON.parse(
      readFileSync(
        path.resolve(ROOT, flags.summary ?? "dist/test-report/summary.json"),
        "utf8"
      )
    );
    const { lanes } = readEvidenceDir(
      path.resolve(ROOT, flags.evidence ?? "artifacts/evidence")
    );
    process.stdout.write(
      renderRollingIssueBody({
        lane: flags.lane,
        summary,
        evidence: lanes.get(flags.lane) ?? null,
        reportUrl: flags["report-url"],
      })
    );
  } else {
    process.stderr.write("rolling-issue-body: --lane is required\n");
    process.exitCode = 1;
  }
}
