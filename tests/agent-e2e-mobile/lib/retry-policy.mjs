// RETRY IS CLASSIFICATION, NOT FORGIVENESS (#890 W6).
//
// Before this, the mobile layer had no flow-level retry at all — the nightly
// README's "flake budget: one retry at the flow harness" described something
// that did not exist. The tempting fix is a blanket `|| retry once`, and that
// is the fix this module refuses, because a suite that retries everything
// cannot tell a driver disconnect from a regression and will eventually pass
// over a real defect on the second attempt.
//
// THE RULE. One clean-state retry, for an INFRASTRUCTURE-classified failure
// only. A product assertion is never retried: an `assertVisible` timeout is the
// exact shape a real regression takes, so retrying it is how a suite learns to
// forgive itself. `lib/failure-class.mjs` owns the classification and defaults
// to `product` when it cannot tell — the safe direction, because a
// misclassified infra failure costs one wasted retry while a misclassified
// product failure costs the whole point of the suite.
//
// BOTH ATTEMPTS' EVIDENCE IS KEPT. Each attempt runs under its own `runId`, so
// its run directory, verdict and screenshots survive independently, and both
// append a record to the run ledger. A retry that erased the first attempt
// would destroy the only evidence that the flake happened at all — which is the
// data the promotion pipeline and the drift budgets read.
//
// ONE retry per flow per suite run, never a loop. "Retry until green" is the
// thing being forbidden, and a cap of one is what makes the difference visible:
// a flow that needs two is not flaky, it is broken.

import { promises as fs } from "node:fs";
import path from "node:path";

import { ledgerPathFromEnv } from "./run-ledger.mjs";

/**
 * The most recent ledger record for a flow on a platform, or null.
 *
 * Reading the LEDGER rather than the verdict is deliberate: the ledger is where
 * `runFlow` already wrote the classification, so the runner needs no second
 * classifier and the two can never disagree about why a run failed.
 */
export async function lastRecord(
  flow,
  platform,
  ledgerPath = ledgerPathFromEnv()
) {
  const raw = await fs.readFile(ledgerPath, "utf8").catch(() => null);
  if (raw == null) return null;
  let ledger;
  try {
    ledger = JSON.parse(raw);
  } catch {
    // A truncated ledger is a reason to skip the retry, not to fail the suite:
    // the flow's own verdict is still the authority on pass/fail.
    return null;
  }
  const slug = path.posix.basename(flow, ".mjs");
  const matching = (ledger.records ?? []).filter(
    (record) =>
      (record.slug === slug ||
        path.posix.basename(record.flow ?? "") === flow) &&
      (platform == null || record.platform === platform)
  );
  return matching.at(-1) ?? null;
}

/**
 * Decide whether a failed flow earns its one retry.
 *
 * @returns `{ retry: boolean, reason: string }` — `reason` is printed either
 *   way, because "not retried, and here is why" is the half a reader needs when
 *   a suite goes red and somebody asks whether it was flaky.
 */
export function decideRetry({ record, alreadyRetried }) {
  if (alreadyRetried) {
    return {
      retry: false,
      reason:
        "already retried once this run — a flow that needs two attempts is not flaky, it is broken",
    };
  }
  if (record == null) {
    return {
      retry: false,
      reason:
        "no ledger record for the failed attempt, so its failure class is unknown; " +
        "an unknown class is treated as product, never as infrastructure",
    };
  }
  if (record.failureClass !== "infrastructure") {
    return {
      retry: false,
      reason: `failure classified ${record.failureClass ?? "product"} (${record.failureReason ?? "no reason recorded"}) — product assertions are never retried`,
    };
  }
  return {
    retry: true,
    reason: `failure classified infrastructure (${record.failureReason ?? record.signal ?? "no reason recorded"}) — one clean-state retry, both attempts' evidence kept`,
  };
}

/**
 * The whole policy, against the ledger on disk.
 *
 * @param flow flow file basename, e.g. `"cold-start.mjs"`
 * @param platform `"ios"` | `"android"` | undefined
 * @param alreadyRetried whether this flow has spent its retry this run
 */
export async function shouldRetry(flow, platform, alreadyRetried, ledgerPath) {
  const record = await lastRecord(flow, platform, ledgerPath);
  return decideRetry({ record, alreadyRetried });
}
