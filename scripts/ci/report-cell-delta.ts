#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const flags: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index];
  if (value === undefined || !value.startsWith("--")) continue;
  const next = argv[index + 1];
  if (next !== undefined) flags[value.slice(2)] = next;
}
const summary = await readJson(flags["summary"]);
const line = (label: string, values: unknown): string =>
  `- ${label}: ${
    Array.isArray(values) && values.length
      ? values.map((value) => `\`${String(value)}\``).join(", ")
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
      ...queue.map((raw) => {
        const entry = isRecord(raw) ? raw : {};
        const tracking = entry.trackingIssue;
        return `| ${String(entry.severity ?? "")} | ${String(entry.title ?? "")} | \`${String(entry.owner ?? "—")}\` | ${
          tracking ? `#${String(tracking)}` : "—"
        } | ${String(entry.why ?? "").replaceAll("|", "\\|")} |`;
      }),
    ]
  : ["", "### Attention queue (S1/S2)", "", "- none"];
const markdown = [
  line("newly grey", summary?.newMissingCellIds),
  line("newly red", summary?.newFailedCellIds),
  line("infra mismatch", summary?.infraMismatchCellIds),
  line("infra past max age", summary?.agedInfraMismatchCellIds),
  `- verdict: \`${String(summary?.verdict ?? "unknown")}\`${
    summary?.verdictDirection
      ? ` (${String(summary.verdictDirection)} vs last night)`
      : ""
  }`,
  ...queueTable,
  "",
].join("\n");
const output = flags["output"];
if (output) await writeFile(output, markdown);
else process.stdout.write(markdown);

async function readJson(
  file: string | undefined
): Promise<Record<string, unknown> | null> {
  if (file === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
