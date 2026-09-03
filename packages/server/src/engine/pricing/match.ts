import type { PricingCatalog, PricingEntry } from "./types.js";

const REGIONAL_BEDROCK = /^(?:us|eu|apac|jp|au)\./u;
const PROVIDER_DOT = /^(?:anthropic|openai)\./u;
const VERSION_SUFFIX = /-v\d+$/u;
const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$|-\d{8}$/u;

function candidates(model: string): string[] {
  const lower = model.trim().toLowerCase();
  const afterSlash = lower.slice(lower.lastIndexOf("/") + 1);
  const noVersion = afterSlash.split(":")[0] ?? afterSlash;
  const stripped = noVersion
    .replace(REGIONAL_BEDROCK, "")
    .replace(PROVIDER_DOT, "");
  const noDate = stripped.replace(VERSION_SUFFIX, "").replace(DATE_SUFFIX, "");
  return [...new Set([lower, afterSlash, noVersion, stripped, noDate])];
}

function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9]/iu.test(ch);
}

function longestBoundaryMatch(
  catalog: PricingCatalog,
  id: string
): string | undefined {
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

export function matchEntry(
  catalog: PricingCatalog,
  model: string
): PricingEntry | undefined {
  const cands = candidates(model);
  for (const c of cands) {
    const hit = catalog[c];
    if (hit) return hit;
  }
  const noDate = cands[cands.length - 1] ?? "";
  const stripped = cands[cands.length - 2] ?? noDate;
  const key =
    longestBoundaryMatch(catalog, stripped) ??
    longestBoundaryMatch(catalog, noDate);
  return key ? catalog[key] : undefined;
}
