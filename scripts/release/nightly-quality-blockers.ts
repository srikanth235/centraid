import { spawnSync } from "node:child_process";

export const NIGHTLY_QUALITY_ISSUE_SEARCH =
  'in:title "[nightly] e2e lane red — tracking"';

export function parseOpenNightlyIssues(
  stdout: string
): Array<{ number: number; title: string; url: string }> {
  const rows: unknown = JSON.parse(stdout || "[]");
  if (!Array.isArray(rows)) return [];
  const issues: Array<{ number: number; title: string; url: string }> = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const rec = row as Record<string, unknown>;
    if (
      Number.isInteger(rec["number"]) &&
      typeof rec["title"] === "string" &&
      typeof rec["url"] === "string"
    ) {
      issues.push({
        number: rec["number"] as number,
        title: rec["title"],
        url: rec["url"],
      });
    }
  }
  return issues;
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

function defaultRun(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
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
