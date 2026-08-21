#!/usr/bin/env node
/**
 * Collection-error tripwire (#842 W0.3).
 *
 * A test file that throws while it is being LOADED never registers a single
 * `test()`. Vitest reports it as one failed file carrying a message and an
 * EMPTY `assertionResults` array — a shape that no other gate in this repo
 * reads. That matters because every counting gate here counts what ran:
 * `tests/matrix.json` minimum-test floors, the skip budget, the quarantine
 * ledger, and the coverage floors all see a smaller universe rather than a
 * violated one. The suite becomes silently absent instead of red.
 *
 * `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx` sat that way for
 * months (`Cannot bundle Node.js built-in "node:sqlite"`): named in receipt
 * after receipt as "pre-existing", counted by nothing, fixed by nobody, and
 * eventually deleted along with the interface it covered without its journey
 * assertions ever running again. This gate turns that class into a named,
 * self-explaining failure with an owner.
 *
 * It reads the same artifact the health report and the wall-clock ceiling read
 * (`artifacts/test-results/vitest.json`), so it costs one file read on a lane
 * that already produced the report.
 *
 * Usage:
 *   node scripts/ci/collection-tripwire.mjs                   # enforce
 *   node scripts/ci/collection-tripwire.mjs --require-report  # also fail when absent
 *   node scripts/ci/collection-tripwire.mjs --report <path>   # score another report
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const DEFAULT_REPORT = path.join(root, "artifacts/test-results/vitest.json");

/**
 * Files that errored before collecting any test.
 *
 * The signature is deliberately narrow: file status `failed` together with zero
 * assertion results. An ordinary failing test yields a failed file WITH a
 * failed assertion in it, and a wholly skipped file yields skipped assertions —
 * both stay out of this list, so the gate cannot be satisfied by making real
 * failures quieter.
 *
 * @param {unknown} report Parsed vitest JSON report.
 * @returns {{ ok: boolean, errors: string[], offenders: { file: string, message: string }[] }}
 *   `ok` false when the report is unreadable or any file failed to collect.
 */
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

/** Repo-relative path when the report used an absolute one. */
function relative(name) {
  return name.startsWith(root) ? path.relative(root, name) : name;
}

/** First non-empty line of a failure message, for a one-line gate error. */
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
    // A laptop run that never produced a report has nothing to say; a LANE
    // that enforces this gate must not read a missing artifact as a clean one,
    // so the lane passes `--require-report`.
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
