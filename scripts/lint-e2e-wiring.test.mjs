// Unit spec for the mobile e2e wiring linter (#890 W0).
//
// The rule engine has its own `selfTest()` that runs on every invocation, which
// is what stops the rules rotting into always-passing. This file covers the
// half that self-test cannot: the parsers that read the SHIPPED tree, and the
// invariants that must hold against the real repo. A rule engine that is
// perfect over fixtures and blind to the actual YAML is exactly the shape of
// gate this linter exists to catch.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  directInvocations,
  discoverFlows,
  discoverRunners,
  isRunnerPath,
  jobBlock,
  matrixMobileOwners,
  runnerMembers,
  stripComments,
} from "./lint-e2e-wiring.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("jobBlock returns exactly one job's body, not the next job's", () => {
  const yaml = [
    "jobs:",
    "  first:",
    "    steps:",
    "      - run: node tests/agent-e2e-mobile/flows/a.mjs",
    "  second:",
    "    steps:",
    "      - run: node tests/agent-e2e-mobile/flows/b.mjs",
  ].join("\n");
  const block = jobBlock(yaml, "first");
  assert.ok(block.includes("a.mjs"));
  assert.ok(!block.includes("b.mjs"));
  assert.equal(jobBlock(yaml, "absent"), null);
});

test("jobBlock reads the LAST job, which has no following key to stop at", () => {
  const yaml = ["jobs:", "  only:", "    steps:", "      - run: echo hi"].join(
    "\n"
  );
  assert.ok(jobBlock(yaml, "only").includes("echo hi"));
});

test("a commented-out invocation is not an invocation", () => {
  const chunk = [
    "      # node tests/agent-e2e-mobile/flows/retired.mjs",
    "      - run: node tests/agent-e2e-mobile/flows/live.mjs",
  ].join("\n");
  assert.deepEqual(directInvocations(chunk), [
    "tests/agent-e2e-mobile/flows/live.mjs",
  ]);
});

test("stripComments keeps the code half of a trailing-comment line", () => {
  assert.equal(stripComments("run: node x.mjs # why"), "run: node x.mjs ");
});

test("only run-*.mjs at the directory root counts as a suite runner", () => {
  assert.equal(
    isRunnerPath("tests/agent-e2e-mobile/run-photos-suite.mjs"),
    true
  );
  // Machinery a lane legitimately node-runs, which owes no FLOWS array.
  assert.equal(
    isRunnerPath("tests/agent-e2e-mobile/lib/ci-gateway.mjs"),
    false
  );
  assert.equal(
    isRunnerPath("tests/agent-e2e-mobile/flows/home-loads.mjs"),
    false
  );
});

test("runnerMembers is not defeated by a header comment about itself", () => {
  // The regression this pins: the unanchored regex matched the prose in a
  // runner's own header explaining that the linter reads its array, took the
  // ellipsis as the body, and reported the runner as scheduling nothing.
  const source = [
    "// the wiring linter reads this runner's `const FLOWS = [ … ]` array",
    'const FLOWS = ["a.mjs", "b.mjs"];',
  ].join("\n");
  assert.deepEqual(runnerMembers(source, "r.mjs"), [
    "tests/agent-e2e-mobile/flows/a.mjs",
    "tests/agent-e2e-mobile/flows/b.mjs",
  ]);
});

test("a runner with no readable FLOWS array throws rather than scheduling nothing", () => {
  // Silently returning an empty list would unschedule every member of that
  // suite while the linter reported clean — the exact failure it exists for.
  assert.throws(() => runnerMembers("const OTHER = [];", "r.mjs"), /FLOWS/u);
  assert.throws(() => runnerMembers("const FLOWS = [];", "r.mjs"), /empty/u);
});

test("matrixMobileOwners walks structurally and reports every citing path", () => {
  const owners = matrixMobileOwners({
    flows: [{ owner: "tests/agent-e2e-mobile/flows/x.mjs" }],
    appSeats: {
      apps: [
        {
          seats: { origin: { owner: "tests/agent-e2e-mobile/flows/x.mjs" } },
        },
      ],
    },
    demonstratedRed: {
      G: { command: "node tests/agent-e2e-mobile/flows/y.mjs" },
    },
    // A non-owner string naming the same path must NOT be collected — a note
    // mentioning a flow is prose, not a claim of coverage.
    notes: { thing: "see tests/agent-e2e-mobile/flows/z.mjs" },
  });
  assert.deepEqual([...owners.keys()].sort(), [
    "tests/agent-e2e-mobile/flows/x.mjs",
    "tests/agent-e2e-mobile/flows/y.mjs",
  ]);
  assert.equal(owners.get("tests/agent-e2e-mobile/flows/x.mjs").length, 2);
});

test("discovery finds the real roster and excludes sibling test files", () => {
  const flows = discoverFlows();
  assert.ok(flows.length > 10, "the committed roster should not be near-empty");
  assert.ok(flows.every((rel) => !rel.endsWith(".test.mjs")));
  assert.ok(flows.includes("tests/agent-e2e-mobile/flows/home-loads.mjs"));
  const runners = discoverRunners();
  assert.ok(runners.every(isRunnerPath));
  assert.ok(runners.includes("tests/agent-e2e-mobile/run-photos-suite.mjs"));
});

test("every lane the committed roster declares names a job that exists", () => {
  // The roster is a declaration; this is the cheapest place to catch a lane
  // pointing at a renamed or deleted job, because the linter's own lane rule
  // would report it as "no lane runs anything" — true, but not the cause.
  const roster = JSON.parse(read("tests/agent-e2e-mobile/roster.json"));
  const laneIds = Object.keys(roster.lanes);
  assert.ok(laneIds.length >= 2);
  for (const [id, lane] of Object.entries(roster.lanes)) {
    assert.ok(
      jobBlock(read(lane.workflow), lane.job) != null,
      `lane ${id} names ${lane.workflow}#${lane.job}, which does not exist`
    );
    assert.ok(typeof lane.blocking === "boolean", `lane ${id} needs blocking`);
    assert.ok(lane.why?.length > 30, `lane ${id} needs a why`);
  }
  // Exactly one blocking mobile device lane: the PR gate. A second one would
  // double the merge-path cost without anybody deciding to spend it.
  const blocking = laneIds.filter((id) => roster.lanes[id].blocking);
  assert.deepEqual(blocking, ["pr-gate-android"]);
});
