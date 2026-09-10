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

/**
 * ONE capability's chain, least-specific first; `undefined` = refuse.
 *
 * SYSTEM PROVENANCE CHANGES THE FLOOR, NOT THE CEILING (`options.system`). For a
 * first-party system automation the only decision left to the member is the
 * CLOUD tier: egress leaves their trust domain and needs consent, while
 * on-device work over their own bytes on their own gateway needs none. So an
 * unwritten policy resolves to enabled-on-device instead of a refusal. Every
 * rule the member did write still applies, and the egress ceiling is untouched
 * — a system automation gets no wider reach than any other.
 */
export function resolveEnrichmentPolicy(
  rules: readonly EnrichPolicyRule[],
  legacyTier: EnrichTier | undefined,
  capability: string,
  options?: { readonly system?: boolean }
): ResolvedEnrichPolicy | undefined {
  const system = options?.system === true;
  const mine = rules.filter((rule) => rule.capability === capability);
  if (legacyTier === undefined && mine.length === 0) {
    if (!system) return undefined;
    return {
      capability,
      enabled: true,
      profileId: BUILT_IN_PROFILE,
      trigger: DEFAULT_ENRICH_TRIGGER,
      egressCeiling: "on-device",
    };
  }

  let enabled = legacyTier === undefined ? system : legacyTier !== "off";
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
