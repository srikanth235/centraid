/* oxlint-disable vitest/no-import-node-test -- (#1018) node --test lane, not a vitest suite */
/* oxlint-disable vitest/prefer-importing-vitest-globals -- (#1018) node --test lane, not a vitest suite */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { findCollectionErrors } from "./collection-tripwire.ts";

const SCRIPT = path.join(import.meta.dirname, "collection-tripwire.ts");
const FIXTURES = path.join(import.meta.dirname, "fixtures");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface VitestAssertion {
  status: string;
  failureMessages?: string[];
}

interface VitestFileResult {
  name?: string;
  status: string;
  message?: string;
  assertionResults: VitestAssertion[];
}

interface VitestReport {
  testResults: VitestFileResult[];
}

function asAssertion(value: unknown): VitestAssertion {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error("fixture assertion is missing status");
  }
  const failureMessages = value.failureMessages;
  return {
    status: value.status,
    failureMessages: Array.isArray(failureMessages)
      ? failureMessages.filter((message) => typeof message === "string")
      : undefined,
  };
}

function asFileResult(value: unknown): VitestFileResult {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error("fixture file result is missing status");
  }
  const assertionResults = Array.isArray(value.assertionResults)
    ? value.assertionResults.map(asAssertion)
    : [];
  return {
    name: typeof value.name === "string" ? value.name : undefined,
    status: value.status,
    message: typeof value.message === "string" ? value.message : undefined,
    assertionResults,
  };
}

function asReport(value: unknown): VitestReport {
  if (!isRecord(value) || !Array.isArray(value.testResults)) {
    throw new Error("fixture is not a vitest JSON report");
  }
  return { testResults: value.testResults.map(asFileResult) };
}

// Both fixtures are verbatim `vitest run --reporter=json` output for
// `apps/mobile/src/lib/replica/node-sqlite-driver.jsdom.test.ts`: healthy, and
// with the node:sqlite externalization plugin removed from the test-kit node
// preset — the exact defect that made
// `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx` uncollectable
// (#842). They are real reports rather than hand-written shapes so the gate is
// pinned to what Vitest actually emits, not to what this script assumed.
const HEALTHY = path.join(FIXTURES, "vitest-healthy.json");
const COLLECTION_ERROR = path.join(FIXTURES, "vitest-collection-error.json");

/** Parse a fixture report. */
function load(fixture: string): VitestReport {
  const parsed: unknown = JSON.parse(readFileSync(fixture, "utf8"));
  return asReport(parsed);
}

/** Run the gate CLI over a report path. */
function runGate(reportPath: string, ...extra: string[]) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--report", reportPath, ...extra],
    {
      encoding: "utf8",
    }
  );
}

test("a healthy report has no collection errors", () => {
  const verdict = findCollectionErrors(load(HEALTHY));
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.offenders, []);
});

test("a file that failed with zero assertions is a collection error", () => {
  const verdict = findCollectionErrors(load(COLLECTION_ERROR));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.offenders.length, 1);
  const offender = verdict.offenders[0];
  assert.ok(offender);
  assert.match(offender.file, /node-sqlite-driver\.jsdom\.test\.ts$/u);
  assert.match(offender.message, /Cannot bundle Node\.js built-in/u);
  assert.match(verdict.errors[0] ?? "", /collected 0 tests/u);
});

test("an ordinary failing test is not reported as a collection error", () => {
  const report = load(HEALTHY);
  const file = report.testResults[0];
  const assertion = file?.assertionResults[0];
  assert.ok(file);
  assert.ok(assertion);
  file.status = "failed";
  assertion.status = "failed";
  assertion.failureMessages = ["expected 1"];
  const verdict = findCollectionErrors(report);
  assert.equal(
    verdict.ok,
    true,
    "real reds belong to the suite, not this gate"
  );
});

test("a wholly skipped file is not reported as a collection error", () => {
  const report = load(HEALTHY);
  const file = report.testResults[0];
  const assertion = file?.assertionResults[0];
  assert.ok(file);
  assert.ok(assertion);
  file.status = "skipped";
  assertion.status = "skipped";
  const verdict = findCollectionErrors(report);
  assert.equal(verdict.ok, true);
});

test("a message-less failed empty file is still flagged", () => {
  const report = load(COLLECTION_ERROR);
  const file = report.testResults[0];
  assert.ok(file);
  file.message = "";
  const verdict = findCollectionErrors(report);
  assert.equal(verdict.ok, false);
  const offender = verdict.offenders[0];
  assert.ok(offender);
  assert.match(offender.message, /no message recorded/u);
});

test("an unreadable report fails rather than passing empty", () => {
  assert.equal(findCollectionErrors(null).ok, false);
  assert.equal(findCollectionErrors({}).ok, false);
  assert.equal(findCollectionErrors({ testResults: "nope" }).ok, false);
});

test("the CLI exits 0 on the healthy fixture", () => {
  const run = runGate(HEALTHY);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /every reported file collected at least one test/u);
});

test("the CLI exits 1 on the collection-error fixture", () => {
  const run = runGate(COLLECTION_ERROR);
  assert.equal(run.status, 1);
  assert.match(
    run.stderr,
    /node-sqlite-driver\.jsdom\.test\.ts collected 0 tests/u
  );
  assert.match(run.stderr, /counted by no floor, no skip budget/u);
});

test("a missing report is 'not measured' locally and fatal under --require-report", () => {
  const absent = path.join(FIXTURES, "no-such-report.json");

  const quiet = runGate(absent);
  assert.equal(quiet.status, 0);
  assert.match(quiet.stdout, /not measured/u);

  const strict = runGate(absent, "--require-report");
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /is missing, so no file could be scored/u);
});

// The wiring, not the scoring. `--require-report` is a promise that the report
// EXISTS by the time the gate runs, and nothing checked that the lane asking for
// it also writes one. `verify` asked for it while `test:suite` ran
// `--reporter=default` alone: the suite went green, 1502 files and 18162 tests
// passed, and the job's last step failed on an artifact no step in it produced.
// A deterministic red on a job in `check`'s needs, so the required check could
// not pass on any run that reached the step (#906). Derived from the shipped
// YAML the way lint-e2e-wiring is, so a new lane inherits the check.
const CI_YML = path.join(import.meta.dirname, "../../.github/workflows/ci.yml");
const PACKAGE_JSON = path.join(import.meta.dirname, "../../package.json");
const REPORT_PATH = "artifacts/test-results/vitest.json";

/**
 * Job name → its executable lines, read by indentation. Jobs sit at 2 spaces and
 * a `- run:` (or a `run: |` block's body) is anything deeper.
 *
 * COMMENTS ARE STRIPPED, and that is the whole correctness of this check. The
 * first draft kept them and passed against the very defect it was written for:
 * `verify`'s header comment contains the words "`bun run coverage` alone at
 * 20m15s", so a check looking for a producer invocation found one in prose. A
 * wiring check that reads commentary is the same class of mistake as the wiring
 * it is checking.
 */
function jobsWithRunLines(source: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of source.split("\n")) {
    const header = /^ {2}(?<name>[\w-]+):\s*$/u.exec(line);
    if (header) {
      const name = header.groups?.["name"];
      if (name === undefined) continue;
      current = name;
      jobs.set(current, []);
      continue;
    }
    const trimmed = line.trim();
    if (!current || trimmed === "" || trimmed.startsWith("#")) continue;
    jobs.get(current)?.push(line);
  }
  return jobs;
}

test("every lane that demands --require-report also runs a script that writes the report", () => {
  const pkg: unknown = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  if (!isRecord(pkg) || !isRecord(pkg.scripts)) {
    throw new Error("package.json scripts missing");
  }
  const scripts = pkg.scripts;
  // The scripts that actually produce the artifact the gate reads.
  const producers = Object.entries(scripts)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .filter(([, body]) => body.includes(`--outputFile=${REPORT_PATH}`))
    .map(([name]) => name);
  assert.ok(
    producers.length > 0,
    `no package script writes ${REPORT_PATH}; the gate would be unpayable everywhere`
  );

  const demanding = [...jobsWithRunLines(readFileSync(CI_YML, "utf8"))].filter(
    ([, lines]) =>
      lines.some(
        (l) =>
          l.includes("test:collection-tripwire") &&
          l.includes("--require-report")
      )
  );
  assert.ok(demanding.length > 0, "no ci.yml job demands --require-report");

  for (const [job, lines] of demanding) {
    const body = lines.join("\n");
    assert.ok(
      producers.some((name) => body.includes(`bun run ${name}`)),
      `ci.yml job \`${job}\` runs the tripwire with --require-report but no step in it runs a script that writes ${REPORT_PATH} (one of: ${producers.join(", ")}). The gate cannot pass there.`
    );
  }
});
