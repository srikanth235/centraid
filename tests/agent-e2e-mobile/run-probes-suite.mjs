// The six standalone journeys that grid G showed unbudgeted (#890 W0), wrapped
// so the set as a whole owns a ceiling. Sibling runners, same shape:
// run-photos-suite.mjs (the Photos seat) and run-home-apps-suite.mjs.
//
// This is a BUDGET WRAPPER, not a shared-boot suite, and that is the whole
// difference from its two siblings. Those pair once and let every later flow
// relaunch into the paired profile; these six cannot. `home-loads` deliberately
// runs on a CLEARED client — a paired profile is precisely the state it must
// not be in — and `native-v0-resilience` restarts the app process mid-flow.
// Setting MAESTRO_REUSE_PAIRED_STATE here would either make home-loads assert
// against a state it did not create or leave the later flows inheriting
// whatever the restart left behind. So each member pairs for itself, the
// pairing cost is paid five times, and the budget below prices that honestly
// rather than pretending the suite shares a boot it cannot share.
//
// Non-short-circuit like its siblings: every journey runs and writes its own
// verdict even after an earlier failure, so a mid-run failure cannot grey the
// later cells (#535 F4).

import { runSuite } from "./lib/run-suite.mjs";

const FLOWS = [
  "cold-start.mjs",
  "home-loads.mjs",
  "native-v0-resilience.mjs",
  "places-seat.mjs",
  "scroll-frames.mjs",
  "volume-proof.mjs",
];
// See flows/probes-budget.md for how this ceiling was derived and what to do
// when it is breached. Do not raise it to buy time.
const BUDGET_MS = 35 * 60_000;

process.exitCode = await runSuite({
  name: "probes-suite",
  flows: FLOWS,
  budgetMs: BUDGET_MS,
  lane: "nightly-android",
  canaryCount: 0,
  reuseAfter: null,
  onBudgetBreach: "See flows/probes-budget.md.",
});
