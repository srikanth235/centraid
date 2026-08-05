// The enforceable read of the owner's per-domain enrichment tier.
//
// `enrich_policy` (schema/enrich.ts) is the queryable MIRROR of
// `core_vault.settings_json.enrich`, written by host.ts's
// `updateEnrichSettings` and seeded at bootstrap. Until this module existed
// the mirror had exactly two readers — the settings surface that wrote it and
// the Photos app's `enrichment-status` query — and NOTHING on the execution
// path. That made `local` ("what leaves the device → nothing") a claim the
// backend never kept: enrichment automations fired and called `ctx.agent`
// regardless of the tier.
//
// This is the tier read the enforcement choke point uses (see
// `packages/automation/src/fire/enrich-gate.ts` for the decision and
// `runFire` for where it is applied). It is deliberately host-plane — a raw
// `DatabaseSync`, not the consent-checked app bridge — because a guard must
// never depend on the grants of the party it guards: an enricher whose vault
// grant omitted `enrich` would otherwise read as "policy unavailable" and,
// under any non-fail-closed reading, as permission.
//
// FAIL-CLOSED CONTRACT: `undefined` means "this vault did not state a tier
// that can be honoured" — a missing row, a value outside the enum, or a
// schema old enough not to carry the table. Callers MUST treat `undefined`
// as a refusal, never as a default. A thrown SQLite error propagates for the
// same reason: the caller refuses rather than guesses.

import type { DatabaseSync } from "node:sqlite";

import type { EnrichTier } from "../host.js";

/** The domains `enrich_policy` is keyed by (CHECK-constrained in the DDL). */
export const ENRICH_DOMAINS = ["photos", "docs"] as const;
export type EnrichDomain = (typeof ENRICH_DOMAINS)[number];

const TIERS = new Set(["off", "local", "model"]);

/** Validation guard for a persisted string claiming to be a tier. */
export function isEnrichTier(value: unknown): value is EnrichTier {
  return typeof value === "string" && TIERS.has(value);
}

/**
 * The owner's standing enrichment tier for one domain, or `undefined` when
 * the vault does not state one this runtime can honour — see the fail-closed
 * contract above.
 */
export function readEnrichPolicyTier(
  vault: DatabaseSync,
  domain: EnrichDomain
): EnrichTier | undefined {
  const row = vault
    .prepare("SELECT tier FROM enrich_policy WHERE domain = ?")
    .get(domain) as { tier?: unknown } | undefined;
  return isEnrichTier(row?.tier) ? row.tier : undefined;
}
