// Seeded deterministic simulation of the SUBSCRIPTION plane (#839, #929): one
// randomized program per case, quiesced, then held to the golden invariants.
// A failure prints the seed, which replays the schedule byte-for-byte. Opening
// the real vaults dwarfs the per-action cost, so LENGTHEN an existing seed's
// program rather than adding a seed; sweeps belong in a local file.

import { describe, expect, test } from "vitest";

import type { SimReport } from "./subscription-sim-world.test-fixtures.js";
import {
  GRANT_ACTION_WEIGHTS,
  runRevocationSeveranceProbe,
  runSubscriptionSimulation,
} from "./subscription-sim.test-fixtures.js";

/**
 * A seed that caught a real bug is pinned forever. While its defect is open,
 * move it into a `test.fails` case so the failure is recorded, not tolerated.
 */
const REGRESSION_SEEDS: readonly number[] = [];

const SEEDS: readonly number[] = [839_001];

const SIM_TIMEOUT_MS = 120_000;

function explain(result: SimReport): string {
  return [
    `subscription simulation failed for seed ${result.seed}`,
    `weights: ${JSON.stringify(GRANT_ACTION_WEIGHTS)}`,
    `stats:   ${JSON.stringify(result.stats)}`,
    "failures:",
    ...result.failures.map((failure) => `  - ${failure}`),
    "pinned (tolerated, each naming an open defect):",
    ...result.pinned.map((entry) => `  - ${entry}`),
    "trace:",
    ...result.trace.map((entry) => `  ${entry}`),
  ].join("\n");
}

describe("subscription deterministic simulation", () => {
  test(
    "the same seed produces the same program",
    () => {
      const twice = [0, 1].map(() =>
        runSubscriptionSimulation({ seed: 839_002, actions: 40, seats: 2 })
      );
      const [first, second] = twice as [SimReport, SimReport];
      expect(second.stats).toStrictEqual(first.stats);
      expect(second.failures).toStrictEqual(first.failures);
      expect(second.pinned).toHaveLength(first.pinned.length);
      // This case proves the SCHEDULE replays; the long seed below proves the
      // invariants, so the vacuity notice is the only break it may carry.
      expect(
        first.failures.every((entry) =>
          entry.startsWith("the grant plane proved nothing")
        ),
        explain(first)
      ).toBe(true);
      expect(second.trace.map((entry) => entry.split(" ")[1])).toStrictEqual(
        first.trace.map((entry) => entry.split(" ")[1])
      );
    },
    SIM_TIMEOUT_MS
  );

  /**
   * ONE long program, deliberately not a second seed: a subscription is
   * delivered, tampered with, revoked and propagated while channels churn and
   * confirmation-gated payloads park and settle around it.
   */
  test.each([...SEEDS, ...REGRESSION_SEEDS])(
    "seed %i converges and holds every golden invariant",
    (seed) => {
      const result = runSubscriptionSimulation({
        seed,
        actions: 320,
        seats: 4,
      });
      expect(result.failures, explain(result)).toStrictEqual([]);
      // The schedule is a pure function of the seed: exact facts, not hopes.
      for (const leg of [
        "grant_create",
        "grant_fulfill",
        "grant_origin_edit",
        "grant_audience_tamper",
        "grant_channel_churn",
        "grant_revoke",
        "grant_propagate",
        "park_confirmable",
        "settle_parked",
        "revoke_access_grant",
        // "The origin is the sole author" is empty unless something contested it.
        "grant_tamper_healed",
        // The precondition of the severance defect (#846).
        "reach_lost_after_delivery",
      ])
        expect(result.stats[leg] ?? 0, `${leg} never fired`).toBeGreaterThan(0);
      expect(result.pinned, explain(result)).toStrictEqual([]);
    },
    SIM_TIMEOUT_MS
  );

  /**
   * REGRESSION LOCK for defect D1 (#846). Delivery drops a `delivered` row to
   * `syncing` when one pass cannot reach the peer, and propagation once read
   * that as never-delivered, settling `removed` while the audience still held
   * the projection. Delivery is remembered in `delivered_at`, so this severs.
   */
  test(
    "a revocation severs a grant the host lost reach for mid-life",
    () => {
      const probe = runRevocationSeveranceProbe();
      expect(probe.state).toBe("removed");
      expect(probe.audienceTitles).toStrictEqual([]);
    },
    SIM_TIMEOUT_MS
  );
});
