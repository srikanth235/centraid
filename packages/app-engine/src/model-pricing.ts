/*
 * Per-model token pricing (issue #90 open question 4; live catalog #445).
 *
 * `items.cost_usd` is frozen at write time — prices drift, so a run recorded
 * today keeps the cost it was billed at. This module is the price seam that
 * conversion goes through; the repricing backfill (#445) is the ONLY sanctioned
 * rewriter of already-frozen costs.
 *
 * A missing price returns `undefined`, NOT 0 — the ledger stores NULL so
 * "no price known for this model" stays distinguishable from a genuine
 * zero-cost call. Callers that sum cost must treat NULL as "unknown",
 * not "free".
 *
 * Internally this delegates to an injectable in-memory catalog seeded from a
 * committed LiteLLM snapshot and overlaid by the gateway warmer's live fetch
 * (`./pricing/*`). The public shape below is unchanged: the two call sites
 * (http/turn-sse recordUsage, conversation/history recordNode) do not move,
 * and this file stays the single no-hardcoded-model-ids allowlisted seam even
 * though it no longer holds any literal ids itself.
 */

import { lookupEntry } from './pricing/catalog.js';
import { costFromEntry, entryToModelPrice } from './pricing/cost.js';

export { setPricingCatalog } from './pricing/catalog.js';
export { filterLiteLLM } from './pricing/filter.js';
export type { PricingCatalog, PricingEntry } from './pricing/types.js';

/** USD-per-million-token rates for one model (back-compat convenience view). */
export interface ModelPrice {
  readonly inputPerMtok: number;
  readonly outputPerMtok: number;
  /** Reading a previously-cached prompt prefix — far cheaper than fresh input. */
  readonly cacheReadPerMtok: number;
  /** Writing a prompt prefix into the cache — a premium over fresh input. */
  readonly cacheWritePerMtok: number;
}

/** Per-call token counts, as captured on a `kind='step'` / `kind='agent'` node. */
export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/**
 * Look up a model's rates as USD-per-million-token. Returns `undefined` when
 * the catalog has no match — the caller must record NULL, not 0.
 */
export function priceForModel(model: string | undefined): ModelPrice | undefined {
  const entry = lookupEntry(model);
  return entry ? entryToModelPrice(entry) : undefined;
}

/**
 * Compute the USD cost of one inference call. Returns `undefined` when the
 * model has no known price — distinct from a `0` result for a call that
 * genuinely used no tokens. Missing token fields count as 0.
 */
export function costForUsage(model: string | undefined, usage: TokenUsage): number | undefined {
  const entry = lookupEntry(model);
  return entry ? costFromEntry(entry, usage) : undefined;
}
