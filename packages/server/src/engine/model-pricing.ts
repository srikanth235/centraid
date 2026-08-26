/*
 * Per-model token pricing (#90, #445). `items.cost_usd` freezes at write time;
 * the #445 backfill alone may rewrite frozen *estimated* costs, never
 * `'harness'`. Unknown is NULL — never 0, never a substituted ceiling. Stays
 * the single no-hardcoded-model-ids allowlisted seam.
 */

import { lookupEntry } from "./pricing/catalog.js";
import { costFromEntry, entryToModelPrice } from "./pricing/cost.js";

export { setPricingCatalog } from "./pricing/catalog.js";
export { filterLiteLLM } from "./pricing/filter.js";
export type { PricingCatalog, PricingEntry } from "./pricing/types.js";

export interface ModelPrice {
  readonly inputPerMtok: number;
  readonly outputPerMtok: number;
  readonly cacheReadPerMtok: number;
  readonly cacheWritePerMtok: number;
}

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export function priceForModel(
  model: string | undefined
): ModelPrice | undefined {
  const entry = lookupEntry(model);
  return entry ? entryToModelPrice(entry) : undefined;
}

export function costForUsage(
  model: string | undefined,
  usage: TokenUsage
): number | undefined {
  const entry = lookupEntry(model);
  return entry ? costFromEntry(entry, usage) : undefined;
}

export type CostSource = "harness" | "estimated";

export interface ResolvedItemCost {
  readonly costUsd?: number;
  readonly costSource?: CostSource;
}

/** Unpriceable ⇒ `{}`: cost and provenance both NULL (#514). */
export function resolveItemCost(opts: {
  harnessCostUsd?: number;
  model?: string;
  usage: TokenUsage;
}): ResolvedItemCost {
  if (
    opts.harnessCostUsd !== undefined &&
    Number.isFinite(opts.harnessCostUsd)
  ) {
    return { costUsd: opts.harnessCostUsd, costSource: "harness" };
  }
  const estimated = costForUsage(opts.model, opts.usage);
  if (estimated !== undefined) {
    return { costUsd: estimated, costSource: "estimated" };
  }
  if (process.env.NODE_ENV === "test" && opts.model) {
    throw new Error(
      `priced inference model ${opts.model} has no pricing catalog entry`
    );
  }
  return {};
}
