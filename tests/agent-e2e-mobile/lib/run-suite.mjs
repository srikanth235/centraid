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

import { spawn } from "node:child_process";
import path from "node:path";

import { shouldRetry } from "./retry-policy.mjs";

const FLOWS_DIR = path.join(import.meta.dirname, "..", "flows");

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
async function runFlowWithPolicy(file, { label, env, platform }) {
  const code = await spawnFlow(file, env);
  if (code === 0) return 0;

  const verdict = await shouldRetry(file, platform, false).catch(() => ({
    retry: false,
    reason: "the run ledger could not be read; treating the failure as product",
  }));
  console.error(`[${label}] ${file} failed — ${verdict.reason}`);
  if (!verdict.retry) return code;

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

  // RECURSIVE, not a `for` loop with an `await` inside it. The members share one
  // device, one gateway and — in the seated suites — one pairing, so they are
  // strictly sequential and `Promise.all` would be wrong rather than faster. The
  // recursion is what the four runners this replaces already used, for the same
  // reason: it says "one at a time" in a shape the linter reads as intentional.
  async function runFrom(index, exitCode) {
    const file = flows[index];
    if (!file) return exitCode;
    const reuse = reuseAfter != null && index >= reuseAfter;
    const code = await runFlowWithPolicy(file, {
      label: name,
      platform: resolvedPlatform,
      env: {
        ...baseEnv,
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
