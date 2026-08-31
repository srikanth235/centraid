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
    // The header comment above the declaration is deliberate: the unanchored
    // regex this replaced matched the PROSE, read its ellipsis as the body, and
    // called the runner empty. A linter that a comment about itself can defeat
    // is not a linter, so the fixture keeps the shape that defeated it.
    "tests/agent-e2e-mobile/run-x-suite.mjs":
      '// the wiring linter reads this runner\'s `const FLOWS = [ … ]` array\nconst FLOWS = ["a.mjs"];',
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

  // A roster that is CLEAN against every other rule, so a corpus case reports
  // the corpus rule alone: `a` is reached by the gate lane through the runner,
  // `b` directly by the nightly lane, and `c` by nothing (hence exploratory).
  const cleanRoster = {
    [`${FLOWS_DIR}/a.mjs`]: { status: "scheduled", claim },
    [`${FLOWS_DIR}/b.mjs`]: { status: "scheduled", claim },
    [`${FLOWS_DIR}/c.mjs`]: { status: "exploratory", claim },
  };

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
    // ---- RULE corpus (#905). Both halves, and a clean tree that proves the
    // rule is not simply always-on.
    {
      name: "a flow tapping a tile for an app with no corpus is flagged",
      roster: { lanes, flows: cleanRoster },
      matrix: {},
      files: {
        [`${FLOWS_DIR}/c.mjs`]: 'retryableTapCommands("Open Assistant.*")',
      },
      want: ["corpus"],
    },
    {
      name: "Locker needs no corpus — its tile is promoted on an empty vault",
      roster: { lanes, flows: cleanRoster },
      matrix: {},
      files: {
        [`${FLOWS_DIR}/c.mjs`]: 'retryableTapCommands("Open Locker.*")',
      },
      want: [],
    },
    {
      name: "a cover-shaped string that is not an app id is not a cover",
      roster: { lanes, flows: cleanRoster },
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
      roster: { lanes, flows: cleanRoster },
      matrix: {},
      files: {
        [LANE_PREAMBLE]:
          "adb install -r app.apk\nexport MAESTRO_PLATFORM=android",
      },
      want: ["corpus"],
    },
    {
      name: "seeding AFTER the handoff is flagged, not accepted as present",
      roster: { lanes, flows: cleanRoster },
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
      roster: { lanes, flows: cleanRoster },
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

  return { apps, cases, files, flows, readFile, runners };
}
