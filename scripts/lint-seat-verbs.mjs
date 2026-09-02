#!/usr/bin/env node
// SEAT-VERB linter (issue #890 W5). The third of the three #890 linters, after
// lint-e2e-wiring (does anything RUN this flow?) and lint-mobile-testids (does
// the thing this flow selects EXIST?). This one asks the question those two
// cannot: is there a journey for every act only this seat can perform?
//
// Why it exists. `packages/blueprints/apps/*/app.json` declares `seats.originActs`
// — the acts only the phone can do: a camera, a scanner, a voice capture, an
// autofill provider. Each is by construction a device-only claim, and until this
// register there was no way to answer "are all critical journeys covered?"
// except by reading eight manifests and eighteen flows and holding them in your
// head. The answer, once asked mechanically, was: five acts declared, zero
// journeys. That is not a failure of this linter; it is what the linter is for.
//
// The rules:
//
//   RULE registered      Every `<app>.<act>` a manifest declares has a row in
//     tests/agent-e2e-mobile/origin-acts.json. A NEW APP OR A NEW VERB CANNOT
//     LAND without a journey or a conscious gap — that is the whole point.
//
//   RULE no-phantom      Every row names an act some manifest still declares. A
//     verb deleted from a manifest must not leave a coverage claim behind.
//
//   RULE owned-is-real   An `owner` row names a flow file that EXISTS and that
//     tests/agent-e2e-mobile/roster.json schedules. An owner nothing runs is the
//     same defect lint-e2e-wiring catches from the other side, and the two must
//     agree or the register is a second place for the truth to be wrong.
//
//   RULE dated-gap       A `gap` row carries `since` (an ISO date), a
//     `trackingIssue` registered and OPEN in tests/claims.json, and a `blocker`
//     that is a paragraph, not a shrug. An undated gap is indistinguishable from
//     an oversight, and the audit ritual has nothing to read.
//
//   RULE stale-gap       A gap older than STALE_AFTER_DAYS fails, so the register
//     cannot become a place where things are put to be forgotten. The remedy is
//     never to bump the date: it is to write the journey, or to re-date the row
//     WITH a re-stated blocker, which is a deliberate act somebody signs.
//
// Following lint-e2e-flows.mjs: a silent no-op is a FAILURE, and a self-test of
// the rules runs first so the linter cannot rot into always-passing.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const APPS_DIR = "packages/blueprints/apps";
const REGISTER_PATH = "tests/agent-e2e-mobile/origin-acts.json";
const ROSTER_PATH = "tests/agent-e2e-mobile/roster.json";
const MATRIX_PATH = "tests/claims.json";

// A year. Long enough that a genuinely blocked act is not busywork, short
// enough that no gap outlives the person who understood it. Re-dating is a
// deliberate act with a re-stated blocker, never a bump.
const STALE_AFTER_DAYS = 365;

/** Every `<app>.<act>` the shipped manifests declare. Read from disk, never
 * listed here: a hand-kept app list is how a new app escapes a gate. */
export function declaredActs(root = ROOT) {
  const acts = new Map();
  const appsDir = path.resolve(root, APPS_DIR);
  for (const app of readdirSync(appsDir).sort()) {
    if (app.startsWith("_")) continue; // shared modules, not apps
    const manifestPath = path.join(appsDir, app, "app.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const act of manifest.seats?.originActs ?? []) {
      acts.set(`${app}.${act}`, {
        app,
        act,
        manifest: `${APPS_DIR}/${app}/app.json`,
      });
    }
  }
  return acts;
}

const dayMs = 24 * 60 * 60 * 1000;
/** Whole days between an ISO date and `now`, or null when unparseable. */
export function ageInDays(since, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(since ?? ""))) return null;
  const parsed = Date.parse(`${since}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return Math.floor((now - parsed) / dayMs);
}

/** The rule engine. Pure over an injected world so the self-test can drive it. */
export function lintSeatVerbs({
  acts,
  register,
  scheduledFlows,
  existingFlows,
  trackingIssues,
  now = Date.now(),
}) {
  const findings = [];
  const fail = (rule, message) => findings.push({ rule, message });
  const rows = register.acts ?? {};

  for (const [key, declared] of acts) {
    if (!rows[key]) {
      fail(
        "registered",
        `${declared.manifest} declares originAct "${declared.act}" with no row for ` +
          `${key} in ${REGISTER_PATH}. Every act only the phone can perform owes ` +
          `either an owning journey or a dated, reasoned gap — a new verb may not ` +
          `land silently.`
      );
    }
  }

  for (const [key, row] of Object.entries(rows)) {
    if (!acts.has(key)) {
      fail(
        "no-phantom",
        `${REGISTER_PATH} registers ${key}, which no app manifest declares any ` +
          `more. Delete the row; a verb that was removed must not leave a coverage ` +
          `claim behind it.`
      );
      continue;
    }

    if (row.gap === true) {
      const age = ageInDays(row.since, now);
      if (age == null) {
        fail(
          "dated-gap",
          `${key} is a gap with no usable \`since\` (got ${JSON.stringify(row.since)}). ` +
            `An undated gap is indistinguishable from an oversight.`
        );
      } else if (age > STALE_AFTER_DAYS) {
        fail(
          "stale-gap",
          `${key}'s gap is ${age} days old (limit ${STALE_AFTER_DAYS}). Write the ` +
            `journey, or re-date the row WITH a re-stated blocker — do not bump the ` +
            `date. This register must not become a place things are put to be forgotten.`
        );
      }
      if (!(row.blocker?.length > 60)) {
        fail(
          "dated-gap",
          `${key}'s gap has no real \`blocker\`. State what makes it un-automatable ` +
            `TODAY, in enough detail that the next reader can tell whether that is ` +
            `still true — not what would be nice to have.`
        );
      }
      const issue = row.trackingIssue;
      const registered = trackingIssues[String(issue)];
      if (!registered) {
        fail(
          "dated-gap",
          `${key}'s gap cites tracking issue #${issue ?? "none"}, which is not ` +
            `registered in ${MATRIX_PATH}#trackingIssues.`
        );
      } else if (registered.state !== "open") {
        fail(
          "dated-gap",
          `${key}'s gap cites issue #${issue}, which is ${registered.state}. A gap ` +
            `tracked by a closed issue is tracked by nothing.`
        );
      }
      continue;
    }

    const owner = row.owner;
    if (typeof owner !== "string" || owner.length === 0) {
      fail(
        "owned-is-real",
        `${key} is neither \`gap: true\` nor an owned row with an \`owner\`. There ` +
          `is no third state: a verb is proven or it is a conscious gap.`
      );
      continue;
    }
    if (!existingFlows.has(owner)) {
      fail(
        "owned-is-real",
        `${key} names owner ${owner}, which does not exist.`
      );
      continue;
    }
    if (!scheduledFlows.has(owner)) {
      fail(
        "owned-is-real",
        `${key} names owner ${owner}, which ${ROSTER_PATH} does not schedule. An ` +
          `owner nothing runs is the same defect lint-e2e-wiring catches from the ` +
          `other side; the two registers must agree.`
      );
    }
    if (!(row.assertion?.length > 20)) {
      fail(
        "owned-is-real",
        `${key} claims ${owner} owns it but names no \`assertion\`. Name the ` +
          `sentence the flow asserts that carries this act, so a reader can check ` +
          `the claim without running it.`
      );
    }
  }

  return findings;
}

// ---- self-test: the rules on fixtures, before judging the repo.
function selfTest() {
  const base = {
    acts: new Map([
      ["photos.camera", { app: "photos", act: "camera", manifest: "m" }],
    ]),
    scheduledFlows: new Set(["flows/a.mjs"]),
    existingFlows: new Set(["flows/a.mjs", "flows/unscheduled.mjs"]),
    trackingIssues: { 890: { state: "open" }, 1: { state: "closed" } },
    now: Date.parse("2026-08-30T00:00:00Z"),
  };
  const blocker = "a".repeat(80);
  const assertion = "the sentence this flow asserts";
  const cases = [
    {
      name: "an undeclared act is flagged",
      register: { acts: {} },
      want: ["registered"],
    },
    {
      name: "a phantom row is flagged",
      register: {
        acts: {
          "photos.camera": {
            gap: true,
            since: "2026-08-01",
            trackingIssue: 890,
            blocker,
          },
          "gone.verb": {
            gap: true,
            since: "2026-08-01",
            trackingIssue: 890,
            blocker,
          },
        },
      },
      want: ["no-phantom"],
    },
    {
      name: "a well-formed dated gap is clean",
      register: {
        acts: {
          "photos.camera": {
            gap: true,
            since: "2026-08-01",
            trackingIssue: 890,
            blocker,
          },
        },
      },
      want: [],
    },
    {
      name: "an undated gap is flagged",
      register: {
        acts: { "photos.camera": { gap: true, trackingIssue: 890, blocker } },
      },
      want: ["dated-gap"],
    },
    {
      name: "a gap citing a closed issue is flagged",
      register: {
        acts: {
          "photos.camera": {
            gap: true,
            since: "2026-08-01",
            trackingIssue: 1,
            blocker,
          },
        },
      },
      want: ["dated-gap"],
    },
    {
      name: "a gap with a shrug for a blocker is flagged",
      register: {
        acts: {
          "photos.camera": {
            gap: true,
            since: "2026-08-01",
            trackingIssue: 890,
            blocker: "todo",
          },
        },
      },
      want: ["dated-gap"],
    },
    {
      name: "a stale gap is flagged",
      register: {
        acts: {
          "photos.camera": {
            gap: true,
            since: "2020-01-01",
            trackingIssue: 890,
            blocker,
          },
        },
      },
      want: ["stale-gap"],
    },
    {
      name: "an owned row on a scheduled flow is clean",
      register: {
        acts: { "photos.camera": { owner: "flows/a.mjs", assertion } },
      },
      want: [],
    },
    {
      name: "an owner nothing schedules is flagged",
      register: {
        acts: {
          "photos.camera": { owner: "flows/unscheduled.mjs", assertion },
        },
      },
      want: ["owned-is-real"],
    },
    {
      name: "an owner that does not exist is flagged",
      register: {
        acts: { "photos.camera": { owner: "flows/ghost.mjs", assertion } },
      },
      want: ["owned-is-real"],
    },
    {
      name: "an owned row with no assertion is flagged",
      register: { acts: { "photos.camera": { owner: "flows/a.mjs" } } },
      want: ["owned-is-real"],
    },
    {
      name: "a row that is neither owned nor a gap is flagged",
      register: { acts: { "photos.camera": { note: "someday" } } },
      want: ["owned-is-real"],
    },
  ];
  for (const testCase of cases) {
    const got = [
      ...new Set(
        lintSeatVerbs({ ...base, register: testCase.register }).map(
          (f) => f.rule
        )
      ),
    ].sort();
    const want = [...new Set(testCase.want)].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(
        `FAIL — lint-seat-verbs self-test "${testCase.name}": expected [${want}], got [${got}]`
      );
      process.exit(1);
    }
  }
}

function main() {
  selfTest();
  const read = (rel) => readFileSync(path.resolve(ROOT, rel), "utf8");
  const acts = declaredActs();
  const register = JSON.parse(read(REGISTER_PATH));
  const roster = JSON.parse(read(ROSTER_PATH));
  const matrix = JSON.parse(read(MATRIX_PATH));

  // Silent-no-op guards. Each of these reads as "clean" if unchecked: a moved
  // manifest directory, an emptied register, a roster that stopped declaring.
  if (acts.size === 0) {
    console.error(
      `\nFAIL — discovered zero originActs under ${APPS_DIR}. Either every app ` +
        `stopped declaring one (say so deliberately) or the manifest shape moved.\n`
    );
    process.exit(1);
  }

  const existingFlows = new Set(
    readdirSync(path.resolve(ROOT, "tests/agent-e2e-mobile/flows"))
      .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))
      .map((name) => `tests/agent-e2e-mobile/flows/${name}`)
  );
  const scheduledFlows = new Set(
    Object.entries(roster.flows ?? {})
      .filter(([, entry]) => entry.status !== "exploratory")
      .map(([flow]) => flow)
  );

  const findings = lintSeatVerbs({
    acts,
    register,
    scheduledFlows,
    existingFlows,
    trackingIssues: matrix.trackingIssues ?? {},
  });

  if (findings.length > 0) {
    console.error(
      `\nFAIL — ${findings.length} seat-verb defect(s): an act only the phone can ` +
        `perform, with neither a journey nor a conscious gap.\n`
    );
    for (const finding of findings) {
      console.error(`  [${finding.rule}] ${finding.message}\n`);
    }
    console.error(`See ${REGISTER_PATH} and issue #890.\n`);
    process.exit(1);
  }

  const rows = Object.values(register.acts ?? {});
  const owned = rows.filter((row) => row.gap !== true).length;
  console.log(
    `ok   seat-verbs — ${acts.size} origin act(s) declared, ${owned} owned by a ` +
      `scheduled journey, ${rows.length - owned} a dated gap with a live tracking issue`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
