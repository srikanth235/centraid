import { seededRandom } from "@centraid/test-kit/random";

export type ChaosScheduleMode = "cover" | "sample";

export interface ChaosScheduleEntry<Id extends string> {
  readonly step: number;
  readonly seed: number;
  readonly fault: Id;
}

export interface ChaosScheduleOptions {
  readonly mode?: ChaosScheduleMode;
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

export const DEFAULT_CHAOS_SEED = 0x3a_7c_1e_05;

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

export function resolveChaosSeed(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = integerEnv(env.CENTRAID_CHAOS_SEED, "CENTRAID_CHAOS_SEED");
  return parsed === undefined ? DEFAULT_CHAOS_SEED : parsed >>> 0;
}

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
