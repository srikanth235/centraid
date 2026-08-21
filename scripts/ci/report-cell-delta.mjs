#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, value, index, all) =>
        value.startsWith("--")
          ? [...pairs, [value.slice(2), all[index + 1]]]
          : pairs,
      []
    )
);
const summary = await readJson(flags.summary);
const line = (label, values) =>
  `- ${label}: ${
    Array.isArray(values) && values.length
      ? values.map((value) => `\`${value}\``).join(", ")
      : "none"
  }`;
/**
 * The report's own ranked attention queue (#839 Wave 5), carried into the body
 * `scripts/ci/file-tracking-issue.mjs` opens or updates. `generate.mjs` puts
 * only the S1/S2 band in `summary.attentionQueue` — the items whose 24h SLA
 * starts tonight — so the issue names owners rather than restating the whole
 * grey inventory the report page already shows.
 */
const queue = Array.isArray(summary?.attentionQueue)
  ? summary.attentionQueue
  : [];
const queueTable = queue.length
  ? [
      "",
      "### Attention queue (S1/S2)",
      "",
      "| Sev | Item | Owner | Tracking | Why |",
      "| --- | --- | --- | --- | --- |",
      ...queue.map(
        (entry) =>
          `| ${entry.severity} | ${entry.title} | \`${entry.owner ?? "—"}\` | ${
            entry.trackingIssue ? `#${entry.trackingIssue}` : "—"
          } | ${String(entry.why ?? "").replaceAll("|", "\\|")} |`
      ),
    ]
  : ["", "### Attention queue (S1/S2)", "", "- none"];
const markdown = [
  line("newly grey", summary?.newMissingCellIds),
  line("newly red", summary?.newFailedCellIds),
  line("infra mismatch", summary?.infraMismatchCellIds),
  line("infra past max age", summary?.agedInfraMismatchCellIds),
  `- verdict: \`${summary?.verdict ?? "unknown"}\`${
    summary?.verdictDirection
      ? ` (${summary.verdictDirection} vs last night)`
      : ""
  }`,
  ...queueTable,
  "",
].join("\n");
if (flags.output) await writeFile(flags.output, markdown);
else process.stdout.write(markdown);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}
