#!/usr/bin/env node
// Mobile agent-e2e WIRING linter (issue #890 W0). Sibling of
// scripts/lint-e2e-flows.mjs: that one asks whether a flow's assertions observe
// anything, this one asks whether anything RUNS the flow.
//
// Why this exists. Three separate ways a mobile journey could be committed,
// linted, registered as evidence, and never executed:
//
//   1. `flows/sharing-invite.mjs` was named three times in `tests/matrix.json`
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
// The five rules:
//
//   RULE rostered        Every flow file on disk has a roster entry, and every
//     roster entry names a file on disk. A flow that is new cannot escape by
//     being new; a roster row whose file was deleted cannot linger as a claim.
//
//   RULE scheduled       A flow whose roster status is `scheduled` must be
//     reachable from at least one declared lane. This is the rule
//     `sharing-invite.mjs` fails today.
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
// Reachability is TRANSITIVE and derived: a lane's job block is scanned for
// `node tests/agent-e2e-mobile/<path>` invocations (comments stripped first, so
// prose about a retired lane cannot fake a live one), and any suite runner so
// invoked has its own `FLOWS` array read off disk and folded in.
//
// Following lint-e2e-flows.mjs and lint-css-classes.mjs: a silent no-op is a
// FAILURE. Zero flows discovered, zero lanes declared, or zero invocations
// derived all fail loudly, and a self-test of the rules runs first so the
// linter cannot rot into always-passing.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_DIR = "tests/agent-e2e-mobile";
const FLOWS_DIR = `${MOBILE_DIR}/flows`;
const ROSTER_PATH = `${MOBILE_DIR}/roster.json`;
const MATRIX_PATH = "tests/matrix.json";

/** Strip `#` comments from a YAML or shell source so prose cannot count as
 * wiring. A `#` inside a quoted string is not a comment, but no invocation line
 * in these files puts one there, and treating it as one would only ever make
 * this linter STRICTER (it would see fewer invocations and fail louder). */
export function stripComments(text) {
  return text
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join("\n");
}

/** Every `.mjs` flow file on disk, repo-relative. Discovered, never listed. */
export function discoverFlows(root = ROOT) {
  return readdirSync(path.resolve(root, FLOWS_DIR))
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `${FLOWS_DIR}/${name}`);
}

/** Is `rel` a suite runner — `run-*.mjs` at the mobile directory ROOT? The
 * shape is the contract: a runner sits beside `flows/`, declares one `FLOWS`
 * array, and schedules journeys. Anything under `lib/` is machinery a lane may
 * legitimately `node`-run (the CI gateway and its readiness probe) and owes no
 * roster. */
export function isRunnerPath(rel) {
  return /^tests\/agent-e2e-mobile\/run-[\w.-]+\.mjs$/u.test(rel);
}

/** Every `run-*-suite.mjs` runner on disk, repo-relative. */
export function discoverRunners(root = ROOT) {
  return readdirSync(path.resolve(root, MOBILE_DIR))
    .filter(
      (name) => /^run-.*\.mjs$/u.test(name) && !name.endsWith(".test.mjs")
    )
    .sort()
    .map((name) => `${MOBILE_DIR}/${name}`);
}

/**
 * The block of a workflow YAML belonging to one job key. Jobs sit at two-space
 * indent under `jobs:`; the block runs to the next two-space key. Text-level,
 * like scripts/test-report/validate-nightly-wiring.mjs, because the shipped YAML
 * is the artifact under test and a YAML parser would let a `!!merge` or an
 * anchor hide an invocation this must see.
 */
export function jobBlock(yaml, job) {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/u.test(lines[i])) return lines.slice(start, i).join("\n");
  }
  return lines.slice(start).join("\n");
}

const INVOKE_RE =
  /\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*(?<target>tests\/agent-e2e-mobile\/[\w./-]+\.mjs)/gu;

/** Direct `node tests/agent-e2e-mobile/*.mjs` invocations in a source chunk. */
export function directInvocations(chunk) {
  return [...stripComments(chunk).matchAll(INVOKE_RE)].map(
    (m) => m.groups.target
  );
}

/** The `FLOWS` array a suite runner declares, resolved to repo-relative paths.
 * A runner whose array this cannot read is a FAILURE at the call site, not an
 * empty result — an unreadable runner would silently unschedule its members. */
export function runnerMembers(source, runnerRel) {
  // LINE-ANCHORED. The unanchored form matched the prose in a runner's own
  // header comment explaining that this linter reads its FLOWS array, took the
  // ellipsis inside it as the body, and reported the runner as declaring an
  // empty array — a linter defeated by a comment about itself. A declaration is
  // always at column zero here; a mention of one never is.
  const block = /^const FLOWS\s*=\s*\[(?<body>[\s\S]*?)\]/mu.exec(source);
  if (!block?.groups) {
    throw new Error(
      `${runnerRel} declares no readable \`const FLOWS = [ … ]\` array; ` +
        `the wiring linter cannot tell which journeys it runs. Keep the array a ` +
        `literal of quoted file names.`
    );
  }
  const names = [
    ...block.groups.body.matchAll(/["'](?<name>[\w.-]+\.mjs)["']/gu),
  ]
    .map((m) => m.groups?.name)
    .filter(Boolean);
  if (names.length === 0) {
    throw new Error(`${runnerRel} declares an empty FLOWS array`);
  }
  return names.map((name) => `${FLOWS_DIR}/${name}`);
}

/**
 * Resolve every flow each declared lane reaches, transitively through runners.
 *
 * @param lanes roster `lanes` map: id → `{ workflow, job, script?, blocking }`
 * @param readFile `(relPath) => string`
 * @returns `Map<flowRel, Set<laneId>>` plus `Map<runnerRel, Set<laneId>>`
 */
export function resolveReach(lanes, readFile) {
  const flowLanes = new Map();
  const runnerLanes = new Map();
  const add = (map, key, lane) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(lane);
  };

  for (const [laneId, lane] of Object.entries(lanes)) {
    const yaml = readFile(lane.workflow);
    const block = jobBlock(yaml, lane.job);
    if (block == null) {
      throw new Error(
        `lane ${laneId} declares job "${lane.job}" in ${lane.workflow}, which has no such job key`
      );
    }
    // A lane may hand its body to a committed script (the Android emulator
    // action executes `bash apps/mobile/scripts/android-emulator-roster.sh`),
    // in which case the invocations live there, not in the YAML. This is also
    // why the two Android lane shapes are two scripts rather than one script
    // with a suite switch — a script holding every branch would make every lane
    // look like it runs every journey.
    const chunks = [block];
    for (const script of lane.scripts ?? []) {
      if (!block.includes(script)) {
        throw new Error(
          `lane ${laneId} declares script ${script}, which its ${lane.job} job never runs`
        );
      }
      chunks.push(readFile(script));
    }
    const seen = new Set();
    const walk = (chunk) => {
      for (const target of directInvocations(chunk)) {
        if (seen.has(target)) continue;
        seen.add(target);
        if (target.startsWith(`${FLOWS_DIR}/`)) {
          add(flowLanes, target, laneId);
          continue;
        }
        // Only a `run-*.mjs` suite runner at the directory root schedules
        // journeys. Everything else a lane node-runs from this tree is
        // machinery, not a roster member — `lib/ci-gateway.mjs` and
        // `lib/ci-gateway-ready.mjs` are the two today — and treating machinery
        // as a runner would demand a FLOWS array it has no reason to own.
        if (!isRunnerPath(target)) continue;
        add(runnerLanes, target, laneId);
        for (const member of runnerMembers(readFile(target), target)) {
          add(flowLanes, member, laneId);
        }
      }
    };
    for (const chunk of chunks) walk(chunk);
  }
  return { flowLanes, runnerLanes };
}

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
export function lintWiring({ roster, flows, runners, matrix, readFile }) {
  const findings = [];
  const fail = (rule, message) => findings.push({ rule, message });

  const declared = roster.flows ?? {};
  const lanes = roster.lanes ?? {};

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
    reach = resolveReach(lanes, readFile);
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
        `${MATRIX_PATH} names ${owner} as evidence (${paths.slice(0, 3).join(", ")}` +
          `${paths.length > 3 ? `, +${paths.length - 3} more` : ""}) but no lane ` +
          `schedules it. The matrix is claiming coverage from a journey that never runs.`
      );
    }
  }

  return { findings, laneCount: Object.keys(lanes).length, flowLanes };
}

// ---- self-test: the rules, exercised on fixtures, before judging the repo.
function selfTest() {
  const files = {
    "wf.yml": [
      "jobs:",
      "  gate:",
      "    steps:",
      "      - run: node tests/agent-e2e-mobile/run-x-suite.mjs",
      "  other:",
      "    steps:",
      "      # node tests/agent-e2e-mobile/flows/ghost.mjs",
      "      - run: node tests/agent-e2e-mobile/flows/b.mjs",
    ].join("\n"),
    // The header comment above the declaration is deliberate: the unanchored
    // regex this replaced matched the PROSE, read its ellipsis as the body, and
    // called the runner empty. A linter that a comment about itself can defeat
    // is not a linter, so the fixture keeps the shape that defeated it.
    "tests/agent-e2e-mobile/run-x-suite.mjs":
      '// the wiring linter reads this runner\'s `const FLOWS = [ … ]` array\nconst FLOWS = ["a.mjs"];',
  };
  const readFile = (rel) => {
    if (!(rel in files)) throw new Error(`missing fixture ${rel}`);
    return files[rel];
  };
  const lanes = {
    gate: { workflow: "wf.yml", job: "gate", blocking: true },
    nightly: { workflow: "wf.yml", job: "other", blocking: false },
  };
  const claim = "a claim long enough to be judged";
  const flows = [
    `${FLOWS_DIR}/a.mjs`,
    `${FLOWS_DIR}/b.mjs`,
    `${FLOWS_DIR}/c.mjs`,
  ];
  const runners = [`${MOBILE_DIR}/run-x-suite.mjs`];

  const cases = [
    {
      name: "a scheduled flow no lane runs is flagged",
      roster: {
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/b.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/c.mjs`]: { status: "scheduled", claim },
        },
      },
      matrix: {},
      want: ["scheduled"],
    },
    {
      name: "transitive reach through a runner counts as scheduled",
      roster: {
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/b.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/c.mjs`]: { status: "exploratory", claim },
        },
      },
      matrix: {},
      want: [],
    },
    {
      name: "a commented-out invocation does not schedule anything",
      roster: {
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/b.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/c.mjs`]: { status: "exploratory", claim },
          [`${FLOWS_DIR}/ghost.mjs`]: { status: "scheduled", claim },
        },
      },
      flows: [...flows, `${FLOWS_DIR}/ghost.mjs`],
      matrix: {},
      want: ["scheduled"],
    },
    {
      name: "an exploratory flow a lane runs is flagged",
      roster: {
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: { status: "exploratory", claim },
          [`${FLOWS_DIR}/b.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/c.mjs`]: { status: "exploratory", claim },
        },
      },
      matrix: {},
      want: ["exploratory"],
    },
    {
      name: "a promoting flow on a blocking lane is flagged",
      roster: {
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: {
            status: "promoting",
            claim,
            since: "2026-08-30",
            nights: 5,
          },
          [`${FLOWS_DIR}/b.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/c.mjs`]: { status: "exploratory", claim },
        },
      },
      matrix: {},
      want: ["promoting"],
    },
    {
      name: "a promoting flow on a non-blocking lane is clean",
      roster: {
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/b.mjs`]: {
            status: "promoting",
            claim,
            since: "2026-08-30",
            nights: 5,
          },
          [`${FLOWS_DIR}/c.mjs`]: { status: "exploratory", claim },
        },
      },
      matrix: {},
      want: [],
    },
    {
      name: "a matrix owner nothing schedules is a hard failure",
      roster: {
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/b.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/c.mjs`]: { status: "exploratory", claim },
        },
      },
      matrix: { flows: [{ owner: `${FLOWS_DIR}/c.mjs` }] },
      want: ["matrix-owner"],
    },
    {
      name: "an unrostered flow on disk is flagged",
      roster: {
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/b.mjs`]: { status: "scheduled", claim },
        },
      },
      matrix: {},
      want: ["rostered"],
    },
    {
      name: "a roster row with no file is flagged",
      roster: {
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/b.mjs`]: { status: "scheduled", claim },
          [`${FLOWS_DIR}/c.mjs`]: { status: "exploratory", claim },
          [`${FLOWS_DIR}/gone.mjs`]: { status: "exploratory", claim },
        },
      },
      matrix: {},
      want: ["rostered"],
    },
    {
      name: "a lane naming a job that does not exist is flagged",
      roster: {
        lanes: { bad: { workflow: "wf.yml", job: "nope", blocking: false } },
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: { status: "exploratory", claim },
          [`${FLOWS_DIR}/b.mjs`]: { status: "exploratory", claim },
          [`${FLOWS_DIR}/c.mjs`]: { status: "exploratory", claim },
        },
      },
      matrix: {},
      want: ["lane"],
    },
  ];

  for (const testCase of cases) {
    const got = [
      ...new Set(
        lintWiring({
          roster: testCase.roster,
          flows: testCase.flows ?? flows,
          runners,
          matrix: testCase.matrix,
          readFile,
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
  const matrix = JSON.parse(readFile(MATRIX_PATH));

  // Silent-no-op guards. Each of these reads as "clean" if unchecked, and each
  // has a plausible cause: a moved directory, an emptied roster, a workflow
  // rename that leaves every job block unresolvable.
  if (flows.length === 0) {
    console.error(`\nFAIL — discovered zero flows under ${FLOWS_DIR}.\n`);
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
