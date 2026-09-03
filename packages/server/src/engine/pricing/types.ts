export interface PricingEntry {
  readonly input_cost_per_token?: number;
  readonly output_cost_per_token?: number;
  readonly cache_read_input_token_cost?: number;
  readonly cache_creation_input_token_cost?: number;
  readonly cache_creation_input_token_cost_above_1hr?: number;
  readonly litellm_provider?: string;
}

export type PricingCatalog = Record<string, PricingEntry>;
