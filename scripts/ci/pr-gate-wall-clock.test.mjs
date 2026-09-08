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

test("overlapping lanes collapse into one interval, so parallelism is not punished", () => {
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
  // Not 21 minutes (the sum): the two lanes overlapped, and the gate was busy
  // for 12 of the 12 elapsed minutes.
  assert.equal(measured.ms, 12 * 60_000);
  assert.equal(measured.spanMs, 12 * 60_000);
  assert.equal(measured.queuedMs, 0);
  assert.equal(measured.slowest.name, "b");
  assert.equal(wallClockMs([]), null);
});

test("queue wait alone cannot blow the budget (#931 item 6)", () => {
  // The #937 shape: every lane's own work is short, but the shards waited for a
  // runner and the elapsed span crossed the ceiling. 14 minutes of work sitting
  // inside a 26-minute span, against a 15-minute budget.
  const budgetMs = 15 * 60_000;
  const jobs = [
    {
      name: "verify",
      started_at: "2026-09-02T10:00:00Z",
      completed_at: "2026-09-02T10:07:00Z",
    },
    {
      name: "coverage-shard (1)",
      started_at: "2026-09-02T10:19:00Z",
      completed_at: "2026-09-02T10:26:00Z",
    },
  ];
  const measured = wallClockMs(jobs);
  assert.equal(measured.spanMs, 26 * 60_000);
  assert.ok(
    measured.spanMs > budgetMs,
    "the fixture must be one the old span metric would have failed"
  );
  assert.equal(measured.ms, 14 * 60_000);
  assert.equal(measured.queuedMs, 12 * 60_000);
  assert.ok(measured.ms <= budgetMs, "the gate's own work is inside budget");
});

test("a lane still running while another queues is work, not queue", () => {
  // No idle gap: `slow` covers the whole span, so nothing is subtracted and a
  // genuinely slow gate is still charged for every minute of it.
  const measured = wallClockMs([
    {
      name: "slow",
      started_at: "2026-09-02T10:00:00Z",
      completed_at: "2026-09-02T10:20:00Z",
    },
    {
      name: "queued",
      started_at: "2026-09-02T10:18:00Z",
      completed_at: "2026-09-02T10:19:00Z",
    },
  ]);
  assert.equal(measured.ms, 20 * 60_000);
  assert.equal(measured.queuedMs, 0);
});

test("the summary names the budget, the number, the longest lane and the queue", () => {
  const report = renderWallClock(
    {
      ms: 16 * 60_000,
      spanMs: 20 * 60_000,
      queuedMs: 4 * 60_000,
      slowest: { name: "verify", ms: 15 * 60_000 },
    },
    15 * 60_000,
    9
  );
  assert.match(report, /16\.0 min of the 15\.0 min budget/u);
  assert.match(report, /OVER/u);
  assert.match(report, /`verify`/u);
  assert.match(report, /4\.0 min was runner queue/u);
});
