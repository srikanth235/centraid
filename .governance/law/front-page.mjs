// The front page: a run of the law, rendered for a pull request body (#1005).
//
// Plain markdown, no colour, no library. It answers the three questions a
// reviewer opens a PR with — what range is this, did the law itself move under
// it, and what did the law say — before any prose the author wrote.
/**
 * Render a run.
 *
 * @param {object} report The object `run.mjs --json` prints.
 * @returns {string} Markdown, with a trailing newline.
 */
export function renderFrontPage(report) {
  const short = (sha) => (sha ? sha.slice(0, 8) : "—");
  const digest = (value) => (value ? value.slice(0, 12) : "(none)");
  const lines = [
    `**Law** · ${report.door} door · range \`${short(report.range?.base)}..${short(report.range?.head)}\` · law digest \`${digest(report.lawDigest.base)}\` → \`${digest(report.lawDigest.head)}\``,
  ];
  if (report.lawDigest.base !== report.lawDigest.head) {
    lines.push(
      "",
      `law changed under this run: ${report.lawChanged.map((file) => `\`${file}\``).join(", ") || "(unnamed)"}`
    );
  }
  lines.push("", "| Rule | Door | Verdict | Findings |", "| --- | --- | --- | --- |");
  if (report.rules.length === 0) {
    lines.push("| _(no rules enabled)_ | — | — | — |");
  }
  for (const rule of report.rules) {
    lines.push(
      `| \`${rule.id}\` | ${rule.door} | ${rule.verdict === "pass" ? "✓ pass" : "✗ fail"} | ${rule.count} |`
    );
  }
  if (report.messages.length > 0) {
    lines.push("", "### Findings", "");
    for (const message of report.messages) {
      lines.push(
        `- \`${message.path}:${message.line}\` **${message.ruleId}** (${message.severity}) — ${message.message}`
      );
    }
  }
  // The number is not measured yet; saying so is the current state, and a
  // blank where a number belongs reads as zero.
  lines.push("", "token cost: not recorded");
  return `${lines.join("\n")}\n`;
}
