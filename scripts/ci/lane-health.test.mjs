import assert from "node:assert/strict";
import test from "node:test";

import {
  chronicRed,
  firstAttemptRates,
  redStreaks,
  renderFindings,
  renderLaneHealth,
} from "./lane-health.mjs";
import {
  RUNG_BUDGET_MS,
  WORKFLOW_RUNG,
  applyLaneRules,
  countEscapes,
  greenShas,
  laneDurations,
  overallVerdict,
  percentile,
} from "./lane-rules.mjs";

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

test("percentile is nearest-rank over the runs that happened", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
});

test("laneDurations reads each job's own span and skips unfinished jobs", () => {
  const durations = laneDurations([
    {
      jobs: [
        {
          name: "verify",
          startedAt: "2026-09-01T10:00:00Z",
          completedAt: "2026-09-01T10:20:00Z",
        },
        { name: "docs", startedAt: "2026-09-01T10:00:00Z" },
      ],
    },
  ]);
  assert.deepEqual(durations.get("verify"), [20 * 60_000]);
  assert.equal(durations.has("docs"), false);
});

test("greenShas admits skipped lanes and refuses any failure", () => {
  const green = greenShas([
    { headSha: "a", jobs: [job("x", "success"), job("y", "skipped")] },
    { headSha: "b", jobs: [job("x", "failure")] },
  ]);
  assert.deepEqual([...green], ["a"]);
});

test("an escape is a deep red on a SHA the merge gate called green", () => {
  const escapes = countEscapes(
    [
      { headSha: "a", jobs: [job("mobile-e2e-ios", "failure")] },
      { headSha: "b", jobs: [job("mobile-e2e-ios", "failure")] },
      { headSha: "a", jobs: [job("web-e2e", "success")] },
    ],
    new Set(["a"])
  );
  assert.equal(escapes.get("mobile-e2e-ios"), 1);
  assert.equal(escapes.has("web-e2e"), false);
});

const rules = (overrides) =>
  applyLaneRules({
    rates: new Map(),
    streaks: new Map(),
    durations: new Map(),
    escapes: new Map(),
    quarantine: {},
    rung: 2,
    today: "2026-09-02",
    ...overrides,
  });

test("a rung-2 lane below 99% is demoted, and a rung-3 lane is not", () => {
  const rates = new Map([
    ["verify", { attempts: 100, passed: 98, rate: 0.98 }],
  ]);
  const demote = rules({ rates }).filter((f) => f.kind === "demote");
  assert.equal(demote.length, 1);
  assert.equal(demote[0].title, "[lanes] demote verify");
  assert.deepEqual(
    rules({ rates, rung: 3 }).filter((f) => f.kind === "demote"),
    []
  );
});

test("two escapes in the window ask for a promotion, one does not", () => {
  assert.equal(
    rules({ escapes: new Map([["desktop-e2e", 1]]) }).filter(
      (f) => f.kind === "promote"
    ).length,
    0
  );
  const promote = rules({ escapes: new Map([["desktop-e2e", 2]]) }).find(
    (f) => f.kind === "promote"
  );
  assert.equal(promote.title, "[lanes] promote desktop-e2e");
});

test("three consecutive reds demand a park; a live park satisfies the rule", () => {
  const streaks = new Map([
    ["mobile-e2e-ios", { days: 3, runs: 3, since: "2026-08-30T00:00:00Z" }],
  ]);
  assert.equal(
    rules({ streaks }).filter((f) => f.kind === "park-required").length,
    1
  );
  assert.equal(
    rules({
      streaks,
      quarantine: { "mobile-e2e-ios": { issue: 870, expires: "2026-09-16" } },
    }).filter((f) => f.kind === "park-required").length,
    0
  );
  assert.equal(
    rules({
      streaks: new Map([
        ["x", { days: 1, runs: 2, since: "2026-09-01T00:00:00Z" }],
      ]),
    }).filter((f) => f.kind === "park-required").length,
    0
  );
});

test("an expired park counts as red again and says which date passed", () => {
  const findings = rules({
    quarantine: { "mobile-e2e-ios": { issue: 870, expires: "2026-08-01" } },
  }).filter((f) => f.kind === "park-expired");
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /expired on 2026-08-01/u);
});

test("a lane over its rung budget is red with the number to cut to", () => {
  const findings = rules({
    durations: new Map([["verify", [20 * 60_000, 20 * 60_000]]]),
  }).filter((f) => f.kind === "over-budget");
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /Cut 5\.0 min/u);
  assert.equal(
    rules({ durations: new Map([["verify", [10 * 60_000]]]) }).filter(
      (f) => f.kind === "over-budget"
    ).length,
    0
  );
});

test("the rung budgets are the ladder's, in minutes", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(RUNG_BUDGET_MS).map(([k, v]) => [k, v / 60_000])
    ),
    { 2: 15, 3: 45, 4: 90, 5: 300 }
  );
  assert.equal(WORKFLOW_RUNG["candidate.yml"], 3);
});

test("more than three live parks, or a park too far out, is a HOLD", () => {
  assert.deepEqual(overallVerdict({}, "2026-09-02").verdict, "OK");
  const many = {
    a: { expires: "2026-09-16" },
    b: { expires: "2026-09-16" },
    c: { expires: "2026-09-16" },
    d: { expires: "2026-09-16" },
  };
  const hold = overallVerdict(many, "2026-09-02");
  assert.equal(hold.verdict, "HOLD");
  assert.match(hold.reasons[0], /4 lanes are parked/u);
  const far = overallVerdict(
    { a: { expires: "2026-12-31" } },
    "2026-09-02",
    []
  );
  assert.equal(far.verdict, "HOLD");
  assert.match(far.reasons[0], /no park may exceed 30 days/u);
});

test("an expired park is a HOLD reason as well as a lane finding", () => {
  const verdict = overallVerdict(
    { a: { expires: "2026-08-01" } },
    "2026-09-02"
  );
  assert.equal(verdict.verdict, "HOLD");
  assert.match(verdict.reasons[0], /expired 32 day\(s\) ago/u);
});

test("renderFindings names the verdict and every rule that fired", () => {
  const report = renderFindings(
    [{ lane: "verify", kind: "demote", title: "t", detail: "d" }],
    { verdict: "HOLD", reasons: ["too many parks"] },
    2
  );
  assert.match(report, /verdict HOLD/u);
  assert.match(report, /HOLD: too many parks/u);
  assert.match(report, /`verify` \| demote/u);
  assert.match(
    renderFindings([], { verdict: "OK", reasons: [] }, 3),
    /No rule fired/u
  );
});
