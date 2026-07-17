/*
 * Model-id matching (issue #445), following ccusage's rules so an id the
 * adapter reports resolves to the same catalog row a human would pick:
 *
 *   1. exact id
 *   2. exact after normalization — lower-case, strip a leading `provider/`
 *      segment, strip a Bedrock `:version` suffix, strip regional Bedrock +
 *      `anthropic.`/`openai.` dot-prefixes, strip a trailing `-vN` and date
 *      suffix (`-YYYYMMDD` / `-YYYY-MM-DD`).
 *   3. boundary-safe longest match — the longest catalog key that is a
 *      prefix of the normalized id AT A NON-ALPHANUMERIC BOUNDARY, so
 *      `claude-3-5` matches `claude-3-5-sonnet…` but never `claude-3-55…`.
 *
 * Unknown → `undefined`; a miss is NEVER a silent default price. Only generic
 * provider prefixes appear as literals here (no concrete model ids), so the
 * no-hardcoded-model-ids directive is satisfied without a waiver.
 */

import type { PricingCatalog, PricingEntry } from './types.js';

const REGIONAL_BEDROCK = /^(us|eu|apac|jp|au)\./;
const PROVIDER_DOT = /^(anthropic|openai)\./;
const VERSION_SUFFIX = /-v\d+$/;
const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$|-\d{8}$/;

/** Ordered candidate ids to try for an exact catalog hit, most→least specific. */
function candidates(model: string): string[] {
  const lower = model.trim().toLowerCase();
  const afterSlash = lower.slice(lower.lastIndexOf('/') + 1);
  const noVersion = afterSlash.split(':')[0] ?? afterSlash;
  const stripped = noVersion.replace(REGIONAL_BEDROCK, '').replace(PROVIDER_DOT, '');
  const noDate = stripped.replace(VERSION_SUFFIX, '').replace(DATE_SUFFIX, '');
  // De-dup while preserving order.
  return [...new Set([lower, afterSlash, noVersion, stripped, noDate])];
}

function isBoundary(ch: string | undefined): boolean {
  // End-of-string or a non-alphanumeric separator both count as a boundary.
  return ch === undefined || !/[a-z0-9]/i.test(ch);
}

/** Longest catalog key that is a boundary-safe prefix of `id` (or equals it). */
function longestBoundaryMatch(catalog: PricingCatalog, id: string): string | undefined {
  let best: string | undefined;
  for (const key of Object.keys(catalog)) {
    if (key.length <= (best?.length ?? 0)) continue;
    if (id === key) {
      best = key;
      continue;
    }
    if (id.startsWith(key) && isBoundary(id[key.length])) best = key;
  }
  return best;
}

/** Resolve a model id to its catalog entry, or `undefined` when unknown. */
export function matchEntry(catalog: PricingCatalog, model: string): PricingEntry | undefined {
  const cands = candidates(model);
  for (const c of cands) {
    const hit = catalog[c];
    if (hit) return hit;
  }
  // Fall back to boundary-safe longest match on the fully-normalized id first,
  // then the pre-date-strip form (a catalog that only carries dated keys).
  const noDate = cands[cands.length - 1] ?? '';
  const stripped = cands[cands.length - 2] ?? noDate;
  const key = longestBoundaryMatch(catalog, stripped) ?? longestBoundaryMatch(catalog, noDate);
  return key ? catalog[key] : undefined;
}
