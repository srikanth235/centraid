/**
 * Enrichment tier enforcement — the decision half. The vault's per-domain tier
 * (`off | device | gateway`) orders how far work may run; `runFire` applies it.
 *
 * THE LINE THIS RUNTIME DRAWS is not "does this leave the device": the gateway
 * is the member's own infrastructure, so egress is a property of the HARNESS
 * that reaches a provider, never of the machine issuing the call — which is why
 * the dispatcher gates each `ctx.delegate` call behind egress consent (#567).
 * An enricher DECLARES its lane, and the gate is `rank(lane) <= rank(tier)`; a
 * manifest omitting the lane reads as `gateway`, because assuming the cheaper
 * lane would be assuming consent.
 *
 * Under the cascade (#807) the tier is one layer, folded in
 * `enrich-resolve.ts` and re-exported here on purpose: there is ONE gate, and
 * the resolver is its first half, never a second policy path. The tier survives
 * as an EGRESS-CLASS CEILING no deeper level can raise.
 */
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
  /** `undefined` is a REFUSAL, never a default. */
  readonly tier: EnrichTier | undefined;
  readonly policy?: ResolvedEnrichPolicy;
  /** `undefined` (no such profile here) is a refusal, not a fallback. */
  readonly profileEgress?: EnrichEgressClass | undefined;
  /** A LOOKUP, NOT A GRANT: the host hands over what the vault holds and this
   *  gate decides, so a host that wires nothing fails closed. `null` means the
   *  question was never asked. Read only for the `provider` class. */
  readonly egressConsent?: EnrichEgressConsentLookup;
}

export type EnrichEgressConsentLookup = (
  egress: EnrichEgressClass
) => EnrichConsentRecord | null | undefined;

export type EnrichGateDecision =
  | {
      readonly allowed: true;
      /** True under `device`: the fire runs, `ctx.delegate` is refused. */
      readonly sealModelTurns: boolean;
      /** Downstream reads it to SAY what an allowed run's egress was, never to
       *  decide again. */
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
  // BEFORE the rank comparison, so "a rule switched this off" is the reason
  // read rather than a message about a tier nobody touched.
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

  // A deeper level may PICK an engine, never one past the vault's ceiling. An
  // unknown profile is a refusal: unnameable egress cannot be judged safe.
  const egress = input.profileEgress;
  if (egress === undefined) {
    return {
      allowed: false,
      reason:
        `${who} refused: this vault's enrichment policy points "${input.capability}" at engine profile ` +
        `"${policy.profileId}", which this gateway does not carry.`,
    };
  }
  // THE CEILING, then THE ANSWER — two independent questions, in that order.
  // `provider` is the one class no standing tier answers for, so a `gateway`
  // ceiling defers to the EGRESS-CONSENT LEDGER rather than refusing. Below a
  // `gateway` ceiling the tier refuses first: a vault that never allowed work to
  // leave the device is not asking a consent question at all.
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
    // INDEPENDENT of everything above. `on-device` and `gateway` are not asked:
    // the standing tier IS their recorded answer, which is why enrichers from
    // before #807 run with no rows at all. AN `on-device` ROW IS A RECORD, NOT
    // A SECOND GATE — that latch is per-device by law (#712 C3), so enforcing
    // one device's "not now" here would bind every device and the gateway.
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
