import type { DatabaseSync } from "node:sqlite";

import { readEnrichConsent } from "@centraid/vault";
import type {
  EnrichConsentRecord,
  EnrichEgressClass,
  EnrichScope,
} from "@centraid/vault";

export interface EnrichConsentChainQuery {
  readonly capability: string;
  readonly egress: EnrichEgressClass;
  readonly scopeChain: readonly EnrichScope[];
}

export function readEnrichConsentForChain(
  vault: DatabaseSync,
  query: EnrichConsentChainQuery
): EnrichConsentRecord | null {
  const refs = query.scopeChain.toReversed().map((scope) => scope.ref);
  refs.push(""); // vault-wide last resort, even if the chain never named it
  const seen = new Set<string>();
  for (const scopeRef of refs) {
    if (seen.has(scopeRef)) continue;
    seen.add(scopeRef);
    const record = readEnrichConsent(vault, {
      capability: query.capability,
      egress: query.egress,
      scopeRef,
    });
    if (record) return record;
  }
  return null;
}
