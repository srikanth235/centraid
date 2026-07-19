/**
 * Markdown views of the test-health summary for Actions Job Summary (and
 * optional sidecars). Rendering helpers stay pure; writeSummarySidecars is
 * the only I/O entry.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export const REPORT_COMMENT_MARKER = '<!-- centraid-test-health-report -->';
/**
 * @param {object} summary - payload from generate.mjs `summary.json`
 * @param {{ reportUrl?: string, runUrl?: string, title?: string }} [meta]
 */
export function renderSummaryMarkdown(summary, meta = {}) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const title = meta.title ?? 'Test health';
  const failed = Number(s.failed ?? 0);
  const unhandled = Number(s.unhandledErrors ?? 0);
  const cellsFailed = Number(s.cellsFailed ?? 0);
  const cellsMissing = Number(s.cellsMissing ?? 0);
  const floorsBelow = Array.isArray(s.coverageBelowFloor) ? s.coverageBelowFloor : [];
  const validationErrors = Number(s.validationErrorCount ?? 0);

  const health =
    failed > 0 || unhandled > 0 || cellsFailed > 0 || floorsBelow.length > 0 || validationErrors > 0
      ? 'needs attention'
      : 'ok';

  const lines = [
    `## ${title}`,
    '',
    `**Status:** ${health}`,
    '',
    '| Signal | Value |',
    '| --- | ---: |',
    `| Evidence passed | ${Number(s.passed ?? 0)} |`,
    `| Evidence failed | ${failed} |`,
    `| Cells failed (ran) | ${cellsFailed} |`,
    `| Cells not run | ${cellsMissing} |`,
    `| Unhandled errors | ${unhandled} |`,
    `| Coverage floors below | ${floorsBelow.length} |`,
    `| Matrix validation errors | ${validationErrors} |`,
    '',
  ];

  if (floorsBelow.length) {
    lines.push(`Coverage below floor: ${floorsBelow.map((x) => `\`${x}\``).join(', ')}`, '');
  }

  if (Array.isArray(s.unhandledErrorMessages) && s.unhandledErrorMessages.length) {
    lines.push('<details><summary>Unhandled error messages</summary>', '');
    for (const msg of s.unhandledErrorMessages.slice(0, 8)) {
      lines.push(`- \`${String(msg).replace(/`/g, "'").slice(0, 240)}\``);
    }
    if (s.unhandledErrorMessages.length > 8) {
      lines.push(`- …and ${s.unhandledErrorMessages.length - 8} more`);
    }
    lines.push('', '</details>', '');
  }

  if (meta.reportUrl) {
    lines.push(`**Full report:** ${meta.reportUrl}`, '');
  } else {
    lines.push(
      '_Public HTML report publishes on main (and nightly); this run keeps the artifact + Job Summary only._',
      '',
    );
  }

  if (meta.runUrl) {
    lines.push(`Actions run: ${meta.runUrl}`, '');
  }

  if (s.generatedAt) {
    lines.push(`Generated: \`${s.generatedAt}\``, '');
  }

  lines.push(REPORT_COMMENT_MARKER, '');
  return lines.join('\n');
}

/**
 * Build public Pages URL for a report slot.
 * @param {{ owner: string, repo: string, slot: string }} opts
 * slot e.g. `main`, `nightly` (PR slots are not published)
 */
export function publicReportUrl({ owner, repo, slot }) {
  const clean = String(slot).replace(/^\/+|\/+$/g, '');
  return `https://${owner}.github.io/${repo}/test-report/${clean}/`;
}

/**
 * From generate.mjs coverage rows, list scopes under their line floor.
 * @param {Array<{ scope: string, lines: number|null, lineFloor?: number|null }>} coverageRows
 */
export function coverageScopesBelowFloor(coverageRows) {
  const below = [];
  for (const row of coverageRows ?? []) {
    if (row == null) continue;
    if (typeof row.lines !== 'number' || typeof row.lineFloor !== 'number') continue;
    if (row.lines < row.lineFloor) below.push(row.scope);
  }
  return below;
}

/** Write summary.json + summary.md next to the HTML report. */
export async function writeSummarySidecars(reportDir, summaryPayload, meta = {}) {
  const jsonPath = path.join(reportDir, 'summary.json');
  const mdPath = path.join(reportDir, 'summary.md');
  await writeFile(jsonPath, `${JSON.stringify(summaryPayload, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, renderSummaryMarkdown(summaryPayload, meta), 'utf8');
  return { jsonPath, mdPath };
}
