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

/** Number of models in the active table (diagnostics/tests). */
export function pricingCatalogSize(): number {
  return Object.keys(catalog).length;
}
