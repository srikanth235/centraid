// Seeded deterministic simulation of the Commons sharing plane (issue #731).
// Each case runs one randomized program of ~160 steward writes, signed member
// intents, pulls, roster churn, steward-transfer windows, compaction,
// crash-restarts, and stale-restores, then forces quiescence and asserts the
// golden invariants. On failure the seed plus the whole action trace prints, so
// the schedule replays byte-for-byte from the seed alone.
//
// Budget note: opening the real encrypted vaults costs a few seconds per case,
// and that fixed cost dwarfs the per-action cost (roughly 45 ms per action on
// an idle machine). Prefer LENGTHENING an existing seed's program over adding
// another seed — one long schedule finds more interleavings per second than two
// short ones, and it does not pay the world-build toll twice. Broad seed sweeps
// belong in a throwaway local file, not here.

import { describe, expect, test } from "vitest";

import { runRevocationSeveranceProbe } from "./commons-sim-grant.test-fixtures.js";
import type { SimReport } from "./commons-sim-world.test-fixtures.js";
import {
  ACTION_WEIGHTS,
  runCommonsSimulation,
} from "./commons-sim.test-fixtures.js";

/**
 * Shrink-lite: a seed the simulator has caught a real Commons bug on gets
 * pinned here forever, with the suspected defect named in a comment beside it.
 * While the defect is still open, move that seed out of this list into its own
 * `test.fails` case so the failure is recorded rather than tolerated.
 *
 * - 839_001 is the grant-plane seed below. It reaches DEFECT D1 (a revocation
 *   that settles `removed` while the audience keeps the projection, see
 *   `commons-sim-grant.test-fixtures.ts` `checkSeverance`); the defect itself
 *   is recorded by the `test.fails` case at the foot of this file, so the seed
 *   stays here as the schedule that found it.
 *
 * Nothing else: these seeds plus a wider offline sweep (44 seeds, 3–5 seats,
 * 1–3 grants, up to 260 actions each) found no non-converging schedule.
 */
const REGRESSION_SEEDS: readonly number[] = [];

/** Exploration seeds. Each opens four real on-disk vaults, so keep the list
 * short enough that the file stays a PR-suite citizen (TESTING.md). */
const SEEDS: readonly number[] = [731_001, 731_002];

const SIM_TIMEOUT_MS = 120_000;

/** The failure message IS the bug report: seed, weights, stats, full trace. */
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
      // A program this short cannot exercise the whole grant lifecycle and is
      // not asked to — the 839001 case above is what proves the invariants,
      // and this one proves the SCHEDULE replays. The oracle's own vacuity
      // notice is therefore the only break it may carry; anything else here
      // would be a regression hiding behind "both runs agreed".
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
      // A program that never exercised the disruptive legs proves nothing.
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
   * The grant plane (issue #839). ONE long program, deliberately not a second
   * seed: the world build is the fixed cost, so lengthening a schedule finds
   * more interleavings per second than starting another one. Both planes run
   * over the same four vaults, so a share grant is delivered, edited,
   * tampered with, cut off, revoked and propagated WHILE the commons rail is
   * compacting, transferring stewardship and crash-restarting underneath it.
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
      // The commons legs still fire — the grant verbs must not crowd them out.
      expect(result.stats["member_pull"] ?? 0).toBeGreaterThan(0);
      expect(result.stats["crash_restart"] ?? 0).toBeGreaterThan(0);
      expect(result.stats["compaction"] ?? 0).toBeGreaterThan(0);
      // And every grant-plane leg the invariants depend on actually ran. The
      // schedule is a pure function of the seed, so these are exact facts
      // about this program, not hopes about a random one.
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
        // The audience diverged and a later pass overwrote it: "the origin is
        // the sole author" is an empty claim unless something contested it.
        "grant_tamper_healed",
      ])
        expect(result.stats[leg] ?? 0, `${leg} never fired`).toBeGreaterThan(0);
      // The one break this program is allowed to tolerate is defect D1, and
      // it must be named as such rather than passing silently.
      expect(
        result.pinned.every((entry) => entry.includes("defect D1, issue #839")),
        `unexpected pin:\n${result.pinned.join("\n")}`
      ).toBe(true);
    },
    SIM_TIMEOUT_MS
  );

  /**
   * DEFECT D1 (issue #839), pinned, not tolerated. `fulfillShareGrant` drops
   * a `delivered` fulfillment row back to `syncing` when the host merely
   * cannot reach the peer for one pass, and `propagateShareGrantRevocation`
   * then reads `syncing` as never-delivered: it settles `removed` — "nothing
   * had been delivered; there was nothing to remove" — while the audience
   * vault still holds the whole projection. The owner is told the share is
   * gone and it is not.
   *
   * This case asserts what MUST be true. It is `test.fails` because it is not
   * true today; the day the engine remembers what it delivered, this case
   * starts passing and turns red, which is the signal to delete the pin here
   * and in `commons-sim-grant.test-fixtures.ts` `checkSeverance`.
   */
  test.fails(
    "a revocation severs a grant the host lost reach for mid-life",
    () => {
      const probe = runRevocationSeveranceProbe();
      expect(probe.state).toBe("removed");
      expect(probe.audienceTitles).toStrictEqual([]);
    },
    SIM_TIMEOUT_MS
  );
});
