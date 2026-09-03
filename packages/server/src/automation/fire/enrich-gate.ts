import type { EnrichConsentRecord, EnrichEgressClass } from "@centraid/vault";

import { egressWithinCeiling } from "./enrich-resolve.js";
import type { ResolvedEnrichPolicy } from "./enrich-resolve.js";

export {
  DEFAULT_ENRICH_TRIGGER,
  automationScopeChain,
  egressWithinCeiling,
  resolveEnrichmentPolicy,
  tierEgressCeiling,
} from "./enrich-resolve.js";
export type { EnrichConsentRecord, EnrichEgressClass } from "@centraid/vault";
export type {
  EnrichEgressCeiling,
  EnrichPolicyRequest,
  EnrichPolicyResolution,
  ResolveEnrichPolicy,
  ResolvedEngineBinding,
  ResolvedEnrichPolicy,
} from "./enrich-resolve.js";

export const ENRICH_TIERS = ["off", "device", "gateway"] as const;
export type EnrichTier = (typeof ENRICH_TIERS)[number];

export const ENRICH_DOMAINS = ["photos", "docs"] as const;
export type EnrichDomain = (typeof ENRICH_DOMAINS)[number];

export const ENRICH_LANES = ["device", "gateway"] as const;
export type EnrichLane = (typeof ENRICH_LANES)[number];

const RANK: Record<EnrichTier, number> = { off: 0, device: 1, gateway: 2 };

export interface EnrichGateInput {
  readonly automationRef: string;
  readonly domain: EnrichDomain;
  readonly capability: string;
  readonly lane: EnrichLane;
  readonly tier: EnrichTier | undefined;
  readonly policy?: ResolvedEnrichPolicy;
  readonly profileEgress?: EnrichEgressClass | undefined;
  readonly egressConsent?: EnrichEgressConsentLookup;
}

export type EnrichEgressConsentLookup = (
  egress: EnrichEgressClass
) => EnrichConsentRecord | null | undefined;

export type EnrichGateDecision =
  | {
      readonly allowed: true;
      readonly sealModelTurns: boolean;
      readonly egressConsentNeeded?: EnrichEgressClass;
    }
  | { readonly allowed: false; readonly reason: string };

export function decideEnrichmentGate(
  input: EnrichGateInput
): EnrichGateDecision {
  const who = `${input.automationRef} (enrichment "${input.capability}", domain "${input.domain}")`;
  if (input.tier === undefined) {
    return {
      allowed: false,
      reason:
        `${who} refused: this vault's enrichment policy for "${input.domain}" could not be read, ` +
        `and an unreadable policy is a refusal, not a default.`,
    };
  }
  const policy = input.policy;
  if (policy && !policy.enabled && input.tier !== "off") {
    return {
      allowed: false,
      reason:
        `${who} refused: this vault's enrichment policy has "${input.capability}" switched off ` +
        `at the scope that decides it.`,
    };
  }
  if (RANK[input.lane] > RANK[input.tier]) {
    if (input.tier === "off") {
      return {
        allowed: false,
        reason: `${who} refused: enrichment is switched off for "${input.domain}" in this vault's privacy settings.`,
      };
    }
    return {
      allowed: false,
      reason:
        `${who} refused: enrichment for "${input.domain}" is set to "${input.tier}", and this enricher needs the ` +
        `"${input.lane}" lane — a model turn through the harness registry, which every harness in this runtime ` +
        `routes to a third-party provider, so the run would leave this member's trust domain. Set the tier to ` +
        `"gateway" to allow that, or use the device lane.`,
    };
  }
  if (!policy)
    return { allowed: true, sealModelTurns: input.tier !== "gateway" };

  const egress = input.profileEgress;
  if (egress === undefined) {
    return {
      allowed: false,
      reason:
        `${who} refused: this vault's enrichment policy points "${input.capability}" at engine profile ` +
        `"${policy.profileId}", which this gateway does not carry.`,
    };
  }
  const providerOverGatewayCeiling =
    egress === "provider" && policy.egressCeiling === "gateway";
  if (
    !egressWithinCeiling(egress, policy.egressCeiling) &&
    !providerOverGatewayCeiling
  ) {
    return {
      allowed: false,
      reason:
        `${who} refused: engine profile "${policy.profileId}" runs with "${egress}" egress, and this vault's ` +
        `enrichment policy for "${input.domain}" allows no further than "${policy.egressCeiling}". ` +
        `A rule on a collection or item can choose an engine, never one that reaches further than the vault allows.`,
    };
  }
  if (egress === "provider") {
    const record = input.egressConsent?.(egress) ?? null;
    if (record === null) {
      return {
        allowed: false,
        reason:
          `${who} refused: engine profile "${policy.profileId}" reaches a third-party provider, and this vault holds ` +
          `no egress consent for "${input.capability}" at "provider". That answer is asked once, per capability, and ` +
          `recorded — an absent answer is not a grant, and choosing this engine cannot write one.`,
      };
    }
    if (record.decision !== "granted") {
      return {
        allowed: false,
        reason:
          `${who} refused: provider egress for "${input.capability}" was declined on ${record.decidedAt}, and a ` +
          `declined answer stands until the member answers again. A rule that picks a provider-backed engine cannot ` +
          `overturn it.`,
      };
    }
  }
  return {
    allowed: true,
    sealModelTurns: policy.egressCeiling !== "gateway",
    egressConsentNeeded: egress,
  };
}

export function sealedModelTurnReason(
  automationRef: string,
  domain: EnrichDomain
): string {
  return (
    `${automationRef}: ctx.delegate is refused — enrichment for "${domain}" is set to "device" in this vault, ` +
    `and a model turn in this runtime always routes to a third-party provider.`
  );
}
