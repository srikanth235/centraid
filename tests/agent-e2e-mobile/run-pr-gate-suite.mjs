// THE CRITICAL FIVE — the device signal that lands before merge (#890 W4).
//
// Mobile is the primary surface and, until this suite, no mobile journey ran on
// any PR: `mobile-smoke` in ci.yml was a bundle export plus `compileDebugKotlin`,
// which proves the app builds and nothing about whether it works. A surface that
// gets its first device signal the night AFTER merge has a feedback loop that
// contradicts its own priority.
//
// The five claims are chosen to be the smallest set whose failure means "do not
// merge this", not a sample of the roster. Everything else is depth and belongs
// to the per-merge canary and the nightly:
//
//   1. PAIRING WORKS.            pairing-canary — the shared prerequisite of
//      every other journey. It runs FIRST in BOTH legs and SHORT-CIRCUITS: when
//      the gateway cannot mint a ticket or the phone cannot redeem one, the
//      members behind it would each fail with their own unrelated-looking
//      assertion after their own several minutes, and the run's headline would
//      name whichever one happened to be last. Failing here costs ~5 minutes and
//      names the cause.
//   2. A WRITE ROUND-TRIPS AND SURVIVES PROCESS DEATH.   notes-library
//   3. SETTINGS LOADS, THE APP SURVIVES A RESTART, AND AN OFFLINE WRITE
//      RECONNECTS AND SYNCS.                             native-v0-resilience
//   4. COLD START OVER EXISTING DATA.                    cold-start
//   5. A REFUSED OS PERMISSION DEGRADES GRACEFULLY.      photos-permissions
//
// THE FIVE RUN AS TWO PARALLEL LEGS (#905), because in sequence they measured
// ~795s against a 720s deadline and the fifth was starved every run. Claims 3
// and 4 are `run-pr-gate-resilience-suite.mjs` on a second emulator; this file
// is the PAIRED leg and keeps 1, 2 and 5. The arithmetic, and the extra pairing
// the split costs, are in flows/pr-gate-budget.md.
//
// ORDER IS LOAD-BEARING within a leg. `pairing-canary` pairs fresh, so every
// later member runs with MAESTRO_REUSE_PAIRED_STATE=1 against the profile it
// leaves behind (the run-photos-suite / run-home-apps-suite pattern — one boot,
// one pairing). And `photos-permissions` is LAST because it is the only member
// that launches with `permissions: { all: deny }` on a cleared client: running
// it earlier would destroy the paired profile the others reuse.
//
// Budget: see flows/pr-gate-budget.md. The envelope is 12 minutes wall PER LEG
// on a WARM runner (a restored native shell); a cold build is the build job's
// cost, not this suite's, which is exactly why #890 W1 split building from
// testing.

import { runSuite } from "./lib/run-suite.mjs";

// ONE authoritative member list, and the FIRST member is the canary
// (`canaryCount: 1` below): scripts/lint-e2e-wiring.mjs and
// scripts/test-report/validate-report-registries.mjs both read this literal off
// disk to derive what the lane schedules, so a member kept in a second variable
// would be invisible to the linter that exists to catch exactly that.
const FLOWS = [
  "pairing-canary.mjs",
  "notes-library.mjs",
  "photos-permissions.mjs",
];

// The W4 envelope, unchanged by the split into two legs: twelve minutes is now
// per leg and wall-clock for the gate. Derived, not observed — see
// flows/pr-gate-budget.md for the arithmetic and for the rule that this becomes
// a measured p95 ratchet off tests/agent-e2e-mobile/ledger/durations.json once
// three real runs exist.
const BUDGET_MS = 12 * 60_000;

process.exitCode = await runSuite({
  name: "pr-gate",
  flows: FLOWS,
  budgetMs: BUDGET_MS,
  lane: "pr-gate",
  canaryCount: 1,
  reuseAfter: 1,
  onBudgetBreach:
    "The PR gate's whole value is that it answers before a human context-switches.",
});
