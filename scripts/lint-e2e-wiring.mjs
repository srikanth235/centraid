#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { validateRoster } from "../tests/agent-e2e-mobile/lib/roster.mjs";
import { wiringSelfTestCases } from "./lint-e2e-wiring.cases.mjs";
import {
  discoverFlows,
  discoverRunners,
  resolveReach,
} from "./lint-e2e-wiring.reach.mjs";
import {
  corpusProblems,
  discoverApps,
  LANE_PREAMBLE,
  SEEDER,
  stateVarietyProblems,
} from "./lint-e2e-wiring.rules.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_DIR = "tests/agent-e2e-mobile";
const FLOWS_DIR = `${MOBILE_DIR}/flows`;
const ROSTER_PATH = `${MOBILE_DIR}/roster.json`;
const CLAIMS_PATH = "tests/claims.json";
const MATRIX_PATH = "tests/matrix.json";
const DERIVE_FLOWS = "scripts/test-report/derive-flows.mjs";

export {
  directInvocations,
  discoverFlows,
  discoverRunners,
  invocationSelector,
  isRunnerPath,
  jobBlock,
  resolveReach,
  runnerMembers,
  shimSelector,
  stripComments,
} from "./lint-e2e-wiring.reach.mjs";

export function matrixMobileOwners(matrix) {
  const owners = new Map();
  const walk = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${trail}[${index}]`));
      return;
    }
    if (node == null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      const here = trail ? `${trail}.${key}` : key;
      if (
        typeof value === "string" &&
        (key === "owner" || key === "runner" || key === "command") &&
        value.includes(`${MOBILE_DIR}/`)
      ) {
        const match = /(?<flow>tests\/agent-e2e-mobile\/[\w./-]+\.mjs)/u.exec(
          value
        );
        if (match) {
          const flow = match.groups.target ?? match.groups.flow;
          if (!owners.has(flow)) owners.set(flow, []);
          owners.get(flow).push(here);
        }
        continue;
      }
      walk(value, here);
    }
  };
  walk(matrix, "");
  return owners;
}

export function lintWiring({ roster, flows, runners, matrix, apps, readFile }) {
  const findings = [];
  const fail = (rule, message) => findings.push({ rule, message });

  const declared = roster.flows ?? {};
  const lanes = roster.lanes ?? {};

  for (const defect of validateRoster(roster)) fail("roster-valid", defect);

  for (const flow of flows) {
    if (!declared[flow]) {
      fail(
        "rostered",
        `${flow} exists on disk but has no entry in ${ROSTER_PATH}. Declare its ` +
          `status (scheduled | promoting | exploratory) and the claim it owns — a ` +
          `flow nobody registered is a flow nobody schedules.`
      );
    }
  }
  for (const flow of Object.keys(declared)) {
    if (!flows.includes(flow)) {
      fail(
        "rostered",
        `${ROSTER_PATH} registers ${flow}, which does not exist. Delete the row ` +
          `or restore the file; a roster row for a deleted flow is a claim with no code.`
      );
    }
  }

  let reach = { flowLanes: new Map(), runnerLanes: new Map() };
  try {
    reach = resolveReach(lanes, readFile, roster);
  } catch (error) {
    fail("lane", error.message);
  }
  const { flowLanes, runnerLanes } = reach;

  for (const [flow, entry] of Object.entries(declared)) {
    const hit = [...(flowLanes.get(flow) ?? [])].sort();
    const blocking = hit.filter((laneId) => lanes[laneId]?.blocking === true);
    if (entry.status === "scheduled" && hit.length === 0) {
      fail(
        "scheduled",
        `${flow} is registered \`scheduled\` but no declared lane runs it. Wire it ` +
          `into a lane, or demote it to \`exploratory\` and accept that nothing ` +
          `enforces it. This is the ${path.basename(flow)} case #890 W0 was written for.`
      );
    }
    if (entry.status === "exploratory" && hit.length > 0) {
      fail(
        "exploratory",
        `${flow} is registered \`exploratory\` but lane(s) ${hit.join(", ")} run it. ` +
          `A lane running an exploratory flow makes it load-bearing without anyone ` +
          `deciding that; promote the row or unwire the lane.`
      );
    }
    if (entry.status === "promoting") {
      if (blocking.length > 0) {
        fail(
          "promoting",
          `${flow} is \`promoting\` but blocking lane(s) ${blocking.join(", ")} run it. ` +
            `Per D3 a staging flow runs non-blocking until it has proven stable; it ` +
            `may not red a PR before then.`
        );
      }
      if (hit.length === 0) {
        fail(
          "promoting",
          `${flow} is \`promoting\` but no lane runs it — a promotion pipeline with ` +
            `no nightly is a flow parked, not a flow staging.`
        );
      }
      if (!entry.since || !(entry.nights > 0)) {
        fail(
          "promoting",
          `${flow} is \`promoting\` but declares no \`since\` date and \`nights\` ` +
            `count; without them nothing can say when it is due for promotion.`
        );
      }
    }
    if (!entry.claim || entry.claim.length < 20) {
      fail(
        "rostered",
        `${flow} has no \`claim\` sentence. The roster is read by a human deciding ` +
          `whether the roster shrinks; a row with no claim cannot be judged.`
      );
    }
  }

  const scheduledFlows = new Set(
    Object.entries(declared)
      .filter(
        ([flow, entry]) => entry.status !== "exploratory" && flowLanes.has(flow)
      )
      .map(([flow]) => flow)
  );
  for (const [owner, paths] of matrixMobileOwners(matrix)) {
    const isRunner = runners.includes(owner);
    const scheduled = isRunner
      ? runnerLanes.has(owner)
      : scheduledFlows.has(owner);
    if (!scheduled) {
      fail(
        "matrix-owner",
        `the claims ledger names ${owner} as evidence (${paths.slice(0, 3).join(", ")}` +
          `${paths.length > 3 ? `, +${paths.length - 3} more` : ""}) but no lane ` +
          `schedules it. The matrix is claiming coverage from a journey that never runs.`
      );
    }
  }

  for (const problem of stateVarietyProblems(matrix)) {
    fail("state-variety", problem);
  }

  for (const problem of corpusProblems({ apps, flows, readFile })) {
    fail("corpus", problem);
  }

  return { findings, laneCount: Object.keys(lanes).length, flowLanes };
}

export {
  corpusProblems,
  discoverApps,
  stateVarietyProblems,
} from "./lint-e2e-wiring.rules.mjs";

function selfTest() {
  const { files, flows, runners, apps, readFile, cases } = wiringSelfTestCases({
    FLOWS_DIR,
    LANE_PREAMBLE,
    MOBILE_DIR,
    SEEDER,
  });
  for (const testCase of cases) {
    const caseRead = testCase.files
      ? (rel) =>
          rel in testCase.files ? testCase.files[rel] : readFile(rel, files)
      : readFile;
    const got = [
      ...new Set(
        lintWiring({
          roster: testCase.roster,
          flows: testCase.flows ?? flows,
          runners,
          matrix: testCase.matrix,
          apps: testCase.apps ?? apps,
          readFile: caseRead,
        }).findings.map((f) => f.rule)
      ),
    ].sort();
    const want = [...new Set(testCase.want)].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(
        `FAIL — lint-e2e-wiring self-test "${testCase.name}": expected [${want}], got [${got}]`
      );
      process.exit(1);
    }
  }
}

export function readLedger(
  readFile,
  exists = existsSync,
  run = runDeriveFlows
) {
  const derived = exists(path.resolve(ROOT, DERIVE_FLOWS)) ? run() : undefined;
  const ledgerPath = exists(path.resolve(ROOT, CLAIMS_PATH))
    ? CLAIMS_PATH
    : MATRIX_PATH;
  const ledger = JSON.parse(readFile(ledgerPath));
  return derived ? { ...ledger, flows: derived.flows ?? ledger.flows } : ledger;
}

function runDeriveFlows() {
  const out = execFileSync(process.execPath, [DERIVE_FLOWS, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(out);
}

function main() {
  selfTest();

  const readFile = (rel) => {
    const abs = path.resolve(ROOT, rel);
    if (!existsSync(abs)) {
      console.error(
        `\nFAIL — ${rel} does not exist; the wiring cannot be read.\n`
      );
      process.exit(1);
    }
    return readFileSync(abs, "utf8");
  };

  const roster = JSON.parse(readFile(ROSTER_PATH));
  const flows = discoverFlows();
  const runners = discoverRunners();
  const matrix = readLedger(readFile);
  const apps = discoverApps();

  if (flows.length === 0) {
    console.error(`\nFAIL — discovered zero flows under ${FLOWS_DIR}.\n`);
    process.exit(1);
  }
  if (Object.keys(roster.suites ?? {}).length === 0) {
    console.error(
      `\nFAIL — ${ROSTER_PATH} declares no suites. A roster with no suites schedules ` +
        `nothing, so every rule below would pass over an entirely dead roster.\n`
    );
    process.exit(1);
  }
  if (Object.keys(roster.lanes ?? {}).length === 0) {
    console.error(
      `\nFAIL — ${ROSTER_PATH} declares no lanes. A roster with no lanes can never ` +
        `flag an unscheduled flow, so it would pass over an entirely dead roster.\n`
    );
    process.exit(1);
  }

  const { findings, laneCount, flowLanes } = lintWiring({
    roster,
    flows,
    runners,
    matrix,
    apps,
    readFile,
  });

  if (flowLanes.size === 0 && findings.every((f) => f.rule !== "lane")) {
    console.error(
      `\nFAIL — ${laneCount} lane(s) declared but zero flow invocations derived. ` +
        `The invocation grammar is stale, not clean: the lanes stopped running flows ` +
        `the way this linter reads, or they stopped running flows at all.\n`
    );
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error(
      `\nFAIL — ${findings.length} mobile e2e wiring defect(s): a journey the ledger ` +
        `claims and no lane runs, or a lane running one nobody registered.\n`
    );
    for (const finding of findings) {
      console.error(`  [${finding.rule}] ${finding.message}\n`);
    }
    console.error(`See ${ROSTER_PATH} and issue #890.\n`);
    process.exit(1);
  }

  console.log(
    `ok   e2e-wiring — ${flows.length} flow(s), ${runners.length} runner(s), ` +
      `${laneCount} lane(s); every scheduled flow is reachable and every mobile ` +
      `matrix owner is scheduled`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
