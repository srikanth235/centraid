/*
 * In-memory pricing catalog (issue #445).
 *
 * Seeded at import from the committed LiteLLM snapshot so lookups work with
 * zero I/O and fully offline. The gateway warmer overlays a fresher table via
 * `setPricingCatalog` once its disk-cached fetch lands; an empty overlay never
 * clobbers a good table. Lookups are always synchronous against the current
 * table — the two pricing call sites (turn-sse, recordNode) must not await.
 *
 * The snapshot is read as data (JSON), never imported as a module, so no
 * concrete model-id literal ever appears in a scanned `.ts` file.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PricingCatalog, PricingEntry } from './types.js';
import { matchEntry } from './match.js';

function loadSnapshot(): PricingCatalog {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(path.join(here, 'litellm-snapshot.json'), 'utf8');
    const parsed = JSON.parse(raw) as { models?: PricingCatalog };
    return parsed.models ?? {};
  } catch {
    // A missing/corrupt snapshot degrades to "everything unpriced" (NULL cost),
    // never to a wrong price — the warmer can still populate a live table.
    return {};
  }
}

let catalog: PricingCatalog = loadSnapshot();

/**
 * Explicit unknown-model accounting policy when the loaded catalog has no
 * positive rate for a consumed bucket: $100 / MTok. This is intentionally
 * conspicuous and non-zero, but it is not a claim about an unreported
 * provider's actual rate or a proven upper bound.
 */
export const UNKNOWN_MODEL_POLICY_RATE_PER_TOKEN = 100 / 1_000_000;

/**
 * Replace the active price table (gateway warmer). Empty input is ignored so a
 * failed fetch never wipes the bundled snapshot.
 */
export function setPricingCatalog(entries: PricingCatalog): void {
  if (entries && Object.keys(entries).length > 0) catalog = entries;
}

/** Resolve a model id against the active table, or `undefined` when unknown. */
export function lookupEntry(model: string | undefined): PricingEntry | undefined {
  if (!model) return undefined;
  return matchEntry(catalog, model);
}

/**
 * Per-token rate ceiling across the known catalog. Used only when a runner
 * reports tokens but neither USD nor a model identity. Combining maxima is a
 * deliberately conservative envelope, not a claim that one catalog model
 * has this exact price.
 */
export function catalogRateCeilingFor(entries: PricingCatalog): PricingEntry {
  const values = Object.values(entries);
  const max = (read: (entry: PricingEntry) => number | undefined): number | undefined => {
    const rates = values
      .map(read)
      .filter(
        (value): value is number => value !== undefined && Number.isFinite(value) && value > 0,
      );
    return rates.length > 0 ? Math.max(...rates) : undefined;
  };
  const policy = (value: number | undefined): number =>
    value ?? UNKNOWN_MODEL_POLICY_RATE_PER_TOKEN;
  const cacheWrite = max((entry) =>
    Math.max(
      entry.cache_creation_input_token_cost ?? 0,
      entry.cache_creation_input_token_cost_above_1hr ?? 0,
    ),
  );
  return {
    input_cost_per_token: policy(max((entry) => entry.input_cost_per_token)),
    output_cost_per_token: policy(max((entry) => entry.output_cost_per_token)),
    cache_read_input_token_cost: policy(max((entry) => entry.cache_read_input_token_cost)),
    // `costFromEntry` prefers this field, so fold both duration buckets into it.
    cache_creation_input_token_cost: policy(cacheWrite),
  };
}

export function catalogRateCeiling(): PricingEntry {
  return catalogRateCeilingFor(catalog);
}
