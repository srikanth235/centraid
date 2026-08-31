// Spec for `redactedSteps` — what a SENSITIVE chunk may say about its own
// failure (#905). `node --test`, run by `scripts:test`.
//
// The chunk this guards runs with a live enrollment capability in its argv, so
// it used to run `stdio: "ignore"`: the capability stayed out of the log
// because everything did. The cost landed on `pairing-canary`, the PR gate's
// short-circuiting prerequisite — it failed twice in four runs, at 73s and at
// 125s, two different sub-failures, and both reported only
// `maestro sensitive flow exited 1`.
//
// So output is captured and, on failure only, filtered to Maestro's step lines
// with every secret replaced. These cases pin the property that makes that
// safe: NO input carrying a capability may produce an output carrying it,
// whichever of the two controls one imagines failing.

import assert from "node:assert/strict";
import { test } from "node:test";

import { redactedSteps } from "./spawn.mjs";

const TICKET = "ctk_live_9f2a4c8e1b7d3a6f5e0c";

test("redactedSteps keeps the step lines that name the failed directive", () => {
  const steps = redactedSteps(
    [
      'Tap on "Paste the one-line ticket"... COMPLETED',
      "Hide Keyboard... COMPLETED",
      'Assert that "Who.s using this phone[?]" is visible... FAILED',
    ].join("\n")
  );
  assert.equal(steps.length, 3);
  assert.match(steps[2], /FAILED/u);
});

test("redactedSteps drops everything that is not a step line", () => {
  const steps = redactedSteps(
    [
      "Running on emulator-5554",
      `Env: MAESTRO_PAIRING_TICKET=${TICKET}`,
      "Launch app... COMPLETED",
    ].join("\n")
  );
  assert.deepEqual(steps, ["Launch app... COMPLETED"]);
  assert.ok(!steps.join("\n").includes(TICKET));
});

// The second control, exercised on its own: even a line that PASSES the
// step-line filter cannot carry a secret through.
test("redactedSteps redacts a secret that reaches a step line anyway", () => {
  const steps = redactedSteps(`Input text ${TICKET}... COMPLETED`, [TICKET]);
  assert.deepEqual(steps, ["Input text «redacted»... COMPLETED"]);
  assert.ok(!steps.join("\n").includes(TICKET));
});

test("redactedSteps redacts every secret it is given, not just the first", () => {
  const other = "tok_second_value";
  const steps = redactedSteps(`Input text ${TICKET} then ${other}... FAILED`, [
    TICKET,
    other,
  ]);
  assert.ok(!steps.join("\n").includes(TICKET));
  assert.ok(!steps.join("\n").includes(other));
});

// `maestroEnv` is spread from an object, so an empty or absent value is
// reachable. Replacing on "" would splice the marker between every character.
test("redactedSteps ignores empty and non-string secrets", () => {
  const steps = redactedSteps("Launch app... COMPLETED", [
    "",
    undefined,
    null,
    7,
  ]);
  assert.deepEqual(steps, ["Launch app... COMPLETED"]);
});

test("redactedSteps bounds the output so a failure cannot become a dump", () => {
  const many = Array.from(
    { length: 40 },
    (_, index) => `Step ${index}... COMPLETED`
  ).join("\n");
  const steps = redactedSteps(many);
  assert.equal(steps.length, 12);
  // The TAIL, because the failure is at the end.
  assert.equal(steps.at(-1), "Step 39... COMPLETED");
});

test("redactedSteps says nothing when no line is in step-line shape", () => {
  assert.deepEqual(
    redactedSteps("java.lang.Exception: boom\n  at Foo.bar"),
    []
  );
});
