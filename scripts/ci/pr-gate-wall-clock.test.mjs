import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  parseCheckNeeds,
  parseJobsStream,
  renderWallClock,
  selectGateJobs,
  wallClockMs,
} from "./pr-gate-wall-clock.mjs";

const root = path.resolve(import.meta.dirname, "../..");

test("check.needs is read from ci.yml, comments and all", () => {
  const yaml = [
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "  check:",
    "    needs: [",
    "        changes,",
    "        # a comment naming mobile-device-gate",
    "        verify,",
    "        gitleaks,",
    "      ]",
    "    if: always()",
  ].join("\n");
  assert.deepEqual(parseCheckNeeds(yaml), ["changes", "verify", "gitleaks"]);
});

test("the real ci.yml parses to a non-trivial lane list", () => {
  const needs = parseCheckNeeds(
    readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")
  );
  assert.ok(needs.length > 5, `expected several lanes, got ${needs.join(",")}`);
  assert.ok(needs.includes("gitleaks"));
  assert.ok(needs.includes("osv-scanner"));
});

test("parseJobsStream survives a broken line without losing the page", () => {
  const jobs = parseJobsStream(
    ['{"name":"a"}', "not json", '{"name":"b"}', ""].join("\n")
  );
  assert.deepEqual(
    jobs.map((j) => j.name),
    ["a", "b"]
  );
});

test("matrix legs count, skipped lanes and foreign jobs do not", () => {
  const jobs = [
    {
      name: "verify",
      conclusion: "success",
      started_at: "a",
      completed_at: "b",
    },
    {
      name: "mobile-device-gate (paired)",
      conclusion: "success",
      started_at: "a",
      completed_at: "b",
    },
    { name: "docs", conclusion: "skipped" },
    {
      name: "publish-report",
      conclusion: "success",
      started_at: "a",
      completed_at: "b",
    },
    {
      name: "check",
      conclusion: "success",
      started_at: "a",
      completed_at: "b",
    },
  ];
  const picked = selectGateJobs(jobs, [
    "verify",
    "mobile-device-gate",
    "docs",
    "check",
  ]);
  assert.deepEqual(
    picked.map((j) => j.name),
    ["verify", "mobile-device-gate (paired)"]
  );
});

test("wall clock is the span, not the sum", () => {
  const measured = wallClockMs([
    {
      name: "a",
      started_at: "2026-09-02T10:00:00Z",
      completed_at: "2026-09-02T10:10:00Z",
    },
    {
      name: "b",
      started_at: "2026-09-02T10:01:00Z",
      completed_at: "2026-09-02T10:12:00Z",
    },
  ]);
  assert.equal(measured.ms, 12 * 60_000);
  assert.equal(measured.slowest.name, "b");
  assert.equal(wallClockMs([]), null);
});

test("the summary names the budget, the number and the longest lane", () => {
  const report = renderWallClock(
    { ms: 16 * 60_000, slowest: { name: "verify", ms: 15 * 60_000 } },
    15 * 60_000,
    9
  );
  assert.match(report, /16\.0 min of the 15\.0 min budget/u);
  assert.match(report, /OVER/u);
  assert.match(report, /`verify`/u);
});
