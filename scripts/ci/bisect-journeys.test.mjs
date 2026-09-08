import assert from "node:assert/strict";
import { test } from "node:test";

import { firstSustainedStep } from "./bisect-journeys.mjs";

const point = (sha, deltaMs) => ({
  sha,
  at: `2026-09-0${sha}T00:00:00Z`,
  deltaMs,
  toleranceMs: 10,
  verdict: deltaMs > 10 ? "regressed" : "held",
});

test("the first promotion that cleared the tolerance and stayed is the culprit", () => {
  const { culprit } = firstSustainedStep([
    point("1", 2),
    point("2", 3),
    point("3", 40),
    point("4", 41),
    point("5", 39),
  ]);
  assert.equal(culprit.sha, "3");
});

test("a spike that reverts is a blip, not a culprit", () => {
  const { culprit, blips } = firstSustainedStep([
    point("1", 2),
    point("2", 45),
    point("3", 3),
    point("4", 2),
    point("5", 3),
  ]);
  assert.equal(culprit, null);
  assert.deepEqual(
    blips.map((b) => b.sha),
    ["2"]
  );
});

test("a step at the very end is reported rather than swallowed for want of a window", () => {
  const { culprit } = firstSustainedStep([point("1", 2), point("2", 44)]);
  assert.equal(culprit.sha, "2");
});

test("an all-clean series blames nobody", () => {
  assert.equal(
    firstSustainedStep([point("1", 1), point("2", 2), point("3", 3)]).culprit,
    null
  );
});
