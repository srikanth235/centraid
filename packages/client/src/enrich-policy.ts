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
