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
