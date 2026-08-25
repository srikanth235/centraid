/**
 * The policy cascade's RESOLVER (#807) — the half of the one gate that folds a
 * scope chain into a single answer. A SIBLING of `enrich-gate.ts`, never a
 * rival: imported by the gate, re-exported through it, and read by nothing
 * else, because the cascade must not become a second policy path.
 *
 * `null` in a rule means inherit, so the fold is "most specific non-null wins"
 * per FIELD, not per rule. A RULE MAY NOT MOVE THE EGRESS CEILING — the whole
 * safety argument: the legacy tier migrates in as a ceiling nothing deeper can
 * raise, so pinning a provider-backed profile onto one album cannot widen
 * egress past the vault's standing answer.
 *
 * FAIL-CLOSED: an unreadable tier with no rules resolves to `undefined`, which
 * the gate refuses; with rules it resolves against the most conservative base,
 * disabled at an `on-device` ceiling.
 */

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

/** `provider` is deliberately NOT reachable from a legacy tier: it is answered
 *  by the egress-consent ledger. */
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

/** Stops at the domain: the automation engine does not know which collection a
 *  fire is "about". */
export function automationScopeChain(domain: EnrichDomain): EnrichScope[] {
  return [
    { type: "vault", ref: "" },
    { type: "domain", ref: domain },
  ];
}

/* ---------- The host seam (`RunFireOptions.resolveEnrichPolicy`) ---------- */

export interface EnrichPolicyRequest {
  readonly domain: EnrichDomain;
  readonly capability: string;
  readonly lane: EnrichLane;
  /** Least-specific first; a field, so an on-demand run can pass a longer one. */
  readonly scopeChain: readonly EnrichScope[];
}

/** A bare {@link EnrichTier} stays a legal answer. */
export interface EnrichPolicyResolution {
  readonly tier: EnrichTier | undefined;
  readonly rules?: readonly EnrichPolicyRule[];
  /** `undefined` for a profile this gateway lacks, which the gate refuses. */
  readonly egressForProfile?: (
    profileId: string
  ) => EnrichEgressClass | undefined;
  /** A SECOND LOOKUP, NOT A SECOND POLICY PATH: the cascade says which engine a
   *  scope prefers, this says whether the member ever agreed to its egress
   *  class, and `decideEnrichmentGate` is still the only decider. `null` means
   *  never asked, which is not a grant; omitting it fails closed. */
  readonly egressConsent?: (
    egress: EnrichEgressClass
  ) => EnrichConsentRecord | null | undefined;
  /** Two lookups over one registry on purpose: the gate reads the egress class
   *  and nothing else, and this is read only AFTER the gate allowed the run, so
   *  no engine detail can influence a permission decision. */
  readonly engineForProfile?: (
    profileId: string
  ) => ResolvedEngineBinding | undefined;
}

/** Deliberately NOT the whole profile: the fire path has no business knowing a
 *  profile's label or egress class — only whether the bundled engine or a
 *  harness computes this, and with what binding. */
export interface ResolvedEngineBinding {
  readonly kind: "built-in" | "delegate";
  readonly harness?: HarnessKind;
  /** Whatever id the harness offered — data, never a literal. */
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

/** `rules` must be the chain for ONE capability, least-specific first; rules
 *  naming another are ignored rather than trusted. `undefined` means the vault
 *  stated no policy this runtime can honour, and the caller MUST read that as a
 *  refusal. */
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
