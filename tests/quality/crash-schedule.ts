import { seededRandom } from "@centraid/test-kit/random";

import { CRASH_BOUNDARY_IDS } from "./fault-points.js";
import type { CrashBoundaryId } from "./fault-points.js";

export type CrashScheduleMode = "cover" | "sample";

export interface CrashScheduleEntry {
  /** Position in the run — with the seed, the full replay coordinate. */
  readonly step: number;
  readonly seed: number;
  readonly boundary: CrashBoundaryId;
}

export interface CrashScheduleOptions {
  readonly mode?: CrashScheduleMode;
  /** Draw count for "sample" mode (nightly sweep). Ignored by "cover". */
  readonly iterations?: number;
}

/**
 * Deterministic (seed → boundary sequence) enumeration so any red run is
 * replayable from its seed alone.
 *
 * - "cover" (the PR default) is a seeded Fisher–Yates shuffle of the whole
 *   catalog: every boundary exactly once, ordering fixed by the seed. This
 *   is the crash-consistency coverage floor — one real SIGKILL per durable
 *   seam every run.
 * - "sample" (the nightly sweep) draws `iterations` boundaries with
 *   repetition, so a long run exercises many orderings and re-hits hot
 *   seams while each individual draw stays pinned to its seed.
 *
 * Never `Math.random`/`Date.now` — a run seeded from the wall clock cannot
 * be replayed from its own output, which is the entire point of a seed.
 */
export function crashSchedule(
  seed: number,
  options: CrashScheduleOptions = {}
): CrashScheduleEntry[] {
  const mode = options.mode ?? "cover";
  const rng = seededRandom(seed);
  if (mode === "sample") {
    const iterations = Math.max(
      1,
      options.iterations ?? CRASH_BOUNDARY_IDS.length
    );
    return Array.from({ length: iterations }, (_unused, step) => ({
      step,
      seed,
      boundary: CRASH_BOUNDARY_IDS[rng.int(0, CRASH_BOUNDARY_IDS.length - 1)]!,
    }));
  }
  const order = [...CRASH_BOUNDARY_IDS];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  return order.map((boundary, step) => ({ step, seed, boundary }));
}

/** The pinned default seed the PR lane replays every run. */
export const DEFAULT_CRASH_SEED = 0x5f_2e_9c_11;

/** Resolve the run seed from the env override, else the pinned default. */
export function resolveCrashSeed(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CENTRAID_CRASH_SEED;
  if (!raw) return DEFAULT_CRASH_SEED;
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed))
    throw new Error(`CENTRAID_CRASH_SEED must be an integer, got "${raw}"`);
  return parsed >>> 0;
}

/** Resolve the nightly sweep iteration count, or 0 when unset (PR cover mode). */
export function resolveCrashIterations(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.CENTRAID_CRASH_ITERATIONS;
  if (!raw) return 0;
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 1)
    throw new Error(
      `CENTRAID_CRASH_ITERATIONS must be a positive integer, got "${raw}"`
    );
  return parsed;
}
