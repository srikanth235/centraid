import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_PATH = path.resolve(import.meta.dirname, "../budgets.json");

interface RigEntry {
  lane: "perf" | "scale";
  volume: string;
  budgetMs?: number;
}

interface RigRegistry {
  minimumSamples: number;
  regressionMultiplier: number;
  minimumDriftSamples: number;
  driftMultiplier: number;
  rigs: Record<string, RigEntry>;
}

const registry = (
  JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as {
    qualityRigs: RigRegistry;
  }
).qualityRigs;

export function rigEntry(owner: string): RigEntry {
  const entry = registry.rigs[owner];
  if (!entry)
    throw new Error(
      `${owner} is not registered in tests/budgets.json#qualityRigs — add its lane and volume before recording quality results`
    );
  return entry;
}

export function rigBudgetMs(owner: string): number {
  const { budgetMs } = rigEntry(owner);
  if (typeof budgetMs !== "number")
    throw new Error(
      `${owner} has no budgetMs in tests/budgets.json#qualityRigs — declare one there rather than inlining a constant`
    );
  return budgetMs;
}

export async function rigDriftBudgetMs(
  lane: "perf" | "scale",
  owner: string
): Promise<number | null> {
  const slug = owner.replaceAll(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "");
  const file = path.resolve("artifacts", lane, `${slug}.json`);
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as { history?: Array<{ value?: number }> };
  return driftBudget(
    (parsed.history ?? []).map((point) => Number(point.value)),
    registry
  );
}

export function driftBudget(
  values: readonly number[],
  {
    minimumDriftSamples,
    driftMultiplier,
  }: Pick<RigRegistry, "minimumDriftSamples" | "driftMultiplier">
): number | null {
  const samples = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .slice(-minimumDriftSamples)
    .toSorted((left, right) => left - right);
  if (samples.length < minimumDriftSamples) return null;
  const middle = Math.floor(samples.length / 2);
  const median =
    samples.length % 2
      ? samples[middle]!
      : (samples[middle - 1]! + samples[middle]!) / 2;
  return median * driftMultiplier;
}
