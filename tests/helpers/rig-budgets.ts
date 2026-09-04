import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Single reader for `tests/budgets.json#qualityRigs` (issue #656 Layer 1F;
 * merged into the budgets ledger by #915 Wave 4).
 *
 * Before this, three perf rigs and two scale rigs each carried their absolute
 * catastrophic-failure ceiling as a `const BUDGET_MS` in their own source. Those
 * numbers were invisible to `bun run test:ratchet`, so a widened ceiling — the
 * cheapest way to make a slow rig green — was an ordinary one-line edit that
 * nothing flagged. Moving them into the registry puts them under the
 * tighten-only ratchet (`PERF_BUDGET_SOURCES` in
 * `scripts/test-report/ratchet-floors.mjs`) and puts the volume descriptor next
 * to the ceiling it justifies.
 *
 * Resolution is from this file, not `process.cwd()`: perf and scale rigs run
 * under the repo-root vitest configs but a forked child fixture may not.
 */
const REGISTRY_PATH = path.resolve(import.meta.dirname, "../budgets.json");

interface RigEntry {
  lane: "perf" | "scale";
  volume: string;
  budgetMs?: number;
  budgetsMs?: Record<string, number>;
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

/** Full registry entry for a rig, keyed by its `OWNER` path. */
export function rigEntry(owner: string): RigEntry {
  const entry = registry.rigs[owner];
  if (!entry)
    throw new Error(
      `${owner} is not registered in tests/budgets.json#qualityRigs — add its lane and volume before recording quality results`
    );
  return entry;
}

/**
 * The rig's absolute wall-clock ceiling in milliseconds. Throws rather than
 * defaulting: a rig that silently fell back to `Infinity` would keep passing
 * after someone deleted its budget, which is the exact failure this registry
 * exists to prevent.
 */
export function rigBudgetMs(owner: string): number {
  const { budgetMs } = rigEntry(owner);
  if (typeof budgetMs !== "number")
    throw new Error(
      `${owner} has no budgetMs in tests/budgets.json#qualityRigs — declare one there rather than inlining a constant`
    );
  return budgetMs;
}

/**
 * One NAMED ceiling for a rig that measures several intervals, from
 * `budgetsMs` beside the volume it was measured at (#927).
 *
 * A rig whose four reads share one `budgetMs` cannot say which read regressed,
 * so those rigs carried their ceilings as module constants — outside the
 * tighten-only ratchet, where widening one was a one-line edit nothing flagged.
 * Throws on a missing key rather than defaulting, for the same reason
 * `rigBudgetMs` does: a silent `Infinity` keeps passing after someone deletes
 * the ceiling.
 */
export function rigBudgetMsNamed(owner: string, key: string): number {
  const budget = rigEntry(owner).budgetsMs?.[key];
  if (typeof budget !== "number")
    throw new Error(
      `${owner} has no budgetsMs.${key} in tests/budgets.json#qualityRigs — declare it there beside the volume rather than inlining a constant`
    );
  return budget;
}

/**
 * Sustained-drift budget for a rig, from its own 30-sample nightly history
 * (issue #659 R4).
 *
 * The problem this closes: the rigs with a fixed absolute ceiling — the
 * `budgetMs` entries above, and the inline constants in `gateway-request`,
 * `vault-write`, `backup-restore` and friends — never read their history at
 * all. A ceiling set at ~3x a measured baseline only fires on a collapse, so a
 * rig could walk from 40 ms to 110 ms under a 120 ms ceiling over a year of
 * green nightlies with nothing anywhere saying a word. `qualityRegressionBudget`
 * in `@centraid/test-kit` already computed a trailing-median budget, but only
 * nine rigs called it, and at 10 samples x 3 it is a second catastrophe gate
 * rather than a drift gate.
 *
 * This is the drift gate: 30 durable observations (about a month of nightlies —
 * long enough that one slow runner cannot move the median, short enough to
 * catch a regression inside a release cycle), then fail above
 * `driftMultiplier` x the trailing median. Both knobs live in
 * `tests/budgets.json#qualityRigs` so `bun run test:ratchet` holds them
 * tighten-only; nothing here invents a number.
 *
 * Returns `null` until the history is deep enough. A null must be treated as
 * "no opinion yet", never as a pass — call sites read it as
 * `drift === null || value <= drift`.
 */
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

/**
 * Pure trailing-median drift budget. Exported for unit tests: the whole gate
 * is this arithmetic, and a rig-driven test of it would need 30 nightlies.
 */
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
