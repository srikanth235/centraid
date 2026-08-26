// Policy gate resolver (#807): most-specific non-null per FIELD; ceiling
// immovable. Fail-closed: no honourable policy → undefined.

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

/** Legacy tiers cannot reach `provider`. */
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

/** Stops at the domain — never the collection. */
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
  /** Unknown profile — the gate refuses. */
  readonly egressForProfile?: (
    profileId: string
  ) => EnrichEgressClass | undefined;
  /** Prior consent; `null` = never asked; omitting fails closed. */
  readonly egressConsent?: (
    egress: EnrichEgressClass
  ) => EnrichConsentRecord | null | undefined;
  /** Read only AFTER the gate allows the run. */
  readonly engineForProfile?: (
    profileId: string
  ) => ResolvedEngineBinding | undefined;
}

/** NOT the whole profile — harness kind + binding only. */
export interface ResolvedEngineBinding {
  readonly kind: "built-in" | "delegate";
  readonly harness?: HarnessKind;
  /** Harness-offered id — data, never a literal. */
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

/** ONE capability's chain, least-specific first; `undefined` = refuse. */
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
