import { seededRandom } from "@centraid/test-kit/random";

import { CRASH_BOUNDARY_IDS } from "./fault-points.js";
import type { CrashBoundaryId } from "./fault-points.js";

export type CrashScheduleMode = "cover" | "sample";

export interface CrashScheduleEntry {
  readonly step: number;
  readonly seed: number;
  readonly boundary: CrashBoundaryId;
}

export interface CrashScheduleOptions {
  readonly mode?: CrashScheduleMode;
  readonly iterations?: number;
}

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

export const DEFAULT_CRASH_SEED = 0x5f_2e_9c_11;

export function resolveCrashSeed(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CENTRAID_CRASH_SEED;
  if (!raw) return DEFAULT_CRASH_SEED;
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed))
    throw new Error(`CENTRAID_CRASH_SEED must be an integer, got "${raw}"`);
  return parsed >>> 0;
}

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
