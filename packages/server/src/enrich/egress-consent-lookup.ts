/*
 * THE GATEWAY'S READ of the vault's egress-consent ledger (issue #807, Wave 3).
 *
 * Consent is DATA-OWNER PROPERTY: it is written in the vault, by the one
 * journalled command (`enrich.record_consent`, packages/vault/src/commands/
 * enrich.ts), and travels with the data. This module is the only shape of
 * access the gateway has to it — a read, walked over a scope chain — and it
 * deliberately exports nothing that could write.
 *
 * WHY THE WALK LIVES HERE AND NOT IN THE VAULT. `readEnrichConsent` answers
 * for ONE key and refuses to cascade, on purpose: inheriting a vault-wide
 * answer down to a narrower scope is how consent silently widens, so the
 * storage layer will not do it. The direction that IS safe is the other one —
 * a specific scope answers for itself first, and falls back to the vault-wide
 * answer the member gave for everything. That fallback is a caller's decision,
 * so it is written here, once, where the fire gate can be shown reading it.
 *
 * MOST SPECIFIC FIRST. The chain arrives least-specific first (the cascade's
 * order); this reads it backwards, so an item- or collection-scoped answer
 * beats the vault-wide one, and the vault-wide `''` row is the last thing
 * tried. A DECLINE anywhere on that walk stops it: the nearest answer is the
 * member's answer, and falling through a "no" to find a "yes" further out
 * would be exactly the widening this whole wave exists to prevent.
 */

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
  /** Least-specific first — the same chain the policy cascade resolved over. */
  readonly scopeChain: readonly EnrichScope[];
}

/**
 * The answer on record nearest to the scope being fired for, or `null` when
 * the question was never asked at any level of the chain. `null` is not a
 * grant; the gate treats anything that is not a `granted` record as a refusal.
 */
export function readEnrichConsentForChain(
  vault: DatabaseSync,
  query: EnrichConsentChainQuery
): EnrichConsentRecord | null {
  const refs = query.scopeChain.toReversed().map((scope) => scope.ref);
  // The vault-wide answer is always the last resort, even for a chain that
  // never named the vault scope.
  refs.push("");
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
