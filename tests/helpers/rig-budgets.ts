import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Single reader for `tests/quality-rig-budgets.json` (issue #656 Layer 1F).
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
const REGISTRY_PATH = path.resolve(
  import.meta.dirname,
  "../quality-rig-budgets.json"
);

interface RigEntry {
  lane: "perf" | "scale";
  volume: string;
  budgetMs?: number;
}

interface RigRegistry {
  minimumSamples: number;
  regressionMultiplier: number;
  rigs: Record<string, RigEntry>;
}

const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as RigRegistry;

/** Full registry entry for a rig, keyed by its `OWNER` path. */
export function rigEntry(owner: string): RigEntry {
  const entry = registry.rigs[owner];
  if (!entry)
    throw new Error(
      `${owner} is not registered in tests/quality-rig-budgets.json — add its lane and volume before recording quality results`
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
      `${owner} has no budgetMs in tests/quality-rig-budgets.json — declare one there rather than inlining a constant`
    );
  return budgetMs;
}
