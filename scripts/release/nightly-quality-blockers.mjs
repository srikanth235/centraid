import { spawnSync } from "node:child_process";

export const NIGHTLY_QUALITY_ISSUE_SEARCH =
  'in:title "[nightly] e2e lane red — tracking"';

export function parseOpenNightlyIssues(stdout) {
  const rows = JSON.parse(stdout || "[]");
  return Array.isArray(rows)
    ? rows.filter(
        (row) =>
          Number.isInteger(row?.number) &&
          typeof row?.title === "string" &&
          typeof row?.url === "string"
      )
    : [];
}

export function assertNoOpenNightlyQualityIssues(run = defaultRun) {
  const result = run([
    "issue",
    "list",
    "--state",
    "open",
    "--search",
    NIGHTLY_QUALITY_ISSUE_SEARCH,
    "--json",
    "number,title,url",
  ]);
  if (result.status !== 0)
    throw new Error(`cannot verify nightly quality blockers: ${result.stderr}`);
  const blockers = parseOpenNightlyIssues(result.stdout);
  if (blockers.length) {
    throw new Error(
      `release blocked by open nightly quality issue(s): ${blockers
        .map((issue) => `#${issue.number} ${issue.url}`)
        .join(", ")}`
    );
  }
}

function defaultRun(args) {
  if (process.env.CENTRAID_NIGHTLY_QUALITY_ISSUES !== undefined) {
    return {
      status: 0,
      stdout: process.env.CENTRAID_NIGHTLY_QUALITY_ISSUES,
      stderr: "",
    };
  }
  const result = spawnSync("gh", args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
