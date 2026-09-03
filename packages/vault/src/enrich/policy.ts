import type { DatabaseSync } from "node:sqlite";

import type { EnrichTier } from "../host.js";
import { readEnrichPolicyRuleChain } from "./policy-rules.js";
import type { EnrichPolicyRule, EnrichScope } from "./policy-rules.js";

export const ENRICH_DOMAINS = ["photos", "docs"] as const;
export type EnrichDomain = (typeof ENRICH_DOMAINS)[number];

const TIERS = new Set(["off", "device", "gateway"]);

export function isEnrichTier(value: unknown): value is EnrichTier {
  return typeof value === "string" && TIERS.has(value);
}

const LEGACY_TIER: Readonly<Record<string, EnrichTier>> = {
  local: "device",
  model: "gateway",
};

function normalizeTier(value: unknown): EnrichTier | undefined {
  if (isEnrichTier(value)) return value;
  if (typeof value === "string" && value in LEGACY_TIER)
    return LEGACY_TIER[value];
  return undefined;
}

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
