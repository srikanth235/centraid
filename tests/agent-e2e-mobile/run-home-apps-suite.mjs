// The seven home-journey covers that are not Photos (issue #839 gap G8; People
// added by #864, Tally by #873), run as one suite so they share ONE simulator
// boot and ONE fresh pairing.
//
// Sibling runners, same shape: run-photos-suite.mjs (the Photos seat) and
// run-probes-suite.mjs (#890 W0 — the standalone journeys that were unbudgeted).
//
// Shape is deliberately identical to run-photos-suite.mjs: the first flow pairs
// against the gateway, every later flow runs with MAESTRO_REUSE_PAIRED_STATE=1
// and relaunches into that paired profile instead of redeeming a second ticket.
// Every journey still writes an independent verdict, including after an earlier
// failure — a mid-run failure must not grey the later cells (#535 F4).

import { runSuite } from "./lib/run-suite.mjs";

// Docs stays FIRST: it is the flow that pairs fresh, and every later entry runs
// with MAESTRO_REUSE_PAIRED_STATE=1 against the profile it left behind
// (`reuseAfter: 1`). `locker-gate` stays LAST because it is the only member
// that restarts the app.
const FLOWS = [
  "docs-drive.mjs",
  "agenda-week.mjs",
  "notes-library.mjs",
  "tasks-board.mjs",
  "people-roster.mjs",
  "tally-derived.mjs",
  "locker-gate.mjs",
];
// See flows/home-apps-budget.md for how this ceiling was derived and what to do
// when it is breached. Do not raise it to buy time.
const BUDGET_MS = 12 * 60_000;

process.exitCode = await runSuite({
  name: "home-apps",
  flows: FLOWS,
  budgetMs: BUDGET_MS,
  lane: "nightly-android",
  canaryCount: 0,
  reuseAfter: 1,
  onBudgetBreach:
    "Combine adjacent Maestro chunks and drop duplicate arrival assertions first; see flows/home-apps-budget.md.",
});
