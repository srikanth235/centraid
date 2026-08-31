// The Photos seat, as one suite sharing ONE simulator boot and ONE pairing.
// Sibling runners, same shape: run-home-apps-suite.mjs (the seven covers that
// are not Photos) and run-probes-suite.mjs (#890 W0 — the standalone journeys
// that were unbudgeted).
//
// `photos-permissions` is FIRST and pairs fresh: it owns the empty-vault denial
// state, so it must run before anything seeds the corpus. Every later member
// runs with MAESTRO_REUSE_PAIRED_STATE=1 (`reuseAfter: 1`) against the profile
// it leaves behind, and every one still writes an independent verdict — a
// mid-run failure must not grey the later cells (#535 F4).

import { runSuite } from "./lib/run-suite.mjs";

const FLOWS = [
  "photos-permissions.mjs",
  "photos-library.mjs",
  "photos-viewer.mjs",
  "photos-search.mjs",
  "photos-select-write.mjs",
];
// See flows/photos-budget.md for how this ceiling was derived and what to do
// when it is breached. Do not raise it to buy time.
const BUDGET_MS = 8 * 60_000;

process.exitCode = await runSuite({
  name: "photos",
  flows: FLOWS,
  budgetMs: BUDGET_MS,
  lane: "nightly-android",
  canaryCount: 0,
  reuseAfter: 1,
  onBudgetBreach: "See flows/photos-budget.md.",
});
