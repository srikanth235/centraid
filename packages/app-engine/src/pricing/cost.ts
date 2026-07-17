/*
 * Cost formula (issue #445). Prices raw token counts against a catalog
 * entry's per-token USD rates (ccusage/CodexBar formula):
 *
 *   input×input + output×output + cacheRead×cacheRead + cacheWrite×cacheWrite
 *
 * The ledger carries ONE cache-write bucket, priced at the 5-minute rate
 * (`cache_creation_input_token_cost`); when an entry only publishes the
 * 1-hour rate that value stands in. Missing price fields contribute 0. No
 * 200k-token tiering, no batch/geo modifiers in v1.
 */

import type { ModelPrice, TokenUsage } from '../model-pricing.js';
import type { PricingEntry } from './types.js';

/** Per-token USD cache-write rate: 5m if present, else the 1h rate, else 0. */
function cacheWriteRate(entry: PricingEntry): number {
  return (
    entry.cache_creation_input_token_cost ?? entry.cache_creation_input_token_cost_above_1hr ?? 0
  );
}

/** USD cost for one inference call priced against `entry`. */
export function costFromEntry(entry: PricingEntry, usage: TokenUsage): number {
  const at = (tokens: number | undefined, rate: number | undefined): number =>
    (tokens ?? 0) * (rate ?? 0);
  return (
    at(usage.inputTokens, entry.input_cost_per_token) +
    at(usage.outputTokens, entry.output_cost_per_token) +
    at(usage.cacheReadTokens, entry.cache_read_input_token_cost) +
    at(usage.cacheWriteTokens, cacheWriteRate(entry))
  );
}

/** Present a catalog entry as USD-per-million-token rates (back-compat view). */
export function entryToModelPrice(entry: PricingEntry): ModelPrice {
  const per = (rate: number | undefined): number => (rate ?? 0) * 1_000_000;
  return {
    inputPerMtok: per(entry.input_cost_per_token),
    outputPerMtok: per(entry.output_cost_per_token),
    cacheReadPerMtok: per(entry.cache_read_input_token_cost),
    cacheWritePerMtok: per(cacheWriteRate(entry)),
  };
}
