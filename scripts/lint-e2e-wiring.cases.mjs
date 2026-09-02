// SELF-TEST FIXTURES for scripts/lint-e2e-wiring.mjs (#890).
//
// Split out of the linter itself, which had grown past the repo's god-file
// ceiling. The SHAPE of the split matters: the linter still runs these on every
// invocation (`selfTest()` in lint-e2e-wiring.mjs calls `wiringSelfTestCases()`
// and asserts each), because a rule engine whose cases only run under `bun run
// test` rots into an always-passing gate the moment someone runs the linter
// alone. Moving the DATA out and leaving the ASSERTION in keeps that property
// while making both files legible.
//
// Several fixtures deliberately preserve shapes that once DEFEATED this linter —
// notably a runner whose header comment talks about its own `const FLOWS = [`
// declaration. Do not "tidy" those; they are regression pins, and the comment
// beside each says which bug it holds down.

/**
 * The fixture corpus.
 *
 * Path constants are PASSED IN rather than imported, and rather than restated
 * here. Importing them would make this module and the linter a cycle; restating
 * them would let the fixtures keep passing against paths the linter no longer
 * uses, which is the failure a fixture corpus is least able to notice about
 * itself.
 *
 * @param {{ MOBILE_DIR: string, FLOWS_DIR: string, LANE_PREAMBLE: string,
 *   SEEDER: string }} dirs The linter's own paths.
 * @returns {{ files: Record<string,string>, flows: string[], runners: string[],
 *   readFile: (rel: string) => string, cases: object[] }} The fixture tree, the
 *   discovered flow/runner lists it implies, a reader over it, and the rule
 *   cases the linter asserts against them.
 */
export function wiringSelfTestCases({
  FLOWS_DIR,
  LANE_PREAMBLE,
  MOBILE_DIR,
  SEEDER,
}) {
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
    // The header comment above the call is deliberate: the unanchored regex the
    // FLOWS reader used matched the PROSE, read its ellipsis as the body, and
    // called the runner empty. `shimSelector` is line-anchored for the same
    // reason, so the fixture keeps a shape of that family — a comment about the
    // very call the linter is looking for.
    "tests/agent-e2e-mobile/run-x-suite.mjs":
      "// the wiring linter reads this shim's `resolvePlan({ rung, platform, suite })` call\n" +
      "process.exitCode = await runPlan(\n" +
      '  resolvePlan({ rung: 2, platform: "android", suite: "x" })\n' +
      ");",
    // Flow bodies exist so RULE corpus has covers to read. `a.mjs` taps a
    // seedable app's tile and `b.mjs` taps Locker, which the springboard
    // promotes on an empty vault — both legal, so the non-corpus cases below
    // stay single-rule.
    [`${FLOWS_DIR}/a.mjs`]: 'retryableTapCommands("Open Photos.*")',
    [`${FLOWS_DIR}/b.mjs`]: 'retryableTapCommands("Open Locker.*")',
    [`${FLOWS_DIR}/c.mjs`]: "// no cover taps here",
    // The #905 pin: seeding BEFORE the handoff. A comment mentioning the
    // seeder must not count, which is why the linter strips comments first.
    [LANE_PREAMBLE]: [
      "adb install -r app.apk",
      `node ${SEEDER}`,
      "export MAESTRO_PLATFORM=android",
    ].join("\n"),
  };
  const readFile = (rel, tree = files) => {
    if (!(rel in tree)) throw new Error(`missing fixture ${rel}`);
    return tree[rel];
  };
  // `assistant` is the fixture's non-seedable, non-Locker app: the one shape
  // RULE corpus (a) exists to reject.
  const apps = [
    { id: "photos", seedable: true },
    { id: "locker", seedable: false },
    { id: "assistant", seedable: false },
  ];
  const lanes = {
    gate: { workflow: "wf.yml", job: "gate", rung: 2, blocking: true },
    nightly: { workflow: "wf.yml", job: "other", rung: 4, blocking: false },
  };
  const claim = "a claim long enough to be judged";
  const flows = [
    `${FLOWS_DIR}/a.mjs`,
    `${FLOWS_DIR}/b.mjs`,
    `${FLOWS_DIR}/c.mjs`,
  ];
  const runners = [`${MOBILE_DIR}/run-x-suite.mjs`];

  /** The suite table every fixture roster starts from (#915 Wave 2). `x` is the
   *  rung-2 suite the gate lane's shim selects; `y` holds the flow the nightly
   *  lane invokes bare, because RULE roster-valid requires a non-exploratory
   *  flow to belong to a suite and the bare-invocation path still needs a
   *  fixture. */
  const suites = {
    x: {
      budgetMs: 480_000,
      doc: "flows/x-budget.md",
      rungs: [2],
      platform: ["android"],
      lane: "gate",
      canaryCount: 1,
      reuseAfter: 1,
      flows: ["a.mjs"],
      onBudgetBreach: "",
    },
    y: {
      budgetMs: 720_000,
      doc: "flows/y-budget.md",
      rungs: [4],
      platform: ["android"],
      lane: "nightly",
      canaryCount: 0,
      reuseAfter: null,
      flows: ["b.mjs"],
      onBudgetBreach: "",
    },
  };
  /** A flow row with the derived fields RULE roster-valid checks. */
  const row = (suite, extra = {}) => ({
    status: "scheduled",
    suite: suite ? [suite] : [],
    rungs: suite ? suites[suite].rungs : [],
    platform: suite ? suites[suite].platform : [],
    budgetMs: 60_000,
    claim,
    ...extra,
  });
  const loose = (extra = {}) =>
    row(undefined, { status: "exploratory", ...extra });
  /** A suite table variant. Cases that need a flow to be scheduled-but-unreached
   *  need it to be IN a suite (RULE roster-valid) that no lane invokes, so `z`
   *  exists to hold exactly that. */
  const suitesPlus = (members) => ({
    ...suites,
    z: {
      budgetMs: 720_000,
      doc: "flows/z-budget.md",
      rungs: [4],
      platform: ["android"],
      lane: "nightly",
      canaryCount: 0,
      reuseAfter: null,
      flows: members,
      onBudgetBreach: "",
    },
  });
  const rowZ = (extra = {}) => ({
    status: "scheduled",
    suite: ["z"],
    rungs: [4],
    platform: ["android"],
    budgetMs: 60_000,
    claim,
    ...extra,
  });

  // A roster that is CLEAN against every other rule, so a corpus case reports
  // the corpus rule alone: `a` is reached by the gate lane through the shim,
  // `b` directly by the nightly lane, and `c` by nothing (hence exploratory).
  const cleanRoster = {
    [`${FLOWS_DIR}/a.mjs`]: row("x"),
    [`${FLOWS_DIR}/b.mjs`]: row("y"),
    [`${FLOWS_DIR}/c.mjs`]: loose(),
  };

  const cases = [
    {
      name: "a scheduled flow no lane runs is flagged",
      roster: {
        suites: suitesPlus(["c.mjs"]),
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: row("x"),
          [`${FLOWS_DIR}/b.mjs`]: row("y"),
          [`${FLOWS_DIR}/c.mjs`]: rowZ(),
        },
      },
      matrix: {},
      want: ["scheduled"],
    },
    {
      name: "transitive reach through a runner counts as scheduled",
      roster: {
        suites,
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: row("x"),
          [`${FLOWS_DIR}/b.mjs`]: row("y"),
          [`${FLOWS_DIR}/c.mjs`]: loose(),
        },
      },
      matrix: {},
      want: [],
    },
    {
      name: "a commented-out invocation does not schedule anything",
      roster: {
        suites: suitesPlus(["ghost.mjs"]),
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: row("x"),
          [`${FLOWS_DIR}/b.mjs`]: row("y"),
          [`${FLOWS_DIR}/c.mjs`]: loose(),
          [`${FLOWS_DIR}/ghost.mjs`]: rowZ(),
        },
      },
      flows: [...flows, `${FLOWS_DIR}/ghost.mjs`],
      matrix: {},
      want: ["scheduled"],
    },
    {
      name: "an exploratory flow a lane runs is flagged",
      // `a` leaves the suite table AND the gate lane reaches it as a BARE flow
      // invocation instead of through the shim: an exploratory flow belongs to
      // no suite (RULE roster-valid), so the only way a lane can still run one
      // is the bare `node …/flows/a.mjs` line this override supplies.
      files: {
        "wf.yml": [
          "jobs:",
          "  gate:",
          "    steps:",
          "      - run: node tests/agent-e2e-mobile/flows/a.mjs",
          "  other:",
          "    steps:",
          "      - run: node tests/agent-e2e-mobile/flows/b.mjs",
        ].join("\n"),
      },
      roster: {
        suites: { y: suites.y },
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: loose(),
          [`${FLOWS_DIR}/b.mjs`]: row("y"),
          [`${FLOWS_DIR}/c.mjs`]: loose(),
        },
      },
      matrix: {},
      want: ["exploratory"],
    },
    {
      name: "a promoting flow on a blocking lane is flagged",
      roster: {
        suites,
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: row("x", {
            status: "promoting",
            since: "2026-08-30",
            nights: 5,
          }),
          [`${FLOWS_DIR}/b.mjs`]: row("y"),
          [`${FLOWS_DIR}/c.mjs`]: loose(),
        },
      },
      matrix: {},
      want: ["promoting"],
    },
    {
      name: "a promoting flow on a non-blocking lane is clean",
      roster: {
        suites,
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: row("x"),
          [`${FLOWS_DIR}/b.mjs`]: row("y", {
            status: "promoting",
            since: "2026-08-30",
            nights: 5,
          }),
          [`${FLOWS_DIR}/c.mjs`]: loose(),
        },
      },
      matrix: {},
      want: [],
    },
    {
      name: "a matrix owner nothing schedules is a hard failure",
      roster: {
        suites,
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: row("x"),
          [`${FLOWS_DIR}/b.mjs`]: row("y"),
          [`${FLOWS_DIR}/c.mjs`]: loose(),
        },
      },
      matrix: { flows: [{ owner: `${FLOWS_DIR}/c.mjs` }] },
      want: ["matrix-owner"],
    },
    {
      name: "an unrostered flow on disk is flagged",
      roster: {
        suites,
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: row("x"),
          [`${FLOWS_DIR}/b.mjs`]: row("y"),
        },
      },
      matrix: {},
      want: ["rostered"],
    },
    {
      name: "a roster row with no file is flagged",
      roster: {
        suites,
        lanes,
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: row("x"),
          [`${FLOWS_DIR}/b.mjs`]: row("y"),
          [`${FLOWS_DIR}/c.mjs`]: loose(),
          [`${FLOWS_DIR}/gone.mjs`]: loose(),
        },
      },
      matrix: {},
      want: ["rostered"],
    },
    {
      name: "a lane naming a job that does not exist is flagged",
      roster: {
        suites: {},
        lanes: {
          bad: { workflow: "wf.yml", job: "nope", rung: 4, blocking: false },
        },
        flows: {
          [`${FLOWS_DIR}/a.mjs`]: loose(),
          [`${FLOWS_DIR}/b.mjs`]: loose(),
          [`${FLOWS_DIR}/c.mjs`]: loose(),
        },
      },
      matrix: {},
      want: ["lane"],
    },
    // ---- RULE roster-valid (#915 Wave 2). The mistakes seven runner files
    // used to make unexpressible, now that one JSON document can express them.
    {
      name: "a suite member with no roster row is flagged",
      roster: {
        suites: { ...suites, x: { ...suites.x, flows: ["a.mjs", "gone.mjs"] } },
        lanes,
        flows: cleanRoster,
      },
      matrix: {},
      want: ["roster-valid"],
    },
    {
      name: "a flow that costs more than its whole suite is flagged",
      roster: {
        suites,
        lanes,
        flows: {
          ...cleanRoster,
          [`${FLOWS_DIR}/a.mjs`]: row("x", { budgetMs: 999_000_000 }),
        },
      },
      matrix: {},
      want: ["roster-valid"],
    },
    {
      name: "a blocking lane above rung 2 is flagged",
      roster: {
        suites,
        lanes: { ...lanes, nightly: { ...lanes.nightly, blocking: true } },
        flows: cleanRoster,
      },
      matrix: {},
      want: ["roster-valid"],
    },
    // ---- RULE state-variety (#915 Wave 2).
    {
      name: "a designed-state cell owned by a device flow is flagged",
      roster: { suites, lanes, flows: cleanRoster },
      matrix: {
        appStates: {
          apps: [
            {
              id: "notes",
              states: {
                offline: { owner: `${FLOWS_DIR}/b.mjs`, status: "owned" },
              },
            },
          ],
        },
      },
      want: ["state-variety"],
    },
    {
      name: "a designed-state cell owned by the Linux tier is clean",
      roster: { suites, lanes, flows: cleanRoster },
      matrix: {
        appStates: {
          apps: [
            {
              id: "notes",
              states: {
                offline: {
                  owner: "tests/integration-mobile/offline.integration.test.ts",
                  status: "owned",
                },
              },
            },
          ],
        },
      },
      want: [],
    },
    // ---- RULE corpus (#905). Both halves, and a clean tree that proves the
    // rule is not simply always-on.
    {
      name: "a flow tapping a tile for an app with no corpus is flagged",
      roster: { suites, lanes, flows: cleanRoster },
      matrix: {},
      files: {
        [`${FLOWS_DIR}/c.mjs`]: 'retryableTapCommands("Open Assistant.*")',
      },
      want: ["corpus"],
    },
    {
      name: "Locker needs no corpus — its tile is promoted on an empty vault",
      roster: { suites, lanes, flows: cleanRoster },
      matrix: {},
      files: {
        [`${FLOWS_DIR}/c.mjs`]: 'retryableTapCommands("Open Locker.*")',
      },
      want: [],
    },
    {
      name: "a cover-shaped string that is not an app id is not a cover",
      roster: { suites, lanes, flows: cleanRoster },
      matrix: {},
      // A note's own name. Reading this as a launcher tile would make the rule
      // fire on the vault's content, which is not wiring.
      files: {
        [`${FLOWS_DIR}/c.mjs`]: 'tapOn("Open Mom\'s chili, written down")',
      },
      want: [],
    },
    {
      name: "a lane preamble that never seeds the corpus is flagged",
      roster: { suites, lanes, flows: cleanRoster },
      matrix: {},
      files: {
        [LANE_PREAMBLE]:
          "adb install -r app.apk\nexport MAESTRO_PLATFORM=android",
      },
      want: ["corpus"],
    },
    {
      name: "seeding AFTER the handoff is flagged, not accepted as present",
      roster: { suites, lanes, flows: cleanRoster },
      matrix: {},
      files: {
        [LANE_PREAMBLE]: [
          "export MAESTRO_PLATFORM=android",
          `node ${SEEDER}`,
        ].join("\n"),
      },
      want: ["corpus"],
    },
    {
      name: "a commented-out seeder does not satisfy the rule",
      roster: { suites, lanes, flows: cleanRoster },
      matrix: {},
      files: {
        [LANE_PREAMBLE]: [
          `# node ${SEEDER} — removed while debugging`,
          "export MAESTRO_PLATFORM=android",
        ].join("\n"),
      },
      want: ["corpus"],
    },
  ];

  return { apps, cases, files, flows, readFile, runners, suites };
}
