import { readFileSync } from "node:fs";
import path from "node:path";

import { matchEntry } from "./match.js";
import type { PricingCatalog, PricingEntry } from "./types.js";

function loadSnapshot(): PricingCatalog {
  try {
    const here = import.meta.dirname;
    const raw = readFileSync(path.join(here, "litellm-snapshot.json"), "utf8");
    const parsed = JSON.parse(raw) as { models?: PricingCatalog };
    return parsed.models ?? {};
  } catch {
    return {};
  }
}

let catalog: PricingCatalog = loadSnapshot();

export function setPricingCatalog(entries: PricingCatalog): void {
  if (entries && Object.keys(entries).length > 0) catalog = entries;
}

export function lookupEntry(
  model: string | undefined
): PricingEntry | undefined {
  if (!model) return undefined;
  return matchEntry(catalog, model);
}
