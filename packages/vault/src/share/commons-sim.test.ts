// Seeded deterministic simulation of the Commons sharing plane (#731): one
// randomized program per case, quiesced, then held to the golden invariants.
// A failure prints the seed, which replays the schedule byte-for-byte. Opening
// the real vaults dwarfs the per-action cost, so LENGTHEN an existing seed's
// program rather than adding a seed; sweeps belong in a local file.

import { describe, expect, test } from "vitest";

import { runRevocationSeveranceProbe } from "./commons-sim-grant.test-fixtures.js";
import type { SimReport } from "./commons-sim-world.test-fixtures.js";
import {
  ACTION_WEIGHTS,
  runCommonsSimulation,
} from "./commons-sim.test-fixtures.js";

/**
 * A seed that caught a real bug is pinned forever. While its defect is open,
 * move it into a `test.fails` case so the failure is recorded, not tolerated.
 */
const REGRESSION_SEEDS: readonly number[] = [];

const SEEDS: readonly number[] = [731_001, 731_002];

const SIM_TIMEOUT_MS = 120_000;

function explain(result: SimReport): string {
  return [
    `commons simulation failed for seed ${result.seed}`,
    `weights: ${JSON.stringify(ACTION_WEIGHTS)}`,
    `stats:   ${JSON.stringify(result.stats)}`,
    "failures:",
    ...result.failures.map((failure) => `  - ${failure}`),
    "pinned (tolerated, each naming an open defect):",
    ...result.pinned.map((entry) => `  - ${entry}`),
    "trace:",
    ...result.trace.map((entry) => `  ${entry}`),
  ].join("\n");
}

describe("commons deterministic simulation", () => {
  test(
    "the same seed produces the same program",
    () => {
      const twice = [0, 1].map(() =>
        runCommonsSimulation({
          seed: 731_001,
          actions: 15,
          seats: 3,
          grants: 1,
        })
      );
      const [first, second] = twice as [SimReport, SimReport];
      expect(second.stats).toStrictEqual(first.stats);
      expect(second.failures).toStrictEqual(first.failures);
      // Traces carry vault-generated ids, so compare shape, not bytes.
      expect(second.trace.map((entry) => entry.split(" ")[1])).toStrictEqual(
        first.trace.map((entry) => entry.split(" ")[1])
      );
    },
    SIM_TIMEOUT_MS
  );

  test(
    "the grant plane replays from its seed too",
    () => {
      const twice = [0, 1].map(() =>
        runCommonsSimulation({
          seed: 839_002,
          actions: 40,
          seats: 2,
          grants: 2,
          grantPlane: true,
        })
      );
      const [first, second] = twice as [SimReport, SimReport];
      expect(second.stats).toStrictEqual(first.stats);
      expect(second.failures).toStrictEqual(first.failures);
      expect(second.pinned).toHaveLength(first.pinned.length);
      // This case proves the SCHEDULE replays; 839001 proves the invariants,
      // so the vacuity notice is the only break it may carry.
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

  test.each([...SEEDS, ...REGRESSION_SEEDS])(
    "seed %i converges and holds every golden invariant",
    (seed) => {
      const result = runCommonsSimulation({
        seed,
        actions: 160,
        seats: 4,
        grants: 2,
      });
      expect(result.failures, explain(result)).toStrictEqual([]);
      // A program that never ran the disruptive legs proves nothing.
      expect(result.stats["member_pull"] ?? 0).toBeGreaterThan(0);
      expect(result.stats["crash_restart"] ?? 0).toBeGreaterThan(0);
      expect(result.stats["compaction"] ?? 0).toBeGreaterThan(0);
    },
    SIM_TIMEOUT_MS
  );

  test(
    "a five-seat, three-grant world with heavy overlap also converges",
    () => {
      const result = runCommonsSimulation({
        seed: 731_100,
        actions: 90,
        seats: 5,
        grants: 3,
      });
      expect(result.failures, explain(result)).toStrictEqual([]);
    },
    SIM_TIMEOUT_MS
  );

  /**
   * The grant plane (#839): ONE long program, deliberately not a second seed.
   * Both planes share four vaults, so a grant is delivered, tampered with,
   * revoked and propagated WHILE the commons rail compacts and restarts.
   */
  test(
    "seed 839001 interleaves the grant lifecycle with the commons rail",
    () => {
      const result = runCommonsSimulation({
        seed: 839_001,
        actions: 320,
        seats: 4,
        grants: 2,
        grantPlane: true,
      });
      expect(result.failures, explain(result)).toStrictEqual([]);
      // The grant verbs must not crowd the commons legs out.
      expect(result.stats["member_pull"] ?? 0).toBeGreaterThan(0);
      expect(result.stats["crash_restart"] ?? 0).toBeGreaterThan(0);
      expect(result.stats["compaction"] ?? 0).toBeGreaterThan(0);
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
        "revoke_consent_grant",
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
   * REGRESSION LOCK for defect D1 (#846). `fulfillShareGrant` drops a
   * `delivered` row to `syncing` when one pass cannot reach the peer, and
   * propagation once read that as never-delivered, settling `removed` while
   * the audience still held the projection. Delivery is now remembered in
   * `delivered_at`, so this probe severs.
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
