/*
 * Settings → Enrichment's data seam (the S9 counterpart control).
 *
 * The authoritative writer for the enrichment tier is the vault's own
 * `updateEnrichSettings` (packages/vault/src/host.ts) behind
 * `PUT /centraid/_vault/enrich` — runtime wins, per docs/config-ownership.md's
 * "Vault ontology settings" row. That same writer refreshes the `enrich_policy`
 * mirror the enforcement gate reads, which is why this UI must go through the
 * route and never near the mirror table: a write that touched only the mirror
 * would drift the moment the settings bag was written again.
 *
 * Thin on purpose — the screen owns the copy and the consent question; this
 * module owns only the wire shape and the read-back-after-write rule.
 */

import type {
  EnrichDomain,
  EnrichPolicy,
  EnrichTier,
} from "../../../enrich-policy.js";
import {
  getEnrichPolicy,
  setEnrichPolicy,
} from "../../../gateway-client-vault.js";

export function loadEnrichPolicy(): Promise<EnrichPolicy> {
  return getEnrichPolicy();
}

/**
 * Write ONE domain's tier. Deliberately single-domain: the route accepts a
 * patch over both, but a control that could move photos and documents in one
 * request would let a single consent answer raise a domain the member never
 * looked at — the same "consents to more than it names" failure S9 names.
 */
export function setEnrichTier(
  domain: EnrichDomain,
  tier: EnrichTier
): Promise<EnrichPolicy> {
  return setEnrichPolicy({ [domain]: tier });
}
