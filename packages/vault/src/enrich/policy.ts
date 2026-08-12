// The enforceable read of the owner's per-domain enrichment tier.
//
// `enrich_policy` (schema/enrich.ts) is the queryable MIRROR of
// `core_vault.settings_json.enrich`, written by host.ts's
// `updateEnrichSettings` and seeded at bootstrap. Until this module existed
// the mirror had exactly two readers — the settings surface that wrote it and
// the Photos app's `enrichment-status` query — and NOTHING on the execution
// path. That made the on-device tier's "what leaves the device → nothing"
// claim one the backend never kept: enrichment automations fired and called
// `ctx.delegate` regardless of the tier.
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

const TIERS = new Set(["off", "device", "gateway"]);

/** Validation guard for a persisted string claiming to be a (canonical,
 *  post-rename) tier. Does NOT accept the legacy `local`/`model` strings —
 *  see `normalizeTier` for those. */
export function isEnrichTier(value: unknown): value is EnrichTier {
  return typeof value === "string" && TIERS.has(value);
}

// COMPAT(enrich-tier-rename #712): a table row written before the
// off|local|model → off|device|gateway rename keeps whatever string it was
// last written with — the mirror table's own CHECK constraint is fixed at
// `CREATE TABLE` time (see schema/enrich.ts), so an already-migrated vault's
// physical row does not rewrite itself just because this build's DDL text
// changed. `model` already meant "this domain may take a model turn", which
// is what `gateway` means now, so it maps up with no widening. `local` meant
// NO model turn, and there is no per-capability consent gate on the
// execution path yet (decision S9) that would catch a gateway-lane
// automation the instant `local` was reinterpreted as the wider `gateway` —
// so it maps down to the conservative `device`, the same "no gateway-lane
// work" behaviour the vault already had, under the new name. See
// `packages/vault/src/schema/enrich.ts` and issue #712's C5 receipt for the
// full reasoning and the sabotage test that pins it.
const LEGACY_TIER: Readonly<Record<string, EnrichTier>> = {
  local: "device",
  model: "gateway",
};

/** Canonicalizes a raw stored value into a tier this build can honour, or
 *  `undefined` when it names neither a current nor a legacy tier. */
function normalizeTier(value: unknown): EnrichTier | undefined {
  if (isEnrichTier(value)) return value;
  if (typeof value === "string" && value in LEGACY_TIER)
    return LEGACY_TIER[value];
  return undefined;
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
  return normalizeTier(row?.tier);
}
