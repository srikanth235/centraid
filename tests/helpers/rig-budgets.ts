import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Single reader for the rig half of `tests/journeys.json` (#927; the registry
 * began as `tests/journeys.json#rigs` in #656 and passed through
 * `tests/journeys.json#rigs`).
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
const LEDGER_PATH = path.resolve(import.meta.dirname, "../journeys.json");

interface RigEntry {
  lane: "perf" | "scale";
  volume: string;
  /** Ledger keys (`surface/journey/volume/hardware`) this rig produces numbers for. */
  entries: string[];
  gate?: "deterministic-counters";
  budgetMs?: number;
  budgetsMs?: Record<string, number>;
}

const registry = (
  JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as {
    rigs: Record<string, RigEntry>;
  }
).rigs;

/** Full registry entry for a rig, keyed by its `OWNER` path. */
export function rigEntry(owner: string): RigEntry {
  const entry = registry[owner];
  if (!entry)
    throw new Error(
      `${owner} is not registered in tests/journeys.json#rigs — add its lane and volume before recording quality results`
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
      `${owner} has no budgetMs in tests/journeys.json#rigs — declare one there rather than inlining a constant`
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
      `${owner} has no budgetsMs.${key} in tests/journeys.json#rigs — declare it there beside the volume rather than inlining a constant`
    );
  return budget;
}
