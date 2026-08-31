// The shared body of every Maestro suite runner (#890 W6).
//
// Four runners — pr-gate, ios-depth, photos, home-apps, probes — had four copies
// of the same spawn/aggregate/budget code, which is how the home-apps runner's
// failure message came to say "six … eleven minutes" for a seven-flow, twelve-
// minute suite: the constants moved twice and the sentence once. Everything
// derived is derived here, once.
//
// What stays in each runner file, and why it must:
//
//   const FLOWS = [ … ]              scripts/lint-e2e-wiring.mjs and
//   const BUDGET_MS = N * 60_000     scripts/test-report/validate-report-registries.mjs
//                                    both read these literals off disk to derive
//                                    what a lane schedules and what it may cost.
//                                    Hiding either behind a call would make the
//                                    schedule underivable — which is the exact
//                                    property those two gates exist to protect.
//
// The retry policy lives in retry-policy.mjs and is applied here rather than in
// each runner, so no runner can quietly acquire a more generous one.
//
// #892 P0 — THE BUDGET IS A DEADLINE, NOT A VERDICT. It used to be scored only
// after every member had run to completion, which is why `mobile-device-gate`
// could report 17m38s against a twelve-minute budget: nothing in this file
// stopped at twelve. Two things could each overrun it on their own and neither
// was bounded by it —
//
//   the classified retry   one infrastructure-classified failure re-runs a whole
//                          journey INSIDE the wall clock the budget measures.
//                          Five members at budget plus one multi-minute retry is
//                          exactly the observed overrun, and the budget doc's own
//                          remedy #2 names it ("a run that spent minutes retrying
//                          an infrastructure-classified failure").
//   the chunk timeout      `MAESTRO_CHUNK_TIMEOUT_MS` is twelve minutes, i.e. the
//                          entire pr-gate budget, so ONE wedged chunk could spend
//                          it before the suite ever compared anything.
//
// Both are fixed by giving the run a deadline and handing it down: a member is
// not started when the budget is already spent, a retry is refused when it
// cannot fit in what remains, and the harness clamps each Maestro chunk to the
// time actually left (CENTRAID_MOBILE_DEADLINE_MS below). The twelve minutes are
// unchanged — the number was never the problem; nothing enforced it.

import { spawn } from "node:child_process";
import path from "node:path";

import { shouldRetry } from "./retry-policy.mjs";

const FLOWS_DIR = path.join(import.meta.dirname, "..", "flows");

/**
 * Whether the budget can still afford an attempt that costs `costMs`.
 *
 * Exported for the unit suite: the refusal is the load-bearing half (a retry
 * that overruns the gate is the failure this module exists to stop), and it is
 * pure arithmetic that must not need a device to exercise.
 *
 * @param {number} remainingMs milliseconds left before the deadline
 * @param {number} costMs what the attempt is expected to cost (the first
 *   attempt's own elapsed time is the only honest estimate available)
 * @returns {boolean} true when the attempt fits
 */
export function fitsInBudget(remainingMs, costMs) {
  return remainingMs > 0 && remainingMs >= costMs;
}

function spawnFlow(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(FLOWS_DIR, file)], {
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/**
 * Run one flow, with the classified single retry.
 *
 * The retry decision is printed either way. "Not retried, because the failure
 * was a product assertion" is the half a reader needs when a suite goes red and
 * somebody asks whether it was just flaky — without it, the absence of a retry
 * is indistinguishable from a policy that forgot to consider one.
 */
async function runFlowWithPolicy(file, { label, env, platform, remainingMs }) {
  const attemptStartedAt = Date.now();
  const code = await spawnFlow(file, env);
  if (code === 0) return 0;
  const attemptMs = Date.now() - attemptStartedAt;

  const verdict = await shouldRetry(file, platform, false).catch(() => ({
    retry: false,
    reason: "the run ledger could not be read; treating the failure as product",
  }));
  console.error(`[${label}] ${file} failed — ${verdict.reason}`);
  if (!verdict.retry) return code;

  // #892 P0 — the retry lives inside the wall clock the budget measures, so it
  // has to be affordable in what is left. Refusing it is not forgiving the
  // failure (the flow is already red either way); it is refusing to turn one
  // infrastructure blip into a gate that answers five minutes late.
  const remainingForRetry = remainingMs == null ? Infinity : remainingMs();
  if (!fitsInBudget(remainingForRetry, attemptMs)) {
    console.error(
      `[${label}] ${file} NOT retried: the attempt cost ${Math.ceil(attemptMs / 1000)}s and ` +
        `${Math.max(0, Math.ceil(remainingForRetry / 1000))}s of budget remain. A retry that ` +
        `overruns the gate costs more than the signal it buys — treat this as infrastructure ` +
        `and re-run the lane.`
    );
    return code;
  }

  console.error(`[${label}] ${file} retry 1/1 (clean state)`);
  // The retry runs under its own runId, so the first attempt's run directory,
  // verdict and screenshots survive beside it rather than being overwritten.
  const retryCode = await spawnFlow(file, {
    ...env,
    CENTRAID_MOBILE_RETRY: "1",
  });
  if (retryCode === 0) {
    console.error(
      `[${label}] ${file} passed on the infrastructure retry; both attempts' ` +
        `evidence is in tests/agent-e2e-mobile/runs/ and both are in the ledger`
    );
  }
  return retryCode;
}

/**
 * Run a suite: an optional short-circuiting canary, then the rest, then the
 * aggregate budget.
 *
 * @param options.name          suite label for log lines
 * @param options.flows         the runner's own FLOWS array, in order
 * @param options.budgetMs      the runner's own BUDGET_MS
 * @param options.lane          CENTRAID_MOBILE_LANE default for the children
 * @param options.platform      forced MAESTRO_PLATFORM, when the suite pins one
 * @param options.canaryCount   how many leading members short-circuit (0 or 1)
 * @param options.reuseAfter    index from which MAESTRO_REUSE_PAIRED_STATE=1 is
 *                              set; `null` means never (the probes suite, whose
 *                              members deliberately do not share a pairing)
 * @param options.onBudgetBreach message appended to the budget failure
 * @returns the process exit code
 */
export async function runSuite({
  name,
  flows,
  budgetMs,
  lane,
  platform,
  canaryCount = 0,
  reuseAfter = null,
  onBudgetBreach = "",
}) {
  const baseEnv = {
    CENTRAID_MOBILE_LANE: process.env.CENTRAID_MOBILE_LANE ?? lane,
    ...(platform ? { MAESTRO_PLATFORM: platform } : {}),
  };
  const resolvedPlatform = platform ?? process.env.MAESTRO_PLATFORM;
  const startedAt = Date.now();
  // The one clock every bound below reads. Handed to each child as an ABSOLUTE
  // epoch time rather than a duration, because the child is a separate process
  // that starts later: a duration would silently restart the budget per member,
  // which is the accounting that let five members each fit and the suite not.
  const deadlineAt = startedAt + budgetMs;
  const remainingMs = () => deadlineAt - Date.now();

  // RECURSIVE, not a `for` loop with an `await` inside it. The members share one
  // device, one gateway and — in the seated suites — one pairing, so they are
  // strictly sequential and `Promise.all` would be wrong rather than faster. The
  // recursion is what the four runners this replaces already used, for the same
  // reason: it says "one at a time" in a shape the linter reads as intentional.
  async function runFrom(index, exitCode) {
    const file = flows[index];
    if (!file) return exitCode;
    // Stop AT the deadline rather than discovering it afterwards. The members
    // that did run keep their verdicts and evidence; the ones that did not are
    // named as unrun, which is the honest report — a greyed cell whose cause is
    // stated beats a red one that spent five extra minutes earning the same
    // verdict.
    if (remainingMs() <= 0) {
      console.error(
        `[${name}] FAIL: the ${budgetMs / 60_000}-minute budget was spent after ` +
          `${index} of ${flows.length} journey(s). The remaining ${flows.length - index} ` +
          `did not run. Do not raise the budget to buy time. ${onBudgetBreach}`.trim()
      );
      return 1;
    }
    const reuse = reuseAfter != null && index >= reuseAfter;
    const code = await runFlowWithPolicy(file, {
      label: name,
      platform: resolvedPlatform,
      remainingMs,
      env: {
        ...baseEnv,
        // Read by lib/harness.mjs, which clamps every Maestro chunk to what is
        // left. Without it a single chunk's own twelve-minute ceiling is the
        // whole suite budget and can spend it alone.
        CENTRAID_MOBILE_DEADLINE_MS: String(deadlineAt),
        ...(reuse ? { MAESTRO_REUSE_PAIRED_STATE: "1" } : {}),
      },
    });
    if (code === 0) return runFrom(index + 1, exitCode);
    // A canary short-circuits; every other member does not. Everywhere else a
    // mid-run failure must not grey the later cells (#535 F4), but a broken
    // prerequisite would grey them for a reason they cannot name.
    if (index < canaryCount) {
      console.error(
        `[${name}] FAIL: the shared prerequisite did not complete — the ` +
          `${flows.length - canaryCount} journey(s) after it were not run. Their ` +
          `verdicts would have named their own assertions, not the cause.`
      );
      return 1;
    }
    return runFrom(index + 1, 1);
  }

  let exitCode = await runFrom(0, 0);
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[${name}] aggregate ${Math.ceil(elapsedMs / 1000)}s / ${budgetMs / 1000}s budget`
  );
  if (elapsedMs >= budgetMs) {
    // Derived from the caller's own constants, never written out — see this
    // file's header for the sentence that drifted before it was.
    console.error(
      `[${name}] FAIL: ${flows.length} journeys exceeded ${budgetMs / 60_000} minutes. ` +
        `Do not raise the budget to buy time. ${onBudgetBreach}`.trim()
    );
    exitCode = 1;
  }
  return exitCode;
}
