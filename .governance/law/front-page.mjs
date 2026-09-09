// The front page: a run of the law, rendered for a pull request body (#1005).
//
// Plain markdown, no colour, no library. It answers the three questions a
// reviewer opens a PR with — what range is this, did the law itself move under
// it, and what did the law say — before any prose the author wrote.
/**
 * The registry lines: what this arrival recorded, generated from the record.
 *
 * Every line here is written by the generator's reading of the change, never by
 * an author. "no rulings recorded" is a claim the law is making about the diff,
 * and it is only worth printing because nobody could have typed it in.
 *
 * @param {object|null} arrival The arrival record, when the runner has it.
 * @returns {string[]} Markdown lines, possibly empty.
 */
export function renderRegistries(arrival) {
  const { changelog, decisions, docket, receipts } = arrival?.registries ?? {};
  const cite = (issues) => issues.map((issue) => `#${issue}`).join(", ");
  const gates = arrival?.gates ?? [];
  const waivers = (arrival?.waivers ?? []).filter((waiver) => waiver.reason !== "");
  // The cost is the author's number, read back out of the receipt this change
  // touched. The law reports whether it was recorded, never what it should be.
  const costs = (receipts?.files ?? [])
    .filter((row) => row.touched && row.cost)
    .map((row) => `${row.path}: ${row.cost}`);
  return [
    "",
    "### Registries",
    "",
    decisions?.issues?.length > 0
      ? `- rulings recorded: ${cite(decisions.issues)} in \`docs/decisions.md\``
      : "- no rulings recorded",
    changelog?.issues?.length > 0
      ? `- changelog entries: ${cite(changelog.issues)}`
      : "- no changelog entry",
    gates.length > 0
      ? `- gates moved: ${gates.map((gate) => `\`${gate.path}\` (${gate.direction})`).join(", ")}`
      : "- no gates moved",
    ...(waivers.length === 0
      ? ["- no waivers used"]
      : waivers.map(
          (waiver) =>
            `- waiver used: \`${waiver.directive}\`${waiver.path ? ` \`${waiver.path}\`` : ""} — ${waiver.reason} (${waiver.source})`
        )),
    ...(docket?.exists ? [] : ["- docket not yet established"]),
    ...((arrival?.ci?.issueIsProposal ?? null) === null
      ? ["- proposal link unverified (offline)"]
      : []),
    costs.length > 0 ? `- token cost: ${costs.join("; ")}` : "- token cost: not recorded",
  ];
}

/**
 * Render a run.
 *
 * @param {object} report The object `run.mjs --json` prints.
 * @param {object} [arrival] The record the run linted, for the registry lines.
 * @returns {string} Markdown, with a trailing newline.
 */
export function renderFrontPage(report, arrival = null) {
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
  lines.push(...renderRegistries(arrival));
  return `${lines.join("\n")}\n`;
}
