/*
 * Per-model token pricing (issue #90, open question 4).
 *
 * `run_nodes.cost_usd` is frozen at write time — prices drift, so a run
 * recorded today must keep the cost it was billed at. This module is the
 * price table that conversion goes through.
 *
 * A missing price returns `undefined`, NOT 0 — the ledger stores NULL so
 * "no price known for this model" stays distinguishable from a genuine
 * zero-cost call. Callers that sum cost must treat NULL as "unknown",
 * not "free".
 *
 * Prices are USD per million tokens and are a SNAPSHOT — when a provider
 * changes list pricing, update the table; already-recorded `cost_usd`
 * values are intentionally left frozen at their original rate.
 */

/** USD-per-million-token rates for one model. */
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
 * Price table keyed by a normalized model-family prefix. `priceForModel`
 * matches the longest prefix, so `claude-opus-4-7` resolves via
 * `claude-opus`. Snapshot as of early 2026.
 */
const PRICE_TABLE: ReadonlyArray<readonly [prefix: string, price: ModelPrice]> = [
  // Anthropic — Claude 4.x family.
  [
    'claude-opus',
    { inputPerMtok: 15, outputPerMtok: 75, cacheReadPerMtok: 1.5, cacheWritePerMtok: 18.75 },
  ],
  [
    'claude-sonnet',
    { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75 },
  ],
  [
    'claude-haiku',
    { inputPerMtok: 0.8, outputPerMtok: 4, cacheReadPerMtok: 0.08, cacheWritePerMtok: 1 },
  ],
  // OpenAI — GPT-5 / codex family.
  [
    'gpt-5-codex',
    { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadPerMtok: 0.125, cacheWritePerMtok: 1.25 },
  ],
  [
    'gpt-5-mini',
    { inputPerMtok: 0.25, outputPerMtok: 2, cacheReadPerMtok: 0.025, cacheWritePerMtok: 0.25 },
  ],
  [
    'gpt-5',
    { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadPerMtok: 0.125, cacheWritePerMtok: 1.25 },
  ],
];

/**
 * Normalize a model id for table lookup: lower-case and strip a leading
 * `provider/` segment (codex reports `centraid-mock/...`, some configs
 * prefix `anthropic/`).
 */
function normalizeModel(model: string): string {
  const lower = model.trim().toLowerCase();
  const slash = lower.lastIndexOf('/');
  return slash >= 0 ? lower.slice(slash + 1) : lower;
}

/**
 * Look up the price for a model id. Returns `undefined` when no table
 * entry's prefix matches — the caller must record NULL, not 0.
 */
export function priceForModel(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const id = normalizeModel(model);
  // Longest-prefix wins so `gpt-5-codex` beats `gpt-5`.
  let best: ModelPrice | undefined;
  let bestLen = -1;
  for (const [prefix, price] of PRICE_TABLE) {
    if (id.startsWith(prefix) && prefix.length > bestLen) {
      best = price;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * Compute the USD cost of one inference call. Returns `undefined` when
 * the model has no known price — distinct from a `0` result for a call
 * that genuinely used no tokens. Missing token fields count as 0.
 */
export function costForUsage(model: string | undefined, usage: TokenUsage): number | undefined {
  const price = priceForModel(model);
  if (!price) return undefined;
  const perMtok = (tokens: number | undefined, rate: number): number =>
    ((tokens ?? 0) / 1_000_000) * rate;
  return (
    perMtok(usage.inputTokens, price.inputPerMtok) +
    perMtok(usage.outputTokens, price.outputPerMtok) +
    perMtok(usage.cacheReadTokens, price.cacheReadPerMtok) +
    perMtok(usage.cacheWriteTokens, price.cacheWritePerMtok)
  );
}
