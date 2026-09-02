/**
 * Markdown views of the test-health summary for Actions Job Summary (and
 * optional sidecars). Rendering helpers stay pure; writeSummarySidecars is
 * the only I/O entry.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

export const REPORT_COMMENT_MARKER = "<!-- centraid-test-health-report -->";
/**
 * The Job Summary block, rendered from the #915 `summary.json` shape:
 * `{schema, verdict, why, flip, blockers[], deltas{}, parks[], candidate,
 * generatedAt}`. A night recorded before #915 carries none of these fields and
 * renders as UNKNOWN with zero counts rather than as a false all-clear.
 *
 * @param {object} summary - payload from generate.mjs `summary.json`
 * @param {{ reportUrl?: string, runUrl?: string, title?: string }} [meta] - links and heading for the rendered block
 */
export function renderSummaryMarkdown(summary, meta = {}) {
  const s = summary && typeof summary === "object" ? summary : {};
  const title = meta.title ?? "Night Watch";
  const verdict = String(s.verdict ?? "UNKNOWN");
  const blockers = Array.isArray(s.blockers) ? s.blockers : [];
  const parks = Array.isArray(s.parks) ? s.parks : [];
  const deltas = s.deltas && typeof s.deltas === "object" ? s.deltas : {};
  const validationErrors = Number(s.validationErrorCount ?? 0);

  const lines = [
    `## ${title} — ${verdict}`,
    "",
    s.why ? `${s.why}` : "",
    "",
    "| Signal | Value |",
    "| --- | ---: |",
    `| Lanes passed | ${Number(deltas.passed ?? 0)} |`,
    `| Lanes failed | ${Number(deltas.failed ?? 0)} |`,
    `| Lanes degraded | ${Number(deltas.degraded ?? 0)} |`,
    `| Lanes parked | ${parks.length} |`,
    `| Lanes with no evidence | ${Number(deltas.noEvidence ?? 0)} |`,
    `| New red since the last candidate | ${Number(deltas.newRed ?? 0)} |`,
    `| New green since the last candidate | ${Number(deltas.newGreen ?? 0)} |`,
    `| Validation errors | ${validationErrors} |`,
    "",
  ];

  if (blockers.length) {
    lines.push("### Blockers", "");
    for (const blocker of blockers.slice(0, 10)) {
      lines.push(
        `- **${blocker.severity}** \`${blocker.lane}\`${blocker.case ? ` · ${blocker.case}` : ""} — ${blocker.ageHours}h of the 24h SLA, ${blocker.owner ?? "unowned"}`
      );
    }
    lines.push("");
  }

  if (s.flip) lines.push(`**To flip the verdict:** ${s.flip}`, "");
  if (s.candidate) lines.push(`Candidate: \`${s.candidate}\``, "");
  if (meta.reportUrl) {
    lines.push(`**Full report:** ${meta.reportUrl}`, "");
  } else {
    lines.push(
      "_Public HTML report publishes on main (and nightly); this run keeps the artifact + Job Summary only._",
      ""
    );
  }
  if (meta.runUrl) lines.push(`Actions run: ${meta.runUrl}`, "");
  if (s.generatedAt) lines.push(`Generated: \`${s.generatedAt}\``, "");

  lines.push(REPORT_COMMENT_MARKER, "");
  return lines.join("\n");
}

/**
 * Build public Pages URL for a report slot.
 * @param {{ owner: string, repo: string, slot: string }} opts
 * slot e.g. `main`, `nightly` (PR slots are not published)
 */
export function publicReportUrl({ owner, repo, slot }) {
  const clean = String(slot).replace(/^\/+|\/+$/gu, "");
  return `https://${owner}.github.io/${repo}/test-report/${clean}/`;
}

/**
 * From generate.mjs coverage rows, list scopes under their line floor.
 * @param {Array<{ scope: string, lines: number|null, lineFloor?: number|null }>} coverageRows - coverage rows to check
 */
export function coverageScopesBelowFloor(coverageRows) {
  const below = [];
  for (const row of coverageRows ?? []) {
    if (row == null) continue;
    if (typeof row.lines !== "number" || typeof row.lineFloor !== "number")
      continue;
    if (row.lines < row.lineFloor) below.push(row.scope);
  }
  return below;
}

/** Write summary.json + summary.md next to the HTML report. */
export async function writeSummarySidecars(
  reportDir,
  summaryPayload,
  meta = {}
) {
  const jsonPath = path.join(reportDir, "summary.json");
  const mdPath = path.join(reportDir, "summary.md");
  await writeFile(
    jsonPath,
    `${JSON.stringify(summaryPayload, null, 2)}\n`,
    "utf8"
  );
  await writeFile(mdPath, renderSummaryMarkdown(summaryPayload, meta), "utf8");
  return { jsonPath, mdPath };
}
