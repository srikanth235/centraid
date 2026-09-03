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
    "tests/agent-e2e-mobile/run-x-suite.mjs":
      "// the wiring linter reads this shim's `resolvePlan({ rung, platform, suite })` call\n" +
      "process.exitCode = await runPlan(\n" +
      '  resolvePlan({ rung: 2, platform: "android", suite: "x" })\n' +
      ");",
    [`${FLOWS_DIR}/a.mjs`]: 'retryableTapCommands("Open Photos.*")',
    [`${FLOWS_DIR}/b.mjs`]: 'retryableTapCommands("Open Locker.*")',
    [`${FLOWS_DIR}/c.mjs`]: "// no cover taps here",
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
