/**
 * The policy cascade's RESOLVER (#807) — the half of the one
 * gate that folds a scope chain into a single answer.
 *
 * WHY IT LIVES BESIDE `enrich-gate.ts` AND IS RE-EXPORTED THROUGH IT. There is
 * exactly one gate on the execution path (`decideEnrichmentGate`), and the
 * cascade must not become a second policy path — `packages/vault/src/enrich/
 * policy-rules.ts` says the same thing from the storage side, which is why
 * that module deliberately answers no "may this run" question. This file is a
 * SIBLING of the gate, not a rival: it is imported by the gate, re-exported
 * through it, and has no reader that is not the gate (the effective-policy
 * route reports what the gate WOULD resolve; it decides nothing).
 *
 * WHAT A LEVEL MAY DECIDE, AND WHAT IT MAY NEVER. A rule states, per
 * capability, three things: whether the capability is enabled, which engine
 * profile computes it, and when it is offered (`on-ingest | on-view |
 * on-demand`). `null` means inherit, so the fold is "most specific non-null
 * wins", per FIELD rather than per rule — a collection that only pins a
 * profile keeps the vault's enabled/trigger answers.
 *
 * A rule may NOT move the EGRESS CEILING. That is the whole safety argument of
 * this wave: the legacy per-domain tier (`off | device | gateway`) migrates
 * into the vault-default layer as a ceiling on how far work may go —
 * `off` -> nothing runs, `device` -> `on-device`, `gateway` -> `gateway` — and
 * nothing deeper in the cascade can raise it. A member pinning a provider-
 * backed profile onto one album therefore cannot widen egress past what the
 * vault standing answer allows; the gate refuses the profile instead. The
 * ceiling only ever narrows what is reachable, so every legacy vault keeps
 * exactly the behaviour it had.
 *
 * FAIL-CLOSED. An unreadable tier with no rules at all resolves to
 * `undefined` — "this vault did not state a policy that can be honoured" —
 * which the gate turns into a refusal, never a default (the same contract
 * `packages/vault/src/enrich/policy.ts` states for the tier read). An
 * unreadable tier that nonetheless carries rules resolves against the most
 * conservative base this runtime has: disabled, `on-device` ceiling. Rules can
 * then enable the capability, but never past a device-local engine.
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

/**
 * How far work for a capability may go. `off` is the absence of any lane,
 * kept distinct from `on-device` so "switched off" and "device only" stay
 * different answers in every message the member reads.
 *
 * `provider` is deliberately NOT reachable from a legacy tier: provider egress
 * is answered by the egress-consent ledger (Wave 3, `enrich_consent`), never
 * by a standing tier.
 */
export type EnrichEgressCeiling = EnrichEgressClass | "off";

/** The one answer the cascade produces for one capability at one scope. */
export interface ResolvedEnrichPolicy {
  readonly capability: string;
  readonly enabled: boolean;
  /** The engine profile the most specific level pinned, or the built-in. */
  readonly profileId: string;
  readonly trigger: EnrichTrigger;
  /** Set by the vault-default layer alone — see the header. */
  readonly egressCeiling: EnrichEgressCeiling;
}

/** The trigger a scope inherits when no level states one. */
export const DEFAULT_ENRICH_TRIGGER: EnrichTrigger = "on-ingest";

/** The ceiling each legacy tier migrates to. */
export function tierEgressCeiling(tier: EnrichTier): EnrichEgressCeiling {
  if (tier === "off") return "off";
  return tier === "device" ? "on-device" : "gateway";
}

/** Ordinal rank of an egress class; a profile may never exceed the ceiling. */
const EGRESS_RANK: Record<EnrichEgressCeiling, number> = {
  off: 0,
  "on-device": 1,
  gateway: 2,
  provider: 3,
};

/** Whether an engine's egress class fits inside a resolved ceiling. */
export function egressWithinCeiling(
  egress: EnrichEgressClass,
  ceiling: EnrichEgressCeiling
): boolean {
  return EGRESS_RANK[egress] <= EGRESS_RANK[ceiling];
}

/**
 * The scope chain an AUTOMATION fire resolves against today: the vault
 * default and the enrichment domain. Collection and item scopes exist in the
 * store and in the resolver's fold; nothing in the automation engine knows
 * which collection a fire is "about", so this chain stops at the domain and
 * on-demand runs pass their own longer chain instead of this helper.
 */
export function automationScopeChain(domain: EnrichDomain): EnrichScope[] {
  return [
    { type: "vault", ref: "" },
    { type: "domain", ref: domain },
  ];
}

/* ---------- The host seam (`RunFireOptions.resolveEnrichPolicy`) ---------- */

/** What the fire path asks its host for before an enrichment run. */
export interface EnrichPolicyRequest {
  readonly domain: EnrichDomain;
  /** The enricher's declared capability id — the key rules are written per. */
  readonly capability: string;
  readonly lane: EnrichLane;
  /**
   * Least-specific first. Today always {@link automationScopeChain}; the field
   * exists so an on-demand run CAN hand over a collection/item chain without
   * the automation engine learning what a collection is.
   */
  readonly scopeChain: readonly EnrichScope[];
}

/**
 * The cascade material a host answers with. A bare {@link EnrichTier} is still
 * a legal answer and means exactly what it meant before #807 — the pre-cascade
 * hosts and every test that stubs the seam keep working unchanged.
 */
export interface EnrichPolicyResolution {
  readonly tier: EnrichTier | undefined;
  /** The chain's rules for this capability, least-specific first. */
  readonly rules?: readonly EnrichPolicyRule[];
  /**
   * The computed egress class of an engine profile id, from the gateway's
   * profile registry (`enrich/engine-profiles.ts`). `undefined` for a profile
   * this gateway does not carry — which the gate refuses.
   */
  readonly egressForProfile?: (
    profileId: string
  ) => EnrichEgressClass | undefined;
  /**
   * The vault's standing egress ANSWER for this capability (#807, Wave
   * 3), walked over the same scope chain the rules were: most specific first,
   * the vault-wide `''` row last. `null` means the question was never asked,
   * which is not a grant.
   *
   * A SECOND LOOKUP, NOT A SECOND POLICY PATH: the cascade above says which
   * engine a scope prefers; this says whether the member ever agreed to that
   * engine's egress class. `decideEnrichmentGate` is still the only place
   * either answer becomes a decision. A host that omits it fails closed for
   * the one class that needs it (`provider`) and changes nothing for the two
   * the tier already answers.
   */
  readonly egressConsent?: (
    egress: EnrichEgressClass
  ) => EnrichConsentRecord | null | undefined;
  /**
   * The engine binding of a profile id, from the same gateway registry
   * `egressForProfile` answers from (#807). Two lookups over one
   * registry on purpose: the GATE reads the egress class and nothing else, and
   * this one is read only after the gate allowed the run — so no engine detail
   * can ever influence a permission decision.
   *
   * A host that omits it leaves selection with the enricher's own
   * `manifest.enrich.delegateStep.selected`.
   */
  readonly engineForProfile?: (
    profileId: string
  ) => ResolvedEngineBinding | undefined;
}

/**
 * HOW the profile the cascade selected computes its capability (#807,
 * Wave 5) — the engine half of `EngineProfile`, flattened to what the fire
 * path may act on.
 *
 * It is deliberately NOT the whole profile: the fire path has no business
 * knowing a profile's label or its computed egress class (the gate already
 * decided on that, from `egressForProfile`). What it needs is one fact: is
 * this capability being computed by the bundled engine or by a harness, and
 * if a harness, which model/pins the member bound it to.
 */
export interface ResolvedEngineBinding {
  readonly kind: "built-in" | "delegate";
  /** Delegate only: the harness the member bound this capability to. */
  readonly harness?: HarnessKind;
  /** Delegate only: whatever model id the harness offered — data, never a literal. */
  readonly model?: string;
  /** Delegate only: open ACP config categories the member pinned. */
  readonly configPins?: Readonly<Record<string, string>>;
  /** Delegate only: a prompt revision the member pinned the profile to. */
  readonly promptRev?: string;
}

/** The seam's full type — see `RunFireOptions.resolveEnrichPolicy`. */
export type ResolveEnrichPolicy = (
  request: EnrichPolicyRequest
) =>
  | Promise<EnrichPolicyResolution | EnrichTier | undefined>
  | EnrichPolicyResolution
  | EnrichTier
  | undefined;

/**
 * Fold a cascade into one answer. Pure: the host reads the tier and the rules,
 * this resolves, `decideEnrichmentGate` decides.
 *
 * `rules` must be the chain for ONE capability, least-specific first (the
 * order `readEnrichPolicyRuleChain` returns). Rules naming another capability
 * are ignored rather than trusted — a mis-keyed chain must not silently decide
 * for a capability it never mentioned.
 *
 * Returns `undefined` when the vault stated no policy this runtime can honour;
 * the caller MUST read that as a refusal.
 */
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
