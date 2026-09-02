#!/usr/bin/env node
// Mobile agent-e2e WIRING linter (issue #890 W0). Sibling of
// scripts/lint-e2e-flows.mjs: that one asks whether a flow's assertions observe
// anything, this one asks whether anything RUNS the flow.
//
// Why this exists. Three separate ways a mobile journey could be committed,
// linted, registered as evidence, and never executed:
//
//   1. `flows/sharing-reach.mjs` was named three times in `tests/matrix.json`
//      as an evidence owner — an appScenarios journey, a canonical `flows[]`
//      record with `minimumTests: 15`, and a member of the `standalone` suite —
//      while no workflow, no suite runner and no script invoked it. The matrix
//      said the mobile sharing seat was proven. Nothing had run it.
//   2. `U1-mobile` ("mobile first-run product journey") was owned by
//      `home-loads.mjs`, a flow that deliberately never pairs and never reaches
//      Home. The gate and its owner were about different journeys.
//   3. The six standalone journeys ran as bare `node …` lines in two workflow
//      files with no aggregate budget between them, so nothing could say what
//      the roster as a whole was allowed to cost.
//
// All three are the same failure: the LEDGER and the WIRING are two independent
// documents that nothing held against each other. This linter holds them
// against each other, and it derives the wiring from the shipped YAML and the
// shipped runners — never from a hand-kept list, because a hand-kept list is
// the thing that drifted.
//
// The seven rules:
//
//   RULE rostered        Every flow file on disk has a roster entry, and every
//     roster entry names a file on disk. A flow that is new cannot escape by
//     being new; a roster row whose file was deleted cannot linger as a claim.
//
//   RULE scheduled       A flow whose roster status is `scheduled` must be
//     reachable from at least one declared lane. This is the rule
//     `sharing-reach.mjs` fails today.
//
//   RULE exploratory     A flow whose roster status is `exploratory` must be
//     reachable from NO lane. Exploratory means "a human drives this by hand";
//     a lane running it silently makes it load-bearing without anyone deciding.
//
//   RULE promoting       A flow whose roster status is `promoting` (D3's
//     promotion pipeline) must be reachable ONLY from non-blocking lanes, and
//     must carry `since` and `nights`. A new flow may stage; it may not gate a
//     PR before it has proven it is stable.
//
//   RULE matrix-owner    Every `tests/matrix.json` owner path under
//     `tests/agent-e2e-mobile/` must resolve to a flow or runner that some lane
//     schedules. A matrix owner nothing schedules is a HARD FAILURE — it is the
//     precise shape of a green report over an unexecuted claim.
//
//   RULE roster-valid    `roster.json` agrees with itself: every suite prices
//     itself, every member has a row, every flow's derived `suite`/`rungs`/
//     `platform` match the suite table, and no lane above rung 2 blocks a merge.
//     Seven runner files used to enforce most of this by existing — a `FLOWS`
//     literal could not name a journey that was not there. One JSON document can
//     express every one of those mistakes, so they are checked (#915 Wave 2).
//
//   RULE state-variety   No app x designed-state cell may be OWNED by anything
//     under `tests/agent-e2e-mobile/`. State variety is the Linux workhorse's
//     (`tests/integration-mobile/`, eight apps x seven states over a real
//     gateway and a real replica session); a simulator minute costs roughly 600
//     Vitest seconds, so a claim that tier can falsify does not belong on a
//     device at all. This is `$doctrine` made mechanical (#915 Wave 2).
//
//   RULE corpus          A launcher tile exists only for an app that EARNED the
//     grid, so `Open <App>` is not a route until that app has rows. Two halves,
//     both learned from #905, where twelve journeys failed at their first tap
//     on an app that was working:
//       (a) every `Open <App>` a flow taps names an app that ships a
//           `seed.js` scenario, or is one the springboard promotes on an empty
//           vault (`locker`, whose body is a state rather than a query result);
//       (b) the shared lane preamble seeds the corpus BEFORE it hands off to
//           Maestro. A lane is many flows sharing one pairing, and a flow's own
//           `ensureDemo` writes only to the gateway — so a seed after that first
//           pairing never reaches the phone. Home then reads the vault as empty,
//           renders `DayOne` instead of `LauncherGrid`, and every tile tap fails
//           with `Element not found` while `HOME_READY_MARKER` still reports the
//           screen ready.
//
// Reachability is TRANSITIVE and derived: a lane's job block is scanned for
// `node tests/agent-e2e-mobile/<path>` invocations (comments stripped first, so
// prose about a retired lane cannot fake a live one), and any suite runner so
// invoked has its members folded in from THE ROSTER.
//
// #915 Wave 2 changed where those members come from and nothing else about the
// derivation. There used to be seven `run-*-suite.mjs` files, each carrying a
// `const FLOWS = [ … ]` literal this linter read off disk by regex. There is now
// one `run-roster.mjs` selected by `--rung <n> --platform <p> [--suite <s>]`,
// plus thin shims that call `resolvePlan({ rung, platform, suite })` — and both
// shapes are read the same way: the SELECTOR is parsed out of the invocation (or
// out of the shim's own call), and `lib/roster.mjs` resolves it to members. The
// flags are therefore load-bearing wiring, exactly as the seven files were: a
// runner that picked its suite from an environment variable would make every
// lane look identical here, which is the precise property the `promoting` and
// `exploratory` rules depend on.
//
// Following lint-e2e-flows.mjs and lint-css-classes.mjs: a silent no-op is a
// FAILURE. Zero flows discovered, zero lanes declared, or zero invocations
// derived all fail loudly, and a self-test of the rules runs first so the
// linter cannot rot into always-passing.

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
/** The claims file replaces the matrix (#915 Wave 3, slice REPORT). Both are
 *  read the same way and only one exists at a time; naming both here is what
 *  lets the two slices land in either order without a red seam. */
const CLAIMS_PATH = "tests/claims.json";
const MATRIX_PATH = "tests/matrix.json";
/** The derived `{flows:[{id,owner}]}` view slice REPORT ships when owners stop
 *  being hand-typed. Preferred over reading the claims file directly, because a
 *  derived view cannot disagree with what it was derived from. */
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

/** Every owner-ish string in matrix.json pointing under tests/agent-e2e-mobile.
 * Walked structurally rather than regexed, so a new owner-bearing block is
 * covered the day it lands. */
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
        // `command` carries a shell line (`node tests/…/x.mjs`); owner/runner
        // carry a bare path. Normalise both to the path.
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

/** The rule engine. Pure over an injected tree so the self-test can drive it. */
export function lintWiring({ roster, flows, runners, matrix, apps, readFile }) {
  const findings = [];
  const fail = (rule, message) => findings.push({ rule, message });

  const declared = roster.flows ?? {};
  const lanes = roster.lanes ?? {};

  // RULE roster-valid — the roster held against ITSELF, before it is held
  // against the wiring. Seven runner files used to make most of these mistakes
  // unexpressible; one JSON document can express all of them (#915 Wave 2).
  for (const defect of validateRoster(roster)) fail("roster-valid", defect);

  // RULE rostered — both directions.
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

  // RULE scheduled / exploratory / promoting.
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

  // RULE matrix-owner — the ledger held against the wiring.
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

  // RULE state-variety — the doctrine, made mechanical.
  for (const problem of stateVarietyProblems(matrix)) {
    fail("state-variety", problem);
  }

  // RULE corpus — the grid is content-dependent, so the corpus is wiring too.
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

// ---- self-test: the rules, exercised on fixtures, before judging the repo.
function selfTest() {
  // Cases live in the sibling module; the assertion stays HERE so running the
  // linter directly still exercises them. See that file for why.
  const { files, flows, runners, apps, readFile, cases } = wiringSelfTestCases({
    FLOWS_DIR,
    LANE_PREAMBLE,
    MOBILE_DIR,
    SEEDER,
  });
  for (const testCase of cases) {
    // A case may shadow individual fixture files — the corpus cases vary the
    // lane preamble, whose ORDERING is the thing under test and cannot be
    // expressed as a roster or a flow list.
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

/**
 * The ledger this linter holds the wiring against.
 *
 * Three sources, in order of how derived they are, because slice REPORT is
 * replacing `tests/matrix.json` with `tests/claims.json` and shipping a derived
 * `{flows:[{id,owner}]}` view alongside it (#915 Wave 3). Reading the derived
 * view first means the owners this rule checks cannot disagree with the thing
 * they were derived from; reading either file second means the two slices can
 * land in either order without a red seam. A tree with NEITHER is a hard
 * failure, not an empty read — a ledger this linter cannot find is a ledger it
 * cannot hold anything against.
 */
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
  // The derived view carries owners only; the appStates layer RULE
  // state-variety reads stays with the ledger itself.
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

  // Silent-no-op guards. Each of these reads as "clean" if unchecked, and each
  // has a plausible cause: a moved directory, an emptied roster, a workflow
  // rename that leaves every job block unresolvable.
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
