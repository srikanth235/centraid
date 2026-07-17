/*
 * Pricing catalog types (issue #445).
 *
 * A `PricingEntry` carries the per-token USD price fields verbatim from
 * LiteLLM's `model_prices_and_context_window.json` (BerriAI/litellm, MIT) —
 * only the fields centraid prices on are kept. The field NAMES are the
 * upstream ones on purpose: the committed snapshot, the dev refresh script,
 * and the gateway warmer all speak the same shape, so there is no lossy
 * rename to keep in sync.
 *
 * Every cost field is USD PER TOKEN (not per million) — that is LiteLLM's
 * unit. `cost.ts` multiplies raw token counts by these directly.
 */

/** Per-token USD price fields for one model, as carried from LiteLLM. */
export interface PricingEntry {
  readonly input_cost_per_token?: number;
  readonly output_cost_per_token?: number;
  /** Reading a previously-cached prompt prefix — far cheaper than fresh input. */
  readonly cache_read_input_token_cost?: number;
  /** Writing a prompt prefix into the 5-minute cache — a premium over input. */
  readonly cache_creation_input_token_cost?: number;
  /** 1-hour cache-write rate; used only when the 5m field is absent. */
  readonly cache_creation_input_token_cost_above_1hr?: number;
  /** Upstream provider tag (`anthropic` / `openai`) — kept for provenance. */
  readonly litellm_provider?: string;
}

/** The in-memory price table: model id → per-token price fields. */
export type PricingCatalog = Record<string, PricingEntry>;
