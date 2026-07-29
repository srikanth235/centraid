import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface QualityMeasurement {
  name: string;
  value: number;
  unit: string;
  budget?: number;
}

export interface QualityResult {
  lane: "perf" | "scale";
  owner: string;
  name: string;
  status: "passed" | "failed";
  measurements: QualityMeasurement[];
}

/** Three-times-median budget, enabled only after ten durable observations. */
export function regressionBudget(
  values: readonly number[],
  { minimumSamples = 10, multiplier = 3 } = {}
): number | null {
  const samples = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .slice(-minimumSamples)
    .toSorted((left, right) => left - right);
  if (samples.length < minimumSamples) return null;
  const middle = Math.floor(samples.length / 2);
  const median =
    samples.length % 2
      ? samples[middle]!
      : (samples[middle - 1]! + samples[middle]!) / 2;
  return median * multiplier;
}

/** Read prior durable samples for one owner and derive its active budget. */
export async function qualityRegressionBudget(
  lane: "perf" | "scale",
  owner: string
): Promise<number | null> {
  const slug = owner.replaceAll(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "");
  try {
    const previous = JSON.parse(
      await readFile(path.resolve("artifacts", lane, `${slug}.json`), "utf8")
    ) as { history?: Array<{ value?: number }> };
    return regressionBudget(
      (previous.history ?? []).map((point) => Number(point.value))
    );
  } catch {
    return null;
  }
}

/** Emit one stable, report-consumable result while retaining a short local trend. */
export async function recordQualityResult(
  result: QualityResult
): Promise<void> {
  const directory = path.resolve("artifacts", result.lane);
  const slug = result.owner
    .replaceAll(/[^a-z0-9]+/giu, "-")
    .replace(/^-|-$/gu, "");
  const file = path.join(directory, `${slug}.json`);
  await mkdir(directory, { recursive: true });
  let previous: { history?: Array<{ at: string; value: number }> } | undefined;
  try {
    previous = JSON.parse(await readFile(file, "utf8")) as typeof previous;
  } catch {
    previous = undefined;
  }
  const value = result.measurements[0]?.value ?? 0;
  const history = [
    ...(previous?.history ?? []),
    { at: new Date().toISOString(), value },
  ].slice(-30);
  await writeFile(
    file,
    `${JSON.stringify({ ...result, history }, null, 2)}\n`,
    "utf8"
  );
}
