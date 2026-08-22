import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { findCollectionErrors } from "./collection-tripwire.mjs";

const SCRIPT = path.join(import.meta.dirname, "collection-tripwire.mjs");
const FIXTURES = path.join(import.meta.dirname, "fixtures");

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
function load(fixture) {
  return JSON.parse(readFileSync(fixture, "utf8"));
}

/** Run the gate CLI over a report path. */
function runGate(reportPath, ...extra) {
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
  assert.match(
    verdict.offenders[0].file,
    /node-sqlite-driver\.jsdom\.test\.ts$/u
  );
  assert.match(
    verdict.offenders[0].message,
    /Cannot bundle Node\.js built-in/u
  );
  assert.match(verdict.errors[0], /collected 0 tests/u);
});

test("an ordinary failing test is not reported as a collection error", () => {
  const report = load(HEALTHY);
  report.testResults[0].status = "failed";
  report.testResults[0].assertionResults[0].status = "failed";
  report.testResults[0].assertionResults[0].failureMessages = ["expected 1"];
  const verdict = findCollectionErrors(report);
  assert.equal(
    verdict.ok,
    true,
    "real reds belong to the suite, not this gate"
  );
});

test("a wholly skipped file is not reported as a collection error", () => {
  const report = load(HEALTHY);
  report.testResults[0].status = "skipped";
  report.testResults[0].assertionResults[0].status = "skipped";
  const verdict = findCollectionErrors(report);
  assert.equal(verdict.ok, true);
});

test("a message-less failed empty file is still flagged", () => {
  const report = load(COLLECTION_ERROR);
  report.testResults[0].message = "";
  const verdict = findCollectionErrors(report);
  assert.equal(verdict.ok, false);
  assert.match(verdict.offenders[0].message, /no message recorded/u);
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
