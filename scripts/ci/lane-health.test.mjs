import assert from "node:assert/strict";
import test from "node:test";

import {
  chronicRed,
  firstAttemptRates,
  redStreaks,
  renderLaneHealth,
} from "./lane-health.mjs";

const run = (runAttempt, startedAt, jobs) => ({ runAttempt, startedAt, jobs });
const job = (name, conclusion) => ({ name, conclusion });

test("only FIRST attempts count — a green third try is not a healthy lane", () => {
  const rates = firstAttemptRates([
    run(1, "2026-08-30T00:00:00Z", [job("verify", "failure")]),
    run(2, "2026-08-30T01:00:00Z", [job("verify", "success")]),
    run(3, "2026-08-30T02:00:00Z", [job("verify", "success")]),
  ]);
  assert.equal(rates.get("verify").attempts, 1);
  assert.equal(rates.get("verify").rate, 0);
});

test("a skipped path-gated lane has no opinion about its own health", () => {
  const rates = firstAttemptRates([
    run(1, "2026-08-30T00:00:00Z", [
      job("docs", "skipped"),
      job("verify", "success"),
    ]),
    run(1, "2026-08-30T01:00:00Z", [
      job("docs", "success"),
      job("verify", "success"),
    ]),
  ]);
  assert.equal(rates.get("docs").attempts, 1);
  assert.equal(rates.get("verify").attempts, 2);
});

test("the rate is passed over attempted, and an empty tally cannot divide by zero", () => {
  const rates = firstAttemptRates([
    run(1, "2026-08-30T00:00:00Z", [job("a", "success")]),
    run(1, "2026-08-30T01:00:00Z", [job("a", "failure")]),
  ]);
  assert.equal(rates.get("a").rate, 0.5);
  assert.equal(firstAttemptRates([]).size, 0);
});

test("a streak stops at the lane's most recent success", () => {
  // Newest first. `a` is green now, so however bad last week was it is not
  // chronically red today; `b` has never recovered.
  const streaks = redStreaks(
    [
      run(1, "2026-08-31T00:00:00Z", [
        job("a", "success"),
        job("b", "failure"),
      ]),
      run(1, "2026-08-30T00:00:00Z", [
        job("a", "failure"),
        job("b", "failure"),
      ]),
      run(1, "2026-08-29T00:00:00Z", [
        job("a", "failure"),
        job("b", "failure"),
      ]),
    ],
    "2026-08-31T12:00:00Z"
  );
  assert.equal(streaks.has("a"), false);
  assert.equal(streaks.get("b").runs, 3);
  assert.equal(streaks.get("b").since, "2026-08-29T00:00:00Z");
  assert.equal(streaks.get("b").days, 2.5);
});

test("chronicRed fires past the threshold and not before", () => {
  const streaks = new Map([
    ["b", { since: "2026-08-29T00:00:00Z", days: 2.5, runs: 3 }],
  ]);
  assert.deepEqual(chronicRed(streaks, {}, 3, "2026-08-31"), []);
  const offenders = chronicRed(streaks, {}, 2, "2026-08-31");
  assert.equal(offenders.length, 1);
  assert.equal(offenders[0].reason, "not quarantined");
});

test("an unexpired quarantine parks a lane; an EXPIRED one does not", () => {
  const streaks = new Map([
    ["b", { since: "2026-08-29T00:00:00Z", days: 5, runs: 9 }],
  ]);
  assert.deepEqual(
    chronicRed(
      streaks,
      { b: { expires: "2026-12-01", issue: "#1", why: "x" } },
      3,
      "2026-08-31"
    ),
    []
  );
  const expired = chronicRed(
    streaks,
    { b: { expires: "2026-08-01", issue: "#1", why: "x" } },
    3,
    "2026-08-31"
  );
  assert.equal(expired.length, 1);
  assert.match(expired[0].reason, /which has passed/u);
});

test("a quarantine entry with no expiry is a mute, and is refused", () => {
  const streaks = new Map([
    ["b", { since: "2026-08-01T00:00:00Z", days: 30, runs: 30 }],
  ]);
  assert.equal(
    chronicRed(streaks, { b: { issue: "#1", why: "x" } }, 3, "2026-08-31")
      .length,
    1
  );
});

test("the rendered table flags lanes under the floor and is sorted worst-first", () => {
  const rates = new Map([
    ["healthy", { attempts: 20, passed: 20, rate: 1 }],
    ["flaky", { attempts: 20, passed: 16, rate: 0.8 }],
  ]);
  const report = renderLaneHealth(rates, new Map(), 0.95);
  assert.ok(report.indexOf("`flaky`") < report.indexOf("`healthy`"));
  assert.match(report, /80% ⚠️/u);
  assert.match(report, /teaches people to press re-run/u);
});
