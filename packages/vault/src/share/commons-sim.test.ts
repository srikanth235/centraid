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

import type { SimReport } from "./commons-sim-world.test-fixtures.js";
import {
  ACTION_WEIGHTS,
  runCommonsSimulation,
} from "./commons-sim.test-fixtures.js";

/**
 * Shrink-lite: a seed the simulator has caught a real Commons bug on gets
 * pinned here forever, with the suspected defect named in a comment beside it.
 * While the defect is still open, move that seed out of this list into its own
 * `test.fails` case so the failure is recorded rather than tolerated. Empty
 * today: these seeds plus a wider offline sweep (44 seeds, 3–5 seats, 1–3
 * grants, up to 260 actions each) found no non-converging schedule.
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
});
