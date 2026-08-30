// The seven home-journey covers that are not Photos (issue #839 gap G8; People
// added by #864, Tally by #873), run as one suite so they share ONE simulator
// boot and ONE fresh pairing.
//
// Shape is deliberately identical to run-photos-suite.mjs: the first flow pairs
// against the gateway, every later flow runs with MAESTRO_REUSE_PAIRED_STATE=1
// and relaunches into that paired profile instead of redeeming a second ticket.
// Every journey still writes an independent verdict, including after an earlier
// failure — a mid-run failure must not grey the later cells (#535 F4).

import path from "node:path";

import { runMobileSuite } from "./lib/suite-runner.mjs";

// Docs stays FIRST: it is the flow that pairs fresh, and every later entry runs
// with MAESTRO_REUSE_PAIRED_STATE=1 against the profile it left behind.
// `locker-gate` stays LAST because it is the only member that restarts the app.
const FLOWS = [
  "docs-drive.mjs",
  "agenda-week.mjs",
  "notes-library.mjs",
  "tasks-board.mjs",
  "people-roster.mjs",
  "tally-derived.mjs",
  "locker-gate.mjs",
];
const FLOW_NAMES = [
  "Docs",
  "Agenda",
  "Notes",
  "Tasks",
  "People",
  "Tally",
  "Locker",
];
// See flows/home-apps-budget.md for how this ceiling was derived and what to do
// when it is breached. Do not raise it to buy time.
const BUDGET_MS = 12 * 60_000;
const flowsDir = path.join(import.meta.dirname, "flows");

await runMobileSuite({
  suite: "Home app functionality",
  budgetMs: BUDGET_MS,
  flows: FLOWS.map((file, index) => ({
    name: FLOW_NAMES[index],
    file: path.join(flowsDir, file),
    reusePairedState: index > 0,
  })),
});
