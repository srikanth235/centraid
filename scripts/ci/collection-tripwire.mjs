#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const DEFAULT_REPORT = path.join(root, "artifacts/test-results/vitest.json");

export function findCollectionErrors(report) {
  if (!report || typeof report !== "object")
    return {
      ok: false,
      errors: ["collection-tripwire: report is not an object"],
      offenders: [],
    };
  const results = /** @type {{ testResults?: unknown }} */ (report).testResults;
  if (!Array.isArray(results))
    return {
      ok: false,
      errors: ["collection-tripwire: report has no `testResults` array"],
      offenders: [],
    };

  const offenders = [];
  for (const entry of results) {
    const file = /** @type {Record<string, unknown>} */ (entry ?? {});
    const assertions = file.assertionResults;
    if (file.status !== "failed") continue;
    if (Array.isArray(assertions) && assertions.length > 0) continue;
    offenders.push({
      file: typeof file.name === "string" ? relative(file.name) : "<unnamed>",
      message: firstLine(file.message),
    });
  }

  return {
    ok: offenders.length === 0,
    errors: offenders.map(
      (offender) =>
        `collection-tripwire: ${offender.file} collected 0 tests and failed while loading — ${offender.message}`
    ),
    offenders,
  };
}

function relative(name) {
  return name.startsWith(root) ? path.relative(root, name) : name;
}

function firstLine(message) {
  if (typeof message !== "string" || message.trim() === "")
    return "no message recorded";
  return message
    .split("\n")
    .find((line) => line.trim() !== "")
    .trim();
}

if (process.argv[1] === import.meta.filename) {
  const flagged = process.argv.indexOf("--report");
  const reportPath =
    flagged === -1 ? DEFAULT_REPORT : path.resolve(process.argv[flagged + 1]);

  if (!existsSync(reportPath)) {
    if (process.argv.includes("--require-report")) {
      console.error(
        `collection-tripwire: ${path.relative(root, reportPath)} is missing, so no file could be scored. Run the vitest lane that writes it before this gate.`
      );
      process.exit(1);
    }
    console.log(
      "collection-tripwire: not measured (no artifacts/test-results/vitest.json — run `bun run coverage` or the full vitest lane first)"
    );
    process.exit(0);
  }

  const verdict = findCollectionErrors(
    JSON.parse(readFileSync(reportPath, "utf8"))
  );
  if (verdict.ok) {
    console.log(
      "collection-tripwire: every reported file collected at least one test"
    );
    process.exit(0);
  }
  for (const error of verdict.errors) console.error(error);
  console.error(
    "collection-tripwire: a file that fails to load runs zero assertions and is counted by no floor, no skip budget and no quarantine entry. Fix the import or harness defect — quarantining or deleting the file hides the gap it leaves."
  );
  process.exit(1);
}
