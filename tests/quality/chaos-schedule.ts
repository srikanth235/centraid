import { seededRandom } from "@centraid/test-kit/random";

/**
 * Seeded, replayable chaos scheduling (issue #842 W3.1 / W3.2).
 *
 * Deliberately the same cover/sample design as `crash-schedule.ts` (#842
 * W1.1), generalised over a catalog so the network lane and the composition
 * lane share one replay coordinate system:
 *
 * - "cover" (the PR default) is a seeded Fisher-Yates shuffle of the whole
 *   catalog: every fault exactly once, ordering fixed by the seed. That is the
 *   chaos coverage floor — one real fault per named adversity every run.
 * - "sample" (the nightly sweep) draws `iterations` faults WITH repetition, so
 *   a long run exercises many orderings and re-hits the faults that interact,
 *   while each individual draw stays pinned to its seed.
 *
 * A red run replays from its own test name: every name carries
 * `replayLabel(entry)`, and the seed it prints is the only input the schedule
 * has. Never `Math.random`/`Date.now` — a run seeded from the wall clock is a
 * different test every time it runs, which is exactly what a chaos lane must
 * not be.
 */

export type ChaosScheduleMode = "cover" | "sample";

export interface ChaosScheduleEntry<Id extends string> {
  /** Position in the run — with the seed, the full replay coordinate. */
  readonly step: number;
  readonly seed: number;
  readonly fault: Id;
}

export interface ChaosScheduleOptions {
  readonly mode?: ChaosScheduleMode;
  /** Draw count for "sample" mode (nightly sweep). Ignored by "cover". */
  readonly iterations?: number;
}

export function chaosSchedule<Id extends string>(
  catalog: readonly Id[],
  seed: number,
  options: ChaosScheduleOptions = {}
): ChaosScheduleEntry<Id>[] {
  if (catalog.length === 0) throw new Error("chaosSchedule: empty catalog");
  const rng = seededRandom(seed);
  if ((options.mode ?? "cover") === "sample") {
    const iterations = Math.max(1, options.iterations ?? catalog.length);
    return Array.from({ length: iterations }, (_unused, step) => ({
      step,
      seed,
      fault: catalog[rng.int(0, catalog.length - 1)]!,
    }));
  }
  const order = [...catalog];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  return order.map((fault, step) => ({ step, seed, fault }));
}

/** The pinned default seed the PR lane replays every run. */
export const DEFAULT_CHAOS_SEED = 0x3a_7c_1e_05;

/** The replay coordinate, printed into every scheduled test's name. */
export function replayLabel<Id extends string>(
  entry: ChaosScheduleEntry<Id>
): string {
  return `seed 0x${entry.seed.toString(16).padStart(8, "0")} step ${entry.step}`;
}

function integerEnv(raw: string | undefined, name: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed))
    throw new Error(`${name} must be an integer, got "${raw}"`);
  return parsed;
}

/** Resolve the run seed from the env override, else the pinned default. */
export function resolveChaosSeed(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = integerEnv(env.CENTRAID_CHAOS_SEED, "CENTRAID_CHAOS_SEED");
  return parsed === undefined ? DEFAULT_CHAOS_SEED : parsed >>> 0;
}

/** Nightly sweep iteration count, or 0 when unset (PR cover mode). */
export function resolveChaosIterations(
  env: NodeJS.ProcessEnv = process.env
): number {
  const parsed = integerEnv(
    env.CENTRAID_CHAOS_ITERATIONS,
    "CENTRAID_CHAOS_ITERATIONS"
  );
  if (parsed === undefined) return 0;
  if (parsed < 1)
    throw new Error(
      `CENTRAID_CHAOS_ITERATIONS must be a positive integer, got "${env.CENTRAID_CHAOS_ITERATIONS}"`
    );
  return parsed;
}

/** The schedule this process runs: cover on PR, sample when iterations are set. */
export function resolvedSchedule<Id extends string>(
  catalog: readonly Id[],
  env: NodeJS.ProcessEnv = process.env
): ChaosScheduleEntry<Id>[] {
  const iterations = resolveChaosIterations(env);
  return chaosSchedule(
    catalog,
    resolveChaosSeed(env),
    iterations > 0 ? { mode: "sample", iterations } : { mode: "cover" }
  );
}
