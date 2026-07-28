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
const markdown = [
  line("newly grey", summary?.newMissingCellIds),
  line("newly red", summary?.newFailedCellIds),
  line("infra mismatch", summary?.infraMismatchCellIds),
  line("infra past max age", summary?.agedInfraMismatchCellIds),
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
