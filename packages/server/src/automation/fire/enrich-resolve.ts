import { BUILT_IN_PROFILE } from "@centraid/vault";
import type {
  EnrichConsentRecord,
  EnrichEgressClass,
  EnrichPolicyRule,
  EnrichScope,
  EnrichTrigger,
} from "@centraid/vault";

import type { HarnessKind } from "../../engine/conversation/turn.js";
import type { EnrichDomain, EnrichLane, EnrichTier } from "./enrich-gate.js";

export type EnrichEgressCeiling = EnrichEgressClass | "off";

export interface ResolvedEnrichPolicy {
  readonly capability: string;
  readonly enabled: boolean;
  readonly profileId: string;
  readonly trigger: EnrichTrigger;
  readonly egressCeiling: EnrichEgressCeiling;
}

export const DEFAULT_ENRICH_TRIGGER: EnrichTrigger = "on-ingest";

export function tierEgressCeiling(tier: EnrichTier): EnrichEgressCeiling {
  if (tier === "off") return "off";
  return tier === "device" ? "on-device" : "gateway";
}

const EGRESS_RANK: Record<EnrichEgressCeiling, number> = {
  off: 0,
  "on-device": 1,
  gateway: 2,
  provider: 3,
};

export function egressWithinCeiling(
  egress: EnrichEgressClass,
  ceiling: EnrichEgressCeiling
): boolean {
  return EGRESS_RANK[egress] <= EGRESS_RANK[ceiling];
}

export function automationScopeChain(domain: EnrichDomain): EnrichScope[] {
  return [
    { type: "vault", ref: "" },
    { type: "domain", ref: domain },
  ];
}

export interface EnrichPolicyRequest {
  readonly domain: EnrichDomain;
  readonly capability: string;
  readonly lane: EnrichLane;
  readonly scopeChain: readonly EnrichScope[];
}

export interface EnrichPolicyResolution {
  readonly tier: EnrichTier | undefined;
  readonly rules?: readonly EnrichPolicyRule[];
  readonly egressForProfile?: (
    profileId: string
  ) => EnrichEgressClass | undefined;
  readonly egressConsent?: (
    egress: EnrichEgressClass
  ) => EnrichConsentRecord | null | undefined;
  readonly engineForProfile?: (
    profileId: string
  ) => ResolvedEngineBinding | undefined;
}

export interface ResolvedEngineBinding {
  readonly kind: "built-in" | "delegate";
  readonly harness?: HarnessKind;
  readonly model?: string;
  readonly configPins?: Readonly<Record<string, string>>;
  readonly promptRev?: string;
}

export type ResolveEnrichPolicy = (
  request: EnrichPolicyRequest
) =>
  | Promise<EnrichPolicyResolution | EnrichTier | undefined>
  | EnrichPolicyResolution
  | EnrichTier
  | undefined;

export function resolveEnrichmentPolicy(
  rules: readonly EnrichPolicyRule[],
  legacyTier: EnrichTier | undefined,
  capability: string
): ResolvedEnrichPolicy | undefined {
  const mine = rules.filter((rule) => rule.capability === capability);
  if (legacyTier === undefined && mine.length === 0) return undefined;

  let enabled = legacyTier === undefined ? false : legacyTier !== "off";
  const egressCeiling: EnrichEgressCeiling =
    legacyTier === undefined ? "on-device" : tierEgressCeiling(legacyTier);
  let profileId = BUILT_IN_PROFILE;
  let trigger: EnrichTrigger = DEFAULT_ENRICH_TRIGGER;

  for (const rule of mine) {
    if (rule.enabled !== null) enabled = rule.enabled;
    if (rule.profile !== null) profileId = rule.profile;
    if (rule.trigger !== null) trigger = rule.trigger;
  }

  return { capability, enabled, profileId, trigger, egressCeiling };
}
