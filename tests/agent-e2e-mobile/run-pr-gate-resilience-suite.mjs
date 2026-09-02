// THE RESILIENCE LEG of the PR device gate (#905). The critical five run as TWO
// legs on two emulators in parallel; `run-pr-gate-suite.mjs` is the paired leg
// (pairing-canary, notes-library, photos-permissions) and this is the other.
//
// WHY TWO LEGS. Measured on CI run 33582899886 (head 1485d8f4, after the cover
// tour moved down a tier and six Maestro spawns folded): pairing-canary 187s,
// notes-library 106s, native-v0-resilience 267s, cold-start 145s,
// photos-permissions ~90s to pass — ~795s against a 720s deadline, so the fifth
// member was starved on every run. No member left the gate and no assertion was
// loosened; what changed is the shape. Wall time is now the slower leg, bought
// with one extra pairing per run.
//
// ORDER IS LOAD-BEARING. `pairing-canary` is the shared prerequisite of both
// legs, so it runs FIRST here too and short-circuits; `cold-start` is LAST
// because it launches eight times over the paired profile the member before it
// leaves behind.

import { runSuite } from "./lib/run-suite.mjs";

// ONE authoritative member list, and the FIRST member is the canary
// (`canaryCount: 1` below): scripts/lint-e2e-wiring.mjs reads this literal off
// disk to derive what the lane schedules.
const FLOWS = [
  "pairing-canary.mjs",
  "native-v0-resilience.mjs",
  "cold-start.mjs",
];

// The SAME envelope as the paired leg, and unchanged by the split: twelve
// minutes is now per leg and wall-clock for the gate. Tightening it is the
// ledger's job once three runs exist — see flows/pr-gate-budget.md.
const BUDGET_MS = 12 * 60_000;

process.exitCode = await runSuite({
  name: "pr-gate-resilience",
  flows: FLOWS,
  budgetMs: BUDGET_MS,
  lane: "pr-gate",
  canaryCount: 1,
  reuseAfter: 1,
  onBudgetBreach:
    "The PR gate's whole value is that it answers before a human context-switches.",
});
