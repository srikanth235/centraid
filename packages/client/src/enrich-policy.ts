/*
 * The enrichment-tier vocabulary, client side.
 *
 * Deliberately its OWN module with no imports: the settings screen that
 * renders the tier is a pure component, and pulling this vocabulary out of
 * `gateway-client-vault.ts` would drag the whole authenticated transport (and
 * its `window.CentraidApi` requirement) into a render test.
 *
 * These three values are a mirror of the vault's enum
 * (`packages/vault/src/host.ts` `EnrichTier`, CHECK-constrained in
 * `enrich_policy`'s DDL) and of the gate's
 * (`packages/server/src/automation/fire/enrich-gate.ts`). They are restated rather
 * than imported because the client does not depend on either package; the
 * route rejects anything outside the enum with a 400, so a drift here fails
 * loudly at the seam instead of silently widening what the owner may set.
 *
 * Renamed `off | local | model` → `off | device | gateway` by issue #712 C5:
 * one axis, three points, ordered by how far enrichment may run — `device`
 * is the member's own phone/laptop (plus deterministic gateway work),
 * `gateway` is the member's own gateway doing whatever it is already wired
 * to. There is no separate `provider` tier; a third-party provider seeing
 * bytes is gated per call (#567) and per capability (decision S9),
 * independently of this tier.
 */

/** The owner's standing tier for one enrichment domain. */
export type EnrichTier = "off" | "device" | "gateway";

/** Every domain the tier is authored per. Order is the render order. */
export const ENRICH_DOMAINS = ["photos", "docs"] as const;
export type EnrichDomain = (typeof ENRICH_DOMAINS)[number];

export type EnrichPolicy = Record<EnrichDomain, EnrichTier>;

/*
 * The policy CASCADE (issue #807), same restatement discipline as the tier
 * above: mirrors of `packages/vault/src/enrich/policy-rules.ts`, kept here so
 * a settings screen can render a rule without importing the transport. The
 * route 400s anything outside these enums.
 */

/** The cascade levels, least to most specific. Order is the cascade order. */
export const ENRICH_SCOPE_TYPES = [
  "vault",
  "domain",
  "collection",
  "item",
] as const;
export type EnrichScopeType = (typeof ENRICH_SCOPE_TYPES)[number];

/** When a capability's work is offered at a scope. */
export const ENRICH_TRIGGERS = ["on-ingest", "on-view", "on-demand"] as const;
export type EnrichTrigger = (typeof ENRICH_TRIGGERS)[number];

/** One level of the cascade. `ref` is `''` at vault scope. */
export interface EnrichScope {
  type: EnrichScopeType;
  ref: string;
}

/** What one scope decides about one capability; `null` means inherit. */
export interface EnrichPolicyRule {
  scope: EnrichScope;
  capability: string;
  enabled: boolean | null;
  profile: string | null;
  trigger: EnrichTrigger | null;
  updatedAt: string;
}

/** How far work may go — the tier's semantics, as an egress ceiling. */
export type EnrichEgressCeiling = "off" | "on-device" | "gateway" | "provider";

/**
 * What the gateway's ONE resolver folds the cascade into. Reported by
 * `GET /_vault/enrich/effective`; it is a report, never permission — the
 * runtime gate decides, and this is what it would see.
 */
export interface ResolvedEnrichPolicy {
  capability: string;
  enabled: boolean;
  profileId: string;
  trigger: EnrichTrigger;
  egressCeiling: EnrichEgressCeiling;
}
