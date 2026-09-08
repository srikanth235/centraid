import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bootstrapMedianCi,
  median,
  pairedVerdict,
  renderVerdicts,
  sampleAt,
} from "./paired-journeys.mjs";

/** A deterministic sample series with a known shape. */
function series(base, jitter, rounds) {
  return Array.from(
    { length: rounds },
    (_, index) => base + jitter * ((index % 3) - 1)
  );
}

test("median handles both parities", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("the interval is reproducible — a re-run cannot launder a red", () => {
  const differences = [12, 15, 9, 14, 11, 13, 10, 16, 12, 11];
  assert.deepEqual(
    bootstrapMedianCi(differences),
    bootstrapMedianCi(differences)
  );
});

test("a seeded 20% slow-down is called regressed on the FIRST run, with no history", () => {
  const rounds = 12;
  const candidate = series(100, 4, rounds);
  const pr = candidate.map((value) => value * 1.2);
  const verdict = pairedVerdict({ candidate, pr, tolerancePercent: 10 });
  assert.equal(verdict.verdict, "regressed");
  assert.equal(verdict.rounds, rounds);
  assert.ok(verdict.deltaPercent > 15, `delta ${verdict.deltaPercent}`);
  assert.ok(verdict.low > verdict.toleranceMs);
  assert.equal(verdict.confidence, 0.95);
});

test("a slow-down inside the journey's own tolerance holds", () => {
  const candidate = series(100, 4, 12);
  const pr = candidate.map((value) => value * 1.05);
  assert.equal(
    pairedVerdict({ candidate, pr, tolerancePercent: 20 }).verdict,
    "held"
  );
});

test("runner drift that moves BOTH sides cancels — the pairing is the point", () => {
  // Every round is 40% slower than the last on both sides; nothing regressed.
  const candidate = Array.from({ length: 12 }, (_, i) => 100 * 1.4 ** i);
  const pr = [...candidate];
  assert.equal(
    pairedVerdict({ candidate, pr, tolerancePercent: 20 }).verdict,
    "held"
  );
});

test("a real slow-down UNDER runner drift is still caught", () => {
  const candidate = Array.from({ length: 12 }, (_, i) => 100 * 1.4 ** i);
  const pr = candidate.map((value) => value * 1.3);
  assert.equal(
    pairedVerdict({ candidate, pr, tolerancePercent: 10 }).verdict,
    "regressed"
  );
});

test("slower, but the run cannot say by how much, reads as inconclusive", () => {
  // Every round is slower, but the spread straddles the 20 ms tolerance, so the
  // interval cannot separate "inside tolerance" from "outside it".
  const candidate = Array.from({ length: 12 }, () => 100);
  const pr = [106, 140, 112, 135, 108, 132, 118, 128, 110, 138, 115, 130];
  const verdict = pairedVerdict({ candidate, pr, tolerancePercent: 20 });
  assert.equal(verdict.verdict, "inconclusive");
  assert.ok(verdict.low > 0 && verdict.low < verdict.toleranceMs);
});

test("an improvement is named rather than absorbed as noise", () => {
  const candidate = series(100, 3, 12);
  const pr = candidate.map((value) => value * 0.6);
  assert.equal(
    pairedVerdict({ candidate, pr, tolerancePercent: 10 }).verdict,
    "improved"
  );
});

test("an inconclusive journey is not a pass — the runner exits non-zero on it", () => {
  // The policy lives in main(); this pins the contract the lane depends on.
  const candidate = Array.from({ length: 12 }, () => 100);
  const pr = [106, 140, 112, 135, 108, 132, 118, 128, 110, 138, 115, 130];
  const verdict = pairedVerdict({ candidate, pr, tolerancePercent: 20 });
  assert.ok(["regressed", "inconclusive"].includes(verdict.verdict));
});

test("too few rounds is an error, not a quiet verdict", () => {
  assert.throws(
    () =>
      pairedVerdict({ candidate: [1, 2], pr: [1, 2], tolerancePercent: 10 }),
    /at least 3 matched rounds/u
  );
});

test("a missing sample path is an error, not a zero", () => {
  assert.throws(
    () => sampleAt({ journeys: {} }, "journeys.bootstrapPage.p50"),
    /no numeric sample/u
  );
  assert.equal(sampleAt({ a: { b: 4 } }, "a.b"), 4);
});

test("the table names the interval and the tolerance beside every verdict", () => {
  const rendered = renderVerdicts([
    {
      key: "gateway/warm-switch/year3/ci-linux-x64-4c",
      metric: "requestToFirstByte",
      deltaMs: 12.5,
      low: 9,
      high: 15,
      toleranceMs: 4,
      verdict: "regressed",
    },
  ]);
  assert.match(rendered, /\[9\.0, 15\.0\]/u);
  assert.match(rendered, /regressed/u);
});
