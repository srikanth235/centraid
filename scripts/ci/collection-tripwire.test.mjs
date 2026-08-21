import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findCollectionErrors } from "./collection-tripwire.mjs";

const SCRIPT = path.join(import.meta.dirname, "collection-tripwire.mjs");

/**
 * A vitest JSON report for one file that loaded and passed.
 *
 * Both fixtures are transcribed from real reports produced by
 * `vitest run --reporter=json` against
 * `apps/mobile/src/lib/replica/node-sqlite-driver.jsdom.test.ts`, healthy and
 * with the node:sqlite externalization plugin removed from the test-kit node
 * preset — the exact defect that killed
 * `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx` (#842).
 */
function healthyReport() {
  return {
    numTotalTests: 1,
    numPassedTests: 1,
    success: true,
    testResults: [
      {
        assertionResults: [
          {
            ancestorTitles: ["node:sqlite driver under a jsdom docblock"],
            fullName: "round-trips rows",
            status: "passed",
            title: "round-trips rows",
            duration: 4.3,
            failureMessages: [],
          },
        ],
        startTime: 1787327214680,
        endTime: 1787327214684,
        status: "passed",
        message: "",
        name: "/repo/apps/mobile/src/lib/replica/node-sqlite-driver.jsdom.test.ts",
      },
    ],
  };
}

/** The same file after it fails to load: failed, zero assertions, a message. */
function collectionErrorReport() {
  return {
    numTotalTests: 0,
    numPassedTests: 0,
    success: false,
    testResults: [
      {
        assertionResults: [],
        startTime: 1787327225183,
        endTime: 1787327225183,
        status: "failed",
        message:
          'Cannot bundle Node.js built-in "node:sqlite" imported from "src/lib/replica/node-sqlite-driver.ts". Consider disabling environments.client.noExternal or remove the built-in dependency.\n\nStack backtrace:\n   0: <unknown>',
        name: "/repo/apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx",
      },
    ],
  };
}

/** Write a report to a scratch file and return its path. */
function writeReport(report) {
  const dir = mkdtempSync(path.join(tmpdir(), "collection-tripwire-"));
  const file = path.join(dir, "vitest.json");
  writeFileSync(file, JSON.stringify(report));
  return file;
}

/** Run the gate CLI over a report path. */
function runGate(reportPath, ...extra) {
  return spawnSync(
    process.execPath,
    [SCRIPT, "--report", reportPath, ...extra],
    { encoding: "utf8" }
  );
}

test("a healthy report has no collection errors", () => {
  const verdict = findCollectionErrors(healthyReport());
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.offenders, []);
});

test("a file that failed with zero assertions is a collection error", () => {
  const verdict = findCollectionErrors(collectionErrorReport());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.offenders.length, 1);
  assert.match(verdict.offenders[0].file, /PendingRestartJourney\.test\.tsx$/u);
  assert.match(verdict.offenders[0].message, /Cannot bundle Node\.js built-in/u);
  assert.match(verdict.errors[0], /collected 0 tests/u);
});

test("an ordinary failing test is not reported as a collection error", () => {
  const report = healthyReport();
  report.testResults[0].status = "failed";
  report.testResults[0].assertionResults[0].status = "failed";
  report.testResults[0].assertionResults[0].failureMessages = ["expected 1"];
  const verdict = findCollectionErrors(report);
  assert.equal(verdict.ok, true, "real reds belong to the suite, not this gate");
});

test("a wholly skipped file is not reported as a collection error", () => {
  const report = healthyReport();
  report.testResults[0].status = "skipped";
  report.testResults[0].assertionResults[0].status = "skipped";
  const verdict = findCollectionErrors(report);
  assert.equal(verdict.ok, true);
});

test("a message-less failed empty file is still flagged", () => {
  const report = collectionErrorReport();
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

test("the CLI exits 0 on a healthy report", () => {
  const run = runGate(writeReport(healthyReport()));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /every reported file collected at least one test/u);
});

test("the CLI exits 1 on a report carrying a collection error", () => {
  const run = runGate(writeReport(collectionErrorReport()));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /PendingRestartJourney\.test\.tsx collected 0 tests/u);
});

test("a missing report is 'not measured' locally and fatal under --require-report", () => {
  const absent = path.join(tmpdir(), "collection-tripwire-absent", "vitest.json");
  const quiet = runGate(absent);
  assert.equal(quiet.status, 0);
  assert.match(quiet.stdout, /not measured/u);

  const strict = runGate(absent, "--require-report");
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /is missing, so no file could be scored/u);
});
