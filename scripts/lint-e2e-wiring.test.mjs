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
  invocationSelector,
  runnerMembers,
  shimSelector,
  stateVarietyProblems,
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
  assert.deepEqual(
    directInvocations(chunk).map((hit) => hit.target),
    ["tests/agent-e2e-mobile/flows/live.mjs"]
  );
});

test("an invocation carries the whole line, because the flags are the wiring", () => {
  const [hit] = directInvocations(
    "      - run: node tests/agent-e2e-mobile/run-roster.mjs --rung 4 --platform android"
  );
  assert.deepEqual(invocationSelector(hit.line), {
    rung: 4,
    platform: "android",
  });
});

test("stripComments keeps the code half of a trailing-comment line", () => {
  assert.equal(stripComments("run: node x.mjs # why"), "run: node x.mjs ");
});

test("only run-*.mjs at the directory root counts as a suite runner", () => {
  assert.equal(
    isRunnerPath("tests/agent-e2e-mobile/run-photos-suite.mjs"),
    true
  );
  assert.equal(
    isRunnerPath("tests/agent-e2e-mobile/lib/ci-gateway.mjs"),
    false
  );
  assert.equal(
    isRunnerPath("tests/agent-e2e-mobile/flows/home-loads.mjs"),
    false
  );
});

test("shimSelector is not defeated by a header comment about itself", () => {
  const source = [
    "// the wiring linter reads this shim's `resolvePlan({ rung, platform, suite })` call",
    "process.exitCode = await runPlan(",
    '  resolvePlan({ rung: 2, platform: "android", suite: "pr-gate" })',
    ");",
  ].join("\n");
  assert.deepEqual(shimSelector(source), {
    rung: 2,
    platform: "android",
    suite: "pr-gate",
  });
});

test("a runner with no readable selector throws rather than scheduling nothing", () => {
  assert.throws(
    () => runnerMembers("const OTHER = [];", "r.mjs", ""),
    /selector/u
  );
});

test("a shim naming a suite the roster does not declare throws", () => {
  assert.throws(
    () =>
      runnerMembers(
        'resolvePlan({ rung: 2, platform: "android", suite: "ghost" })',
        "r.mjs",
        ""
      ),
    /does not declare/u
  );
});

test("state variety may not be owned by a device flow", () => {
  assert.equal(
    stateVarietyProblems({
      appStates: {
        apps: [
          {
            id: "notes",
            states: {
              dayone: {
                owner: "packages/blueprints/apps/notes/states.test.tsx",
              },
            },
          },
        ],
      },
    }).length,
    0
  );
  const problems = stateVarietyProblems({
    appStates: {
      apps: [
        {
          id: "notes",
          states: {
            offline: {
              owner: "tests/agent-e2e-mobile/flows/notes-library.mjs",
            },
          },
        },
      ],
    },
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /tests\/integration-mobile/u);
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
  assert.ok(runners.includes("tests/agent-e2e-mobile/run-roster.mjs"));
});

test("every lane the committed roster declares names a job that exists", () => {
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
  const blocking = laneIds.filter((id) => roster.lanes[id].blocking);
  assert.deepEqual(blocking, ["pr-gate-android"]);
});
