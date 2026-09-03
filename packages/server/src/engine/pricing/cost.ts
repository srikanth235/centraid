import type { ModelPrice, TokenUsage } from "../model-pricing.js";
import type { PricingEntry } from "./types.js";

function cacheWriteRate(entry: PricingEntry): number {
  return (
    entry.cache_creation_input_token_cost ??
    entry.cache_creation_input_token_cost_above_1hr ??
    0
  );
}

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

export function entryToModelPrice(entry: PricingEntry): ModelPrice {
  const per = (rate: number | undefined): number => (rate ?? 0) * 1_000_000;
  return {
    inputPerMtok: per(entry.input_cost_per_token),
    outputPerMtok: per(entry.output_cost_per_token),
    cacheReadPerMtok: per(entry.cache_read_input_token_cost),
    cacheWritePerMtok: per(cacheWriteRate(entry)),
  };
}
