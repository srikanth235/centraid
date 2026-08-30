// THE PROMOTION SUITE (#890 follow-up) — where new device signal serves its
// probation.
//
// D3 permits a promotion pipeline for NEW signal and forbids a `promoting` flow
// from ever running on a blocking lane. Until now the pipeline had a rule and no
// road: every committed flow was `scheduled`, so the only way to add one was to
// put it straight onto the settled roster, which is precisely the move D3 exists
// to prevent. This suite is the road.
//
// WHY A SEPARATE SUITE RATHER THAN ADDING TO run-probes-suite.mjs. Its budget.
// `flows/probes-budget.md` derives 33.5 minutes and ceilings at 35, so the slack
// is ninety seconds — less than one fresh pairing. Adding a flow there would
// force the ceiling up, and both `scripts/check-mobile-suite-budgets.mjs` (a
// tighten-only ratchet) and that document's own closing paragraph forbid it in
// as many words: "Never raise it to buy time… do not move a flow out of the
// suite to get under the number." A new suite prices its own members honestly
// instead of borrowing room from journeys that already earned theirs.
//
// EVERY MEMBER HERE HAS NEVER RUN. They were written in an environment with no
// emulator and no simulator, which is exactly the state `promoting` describes:
// real signal, unproven, allowed to run where it cannot hurt anyone. A member
// graduates to `scheduled` on the strength of nights recorded in the ledger, or
// it is deleted. It does not graduate by sitting here.

import { runSuite } from "./lib/run-suite.mjs";

const FLOWS = ["op-sqlite-probe.mjs", "share-intent-in.mjs"];
// See flows/promoting-budget.md for how this ceiling was derived and what to do
// when it is breached. Do not raise it to buy time.
const BUDGET_MS = 16 * 60_000;

process.exitCode = await runSuite({
  name: "promoting-suite",
  flows: FLOWS,
  budgetMs: BUDGET_MS,
  lane: "nightly-android",
  canaryCount: 0,
  // Each member pairs for itself: op-sqlite-probe restarts the app process
  // mid-flow and share-intent-in must be foregrounded and paired before the
  // intent lands, so neither can inherit the other's state. Same reasoning as
  // run-probes-suite.mjs, and the budget below prices the repeated pairing
  // rather than pretending it is shared.
  reuseAfter: null,
  onBudgetBreach: "See flows/promoting-budget.md.",
});
