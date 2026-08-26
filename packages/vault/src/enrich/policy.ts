// The enforceable read of the owner's per-domain enrichment tier. Host-plane
// on purpose — never the consent-checked bridge — because a guard must not
// depend on the grants of the party it guards. FAIL-CLOSED: `undefined` means
// no honourable tier and callers MUST refuse, never default; a SQLite error
// propagates for the same reason.

import type { DatabaseSync } from "node:sqlite";

import type { EnrichTier } from "../host.js";
import { readEnrichPolicyRuleChain } from "./policy-rules.js";
import type { EnrichPolicyRule, EnrichScope } from "./policy-rules.js";

export const ENRICH_DOMAINS = ["photos", "docs"] as const;
export type EnrichDomain = (typeof ENRICH_DOMAINS)[number];

const TIERS = new Set(["off", "device", "gateway"]);

/** Canonical names only; legacy strings go through `normalizeTier`. */
export function isEnrichTier(value: unknown): value is EnrichTier {
  return typeof value === "string" && TIERS.has(value);
}

// COMPAT(enrich-tier-rename #712): rows predating the off|local|model →
// off|device|gateway rename keep their old string, since a CHECK is fixed at
// `CREATE TABLE` time. `model` maps up unwidened; `local` maps DOWN to
// `device`, as nothing would yet catch a gateway-lane automation if it widened.
const LEGACY_TIER: Readonly<Record<string, EnrichTier>> = {
  local: "device",
  model: "gateway",
};

/** `undefined` when the value names neither a current nor a legacy tier. */
function normalizeTier(value: unknown): EnrichTier | undefined {
  if (isEnrichTier(value)) return value;
  if (typeof value === "string" && value in LEGACY_TIER)
    return LEGACY_TIER[value];
  return undefined;
}

/** `undefined` per the fail-closed contract above. */
export function readEnrichPolicyTier(
  vault: DatabaseSync,
  domain: EnrichDomain
): EnrichTier | undefined {
  const row = vault
    .prepare("SELECT tier FROM enrich_policy WHERE domain = ?")
    .get(domain) as { tier?: unknown } | undefined;
  return normalizeTier(row?.tier);
}

export interface EnrichPolicyResolutionInput {
  tier: EnrichTier | undefined;
  rules: EnrichPolicyRule[];
}

/**
 * The material `decideEnrichmentGate` folds for one capability (#807). It
 * resolves NOTHING: "may this run" is decided in the gate alone.
 */
export function readEnrichPolicyResolutionInput(
  vault: DatabaseSync,
  domain: EnrichDomain,
  capability: string,
  scopeChain?: readonly EnrichScope[]
): EnrichPolicyResolutionInput {
  const chain: readonly EnrichScope[] = scopeChain ?? [
    { type: "vault", ref: "" },
    { type: "domain", ref: domain },
  ];
  return {
    tier: readEnrichPolicyTier(vault, domain),
    rules: readEnrichPolicyRuleChain(vault, chain, capability),
  };
}
