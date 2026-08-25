// governance: allow-repo-hygiene file-size-limit pre-existing debt (553 lines before issue #352 touched it for enrich-policy mirroring); splitting is a separate cleanup, not bundled into this feature change
// Host-integration helpers (§12): what an embedding process needs to run a
// vault across restarts without keeping credential state of its own. Identity
// is v0 key-equality, so the host recovers credentials by reading the enrolled
// rows back.

import { enrollAgent, enrollApp } from "./bootstrap.js";
import type { BootstrapResult } from "./bootstrap.js";
import type { VaultDb } from "./db.js";
import type { FilterClause, Risk } from "./gateway/types.js";
import { nowIso } from "./ids.js";

export interface HostBootstrap extends BootstrapResult {
  /** true when this call created the vault; false when it recovered one. */
  fresh: boolean;
}

/**
 * Recover an existing vault. An absent `core_vault` row is an explicit
 * uninitialized result — creation belongs to the gateway founding gate.
 */
export function recoverVaultBootstrap(db: VaultDb): HostBootstrap | undefined {
  const vaultRow = db.vault
    .prepare(
      "SELECT vault_id, owner_party_id, display_name FROM core_vault LIMIT 1"
    )
    .get() as
    | { vault_id: string; owner_party_id: string; display_name: string }
    | undefined;
  if (!vaultRow) return undefined;

  const device = db.vault
    .prepare(
      `SELECT device_id, public_key FROM consent_device
        WHERE owner_party_id = ? AND trust = 'full' ORDER BY enrolled_at LIMIT 1`
    )
    .get(vaultRow.owner_party_id) as
    | { device_id: string; public_key: string }
    | undefined;
  if (!device) {
    throw new Error(
      "vault exists but has no full-trust owner device to recover"
    );
  }
  const concepts: Record<string, string> = {};
  const rows = db.vault
    .prepare(
      "SELECT notation, concept_id FROM core_concept ORDER BY concept_id"
    )
    .all() as { notation: string; concept_id: string }[];
  for (const row of rows) concepts[row.notation] ??= row.concept_id;
  return {
    vaultId: vaultRow.vault_id,
    displayName: vaultRow.display_name,
    ownerPartyId: vaultRow.owner_party_id,
    deviceId: device.device_id,
    deviceKey: device.public_key,
    concepts,
    fresh: false,
  };
}

export function renameVault(db: VaultDb, displayName: string): void {
  db.vault.prepare("UPDATE core_vault SET display_name = ?").run(displayName);
}

/**
 * Owner-facing presentation (#280 — profiles are vaults), in
 * `core_vault.settings_json`: avatar color, icon and blurb belong to the VAULT,
 * not a client's localStorage, so they survive export and device changes.
 */
export interface VaultPresentation {
  color?: string;
  icon?: string;
  blurb?: string;
}

/** `{}` when unset. */
export function readVaultSettings(db: VaultDb): Record<string, unknown> {
  const row = db.vault
    .prepare("SELECT settings_json FROM core_vault LIMIT 1")
    .get() as { settings_json: string | null } | undefined;
  if (!row?.settings_json) return {};
  try {
    const parsed = JSON.parse(row.settings_json) as unknown;
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readVaultPresentation(db: VaultDb): VaultPresentation {
  const bag = readVaultSettings(db).presentation;
  if (bag === null || typeof bag !== "object" || Array.isArray(bag)) return {};
  const p = bag as Record<string, unknown>;
  return {
    ...(typeof p.color === "string" ? { color: p.color } : {}),
    ...(typeof p.icon === "string" ? { icon: p.icon } : {}),
    ...(typeof p.blurb === "string" ? { blurb: p.blurb } : {}),
  };
}

/**
 * Whether this is its owner's PERSONAL vault — the one a gateway defaults to
 * when a caller names none. The marker lives in the settings bag, NOT in
 * creation order or the display name: ids are UUIDv7, so "oldest" is the shared
 * household vault, and the desktop fresh path renames the personal vault to the
 * owner's display name. A flag written at founding travels through rename,
 * export, backup and restore.
 */
export function readVaultPersonal(db: VaultDb): boolean {
  return readVaultSettings(db).personal === true;
}

/** Founding act — see above. */
export function markVaultPersonal(db: VaultDb): void {
  const settings = readVaultSettings(db);
  settings.personal = true;
  db.vault
    .prepare("UPDATE core_vault SET settings_json = ?")
    .run(JSON.stringify(settings));
}

/** `null`/empty-string values CLEAR a field. */
export function updateVaultPresentation(
  db: VaultDb,
  patch: Partial<Record<keyof VaultPresentation, string | null>>
): VaultPresentation {
  const settings = readVaultSettings(db);
  const current = readVaultPresentation(db) as Record<string, unknown>;
  for (const key of ["color", "icon", "blurb"] as const) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === null || v === undefined || v === "") delete current[key];
    else current[key] = v;
  }
  settings.presentation = current;
  db.vault
    .prepare("UPDATE core_vault SET settings_json = ?")
    .run(JSON.stringify(settings));
  return current as VaultPresentation;
}

/**
 * Byte-custody patch into `core_vault.settings_json` (#296): the `blob_store`
 * bag — credentials NEVER live here, they are harness-ambient — and the
 * `media.location` GPS policy. The custody facade re-reads settings on every
 * use, so a change takes effect without a reopen.
 */
export function updateBlobStoreSettings(
  db: VaultDb,
  patch: {
    blob_store?: Record<string, unknown> | null;
    media_location?: "keep" | "strip" | null;
  }
): Record<string, unknown> {
  const settings = readVaultSettings(db);
  if ("blob_store" in patch) {
    if (patch.blob_store === null) delete settings.blob_store;
    else settings.blob_store = patch.blob_store;
  }
  if ("media_location" in patch) {
    const media =
      settings.media !== null &&
      typeof settings.media === "object" &&
      !Array.isArray(settings.media)
        ? (settings.media as Record<string, unknown>)
        : {};
    if (patch.media_location === null) delete media.location;
    else media.location = patch.media_location;
    settings.media = media;
  }
  db.vault
    .prepare("UPDATE core_vault SET settings_json = ?")
    .run(JSON.stringify(settings));
  return settings;
}

/**
 * Enrichment tier per domain (#299 §2, renamed by #712 C5): `off` runs nothing,
 * `device` is the member's own phone/laptop plus deterministic gateway work,
 * `gateway` additionally allows whatever that gateway is wired to, model turns
 * included (`server/src/automation/fire/enrich-gate.ts`). Absent = `gateway`.
 */
export type EnrichTier = "off" | "device" | "gateway";

export interface EnrichSettings {
  photos: EnrichTier;
  docs: EnrichTier;
}

const ENRICH_TIERS: readonly EnrichTier[] = ["off", "device", "gateway"];

// COMPAT(enrich-tier-rename #712): `settings_json` is free-form with no CHECK,
// so a bag written before the rename may still hold `local`/`model`. `model`
// already meant "may take a model turn", so it maps up to `gateway` with no
// widening. `local` meant NO model turn, and no per-capability consent gate
// exists yet on the execution path (decision S9) to catch a model-lane
// automation the instant it were reinterpreted, so it maps to `device`.
const LEGACY_TIER: Readonly<Record<string, EnrichTier>> = {
  local: "device",
  model: "gateway",
};

/**
 * `gateway` is the default on both domains: Tier-0 derivation never leaves the
 * member's trust domain, so it needs no opt-in. A THIRD-PARTY PROVIDER seeing
 * bytes is gated separately, per call (#567) and per capability, independently
 * of this tier.
 */
export function readEnrichSettings(db: VaultDb): EnrichSettings {
  const bag = readVaultSettings(db).enrich;
  const e =
    bag !== null && typeof bag === "object" && !Array.isArray(bag)
      ? (bag as Record<string, unknown>)
      : {};
  const tier = (v: unknown): EnrichTier => {
    if (
      typeof v === "string" &&
      (ENRICH_TIERS as readonly string[]).includes(v)
    )
      return v as EnrichTier;
    if (typeof v === "string" && v in LEGACY_TIER)
      return LEGACY_TIER[v] as EnrichTier;
    return "gateway";
  };
  return { photos: tier(e.photos), docs: tier(e.docs) };
}

export function updateEnrichSettings(
  db: VaultDb,
  patch: Partial<Record<"photos" | "docs", EnrichTier | null>>
): EnrichSettings {
  const settings = readVaultSettings(db);
  const current =
    settings.enrich !== null &&
    typeof settings.enrich === "object" &&
    !Array.isArray(settings.enrich)
      ? (settings.enrich as Record<string, unknown>)
      : {};
  for (const key of ["photos", "docs"] as const) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === null || v === undefined) delete current[key];
    else if ((ENRICH_TIERS as readonly string[]).includes(v)) current[key] = v;
    else
      throw new Error(
        `enrich.${key} must be one of ${ENRICH_TIERS.join(", ")}`
      );
  }
  settings.enrich = current;
  db.vault
    .prepare("UPDATE core_vault SET settings_json = ?")
    .run(JSON.stringify(settings));
  const resolved = readEnrichSettings(db);
  // Mirror into `enrich_policy` (#352): the JSON settings bag stays owner-only,
  // but apps read this one column through the normal consent-checked table
  // read — see schema/enrich.ts's header.
  const now = nowIso();
  for (const domain of ["photos", "docs"] as const) {
    db.vault
      .prepare(
        `INSERT INTO enrich_policy (domain, tier, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (domain) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`
      )
      .run(domain, resolved[domain], now);
  }
  return resolved;
}

export interface EnrolledApp {
  appId: string;
  signingKey: string;
  /**
   * The host-side enrollment KEY (Centraid app id), never the pretty name: a
   * wide swath of the desktop renderer key-equates this to the app's slug. The
   * pretty name lives on `consent_app.display_name`, surfaced through
   * `ParkedSummary.caller`.
   */
  name: string;
  status: string;
  riskCeiling: Risk;
}

/**
 * A raw enrollment key turned into a readable fallback — the self-heal target
 * when no caller supplies a real name. A pure function of the key, so repeated
 * enrollment never oscillates.
 */
export function humanizeSlug(slug: string): string {
  const words = slug.split(/[-_]+/u).filter((w) => w.length > 0);
  if (words.length === 0) return slug;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export function lookupAppByName(
  db: VaultDb,
  name: string
): EnrolledApp | undefined {
  const row = db.vault
    .prepare(
      `SELECT app_id, name, signing_key, status, risk_ceiling FROM consent_app
        WHERE name = ? AND status = 'active' ORDER BY installed_at LIMIT 1`
    )
    .get(name) as
    | {
        app_id: string;
        name: string;
        signing_key: string;
        status: string;
        risk_ceiling: Risk;
      }
    | undefined;
  if (!row) return undefined;
  return {
    appId: row.app_id,
    signingKey: row.signing_key,
    name: row.name,
    status: row.status,
    riskCeiling: row.risk_ceiling,
  };
}

/**
 * Enroll an app under its host-side name, once. Re-registering an already
 * active app returns the existing row — enrollment survives restarts and
 * republishes without minting a second identity. `displayName` (the app's
 * manifest/pretty name, when the caller has it — else a humanized `name`)
 * self-heals onto `consent_app.display_name` whenever it has drifted, so
 * the Approvals surface (`ParkedSummary.caller`) never shows a raw slug
 * for long, without minting a second identity or disturbing the `name`
 * key every OTHER surface matches on.
 */
export function ensureAppEnrolled(
  db: VaultDb,
  name: string,
  options?: {
    origin?: "installed" | "generated";
    riskCeiling?: Risk;
    displayName?: string;
  }
): EnrolledApp & { created: boolean } {
  const resolvedDisplayName = options?.displayName ?? humanizeSlug(name);
  const existing = lookupAppByName(db, name);
  if (existing) {
    db.vault
      .prepare(
        `UPDATE consent_app SET display_name = ?
          WHERE app_id = ? AND (display_name IS NULL OR display_name != ?)`
      )
      .run(resolvedDisplayName, existing.appId, resolvedDisplayName);
    return { ...existing, created: false };
  }
  const enrolled = enrollApp(db, {
    name,
    origin: options?.origin ?? "generated",
    riskCeiling: options?.riskCeiling ?? "low",
    displayName: resolvedDisplayName,
  });
  return {
    appId: enrolled.appId,
    signingKey: enrolled.signingKey,
    name,
    status: "active",
    riskCeiling: options?.riskCeiling ?? "low",
    created: true,
  };
}

export interface GrantSummary {
  grantId: string;
  purposeConceptId: string;
  purpose: string | null;
  expiresAt: string | null;
  scopes: {
    schema: string;
    table: string | null;
    verbs: string;
    rowFilter?: FilterClause[];
    fieldMask?: string[];
  }[];
}

/** One query, two grantee planes: apps match on app_id, agents on their party. */
function grantSummariesBy(
  db: VaultDb,
  granteeColumn: "app_id" | "grantee_party_id",
  granteeId: string
): GrantSummary[] {
  const grants = db.vault
    .prepare(
      `SELECT g.grant_id, g.purpose_concept_id, g.expires_at, c.notation
         FROM consent_access_grant g
         LEFT JOIN core_concept c ON c.concept_id = g.purpose_concept_id
        WHERE g.${granteeColumn} = ? AND g.status = 'active' ORDER BY g.granted_at`
    )
    .all(granteeId) as {
    grant_id: string;
    purpose_concept_id: string;
    expires_at: string | null;
    notation: string | null;
  }[];
  const scopeStmt = db.vault.prepare(
    `SELECT schema_name, table_name, verbs, row_filter_json, field_mask_json
       FROM consent_grant_scope WHERE grant_id = ?`
  );
  return grants.map((g) => ({
    grantId: g.grant_id,
    purposeConceptId: g.purpose_concept_id,
    purpose: g.notation,
    expiresAt: g.expires_at,
    scopes: (
      scopeStmt.all(g.grant_id) as {
        schema_name: string;
        table_name: string | null;
        verbs: string;
        row_filter_json: string | null;
        field_mask_json: string | null;
      }[]
    ).map((s) => ({
      schema: s.schema_name,
      table: s.table_name,
      verbs: s.verbs,
      ...(s.row_filter_json
        ? { rowFilter: JSON.parse(s.row_filter_json) as FilterClause[] }
        : {}),
      ...(s.field_mask_json
        ? { fieldMask: JSON.parse(s.field_mask_json) as string[] }
        : {}),
    })),
  }));
}

export function listActiveGrants(db: VaultDb, appId: string): GrantSummary[] {
  return grantSummariesBy(db, "app_id", appId);
}

/** Same summary shape as `listActiveGrants` — the owner surface lists both. */
export function listActiveAgentGrants(
  db: VaultDb,
  partyId: string
): GrantSummary[] {
  return grantSummariesBy(db, "grantee_party_id", partyId);
}

export interface EnrolledAgent {
  agentId: string;
  partyId: string;
  name: string;
  status: string;
}

/**
 * Automations enroll under their Centraid app id; the assistant enrolls under
 * the literal `_assistant` key. The key lives on `consent_agent.enrollment_key`,
 * decoupled from `core_party.display_name` so a pretty name cannot break this.
 */
export function lookupAgentByName(
  db: VaultDb,
  name: string
): EnrolledAgent | undefined {
  const row = db.vault
    .prepare(
      `SELECT a.agent_id, a.party_id, p.display_name, a.status
         FROM consent_agent a JOIN core_party p ON p.party_id = a.party_id
        WHERE a.enrollment_key = ? AND p.kind = 'agent' AND a.status = 'active'
        ORDER BY a.enrolled_at LIMIT 1`
    )
    .get(name) as
    | {
        agent_id: string;
        party_id: string;
        display_name: string;
        status: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    agentId: row.agent_id,
    partyId: row.party_id,
    name: row.display_name,
    status: row.status,
  };
}

/**
 * Enroll an agent under a host-side key, once; re-enrolling an active key
 * returns the existing row. Identity ONLY — authority still requires an
 * owner-approved grant on the agent's party. `displayName` upserts onto
 * `core_party.display_name` when it differs, so a raw-key display self-heals
 * without minting a new identity (the key and every grant/receipt survive).
 */
export function ensureAgentEnrolled(
  db: VaultDb,
  name: string,
  options?: { modelRef?: string; version?: string; displayName?: string }
): EnrolledAgent & { created: boolean } {
  const resolvedName = options?.displayName ?? humanizeSlug(name);
  const existing = lookupAgentByName(db, name);
  if (existing) {
    // Two kinds of touch land here: a caller that KNOWS the manifest name
    // (`options.displayName` set) and one that does not. Only the former may
    // overwrite an existing name — a name-less touch must never regress an
    // already-set name back to a fresh `humanizeSlug` guess just because it
    // raced ahead of the caller that knew better. The one case a name-less
    // touch may still self-heal is the literal legacy raw slug
    // (`existing.name === name`), which upgrades to the humanized fallback.
    const mayOverwrite =
      options?.displayName !== undefined || existing.name === name;
    if (mayOverwrite && existing.name !== resolvedName) {
      db.vault
        .prepare(`UPDATE core_party SET display_name = ? WHERE party_id = ?`)
        .run(resolvedName, existing.partyId);
      return { ...existing, name: resolvedName, created: false };
    }
    return { ...existing, created: false };
  }
  const enrolled = enrollAgent(db, {
    name,
    modelRef: options?.modelRef ?? "centraid-automation",
    displayName: resolvedName,
    ...(options?.version ? { version: options.version } : {}),
  });
  return {
    agentId: enrolled.agentId,
    partyId: enrolled.partyId,
    name: resolvedName,
    status: "active",
    created: true,
  };
}

/**
 * Retire an agent's enrollment (uninstall). Grants MUST be revoked through the
 * gateway first so the cascade runs; this only pauses the identity row. The
 * party — and every receipt it left — remains.
 */
export function markAgentRevoked(db: VaultDb, agentId: string): void {
  db.vault
    .prepare(`UPDATE consent_agent SET status = 'revoked' WHERE agent_id = ?`)
    .run(agentId);
}

/** Key-free — safe to serialize onto an owner-facing surface. */
export interface AgentSummary {
  agentId: string;
  enrollmentKey: string;
  partyId: string;
  name: string;
  modelRef: string;
  enrolledAt: string;
}

export function listEnrolledAgents(db: VaultDb): AgentSummary[] {
  const rows = db.vault
    .prepare(
      `SELECT a.agent_id, a.enrollment_key, a.party_id, p.display_name, a.model_ref, a.enrolled_at
         FROM consent_agent a JOIN core_party p ON p.party_id = a.party_id
        WHERE a.status = 'active' ORDER BY a.enrolled_at`
    )
    .all() as {
    agent_id: string;
    enrollment_key: string;
    party_id: string;
    display_name: string;
    model_ref: string;
    enrolled_at: string;
  }[];
  return rows.map((r) => ({
    agentId: r.agent_id,
    enrollmentKey: r.enrollment_key,
    partyId: r.party_id,
    name: r.display_name,
    modelRef: r.model_ref,
    enrolledAt: r.enrolled_at,
  }));
}

export function purposeConceptId(
  db: VaultDb,
  notation: string
): string | undefined {
  const row = db.vault
    .prepare("SELECT concept_id FROM core_concept WHERE notation = ? LIMIT 1")
    .get(notation) as { concept_id: string } | undefined;
  return row?.concept_id;
}

/**
 * Mark an app's enrollment revoked (uninstall). Grants MUST be revoked through
 * the gateway first so the cascade runs; this only retires the identity row,
 * and a reinstall under the same name mints a fresh identity.
 */
export function markAppRevoked(db: VaultDb, appId: string): void {
  db.vault
    .prepare(`UPDATE consent_app SET status = 'revoked' WHERE app_id = ?`)
    .run(appId);
}

export interface InstalledAppRow {
  name: string;
  /** Owner's per-vault rename, or null — fall back to the manifest name. */
  label: string | null;
}

/**
 * Active apps enrolled with `origin = 'installed'` (#434) — only the
 * install-in-place path writes that origin, so this is exactly the git-free
 * install registry. Ordered by install time for a stable listing.
 */
export function listInstalledApps(db: VaultDb): InstalledAppRow[] {
  const rows = db.vault
    .prepare(
      `SELECT name, label FROM consent_app
        WHERE origin = 'installed' AND status = 'active' ORDER BY installed_at`
    )
    .all() as { name: string; label: string | null }[];
  return rows.map((r) => ({ name: r.name, label: r.label ?? null }));
}

/**
 * Set or clear an installed app's per-vault rename (#434), keyed by the active
 * enrollment's name; a no-op when the app is not enrolled. Blank coalesces to
 * NULL so "clear" and "rename to whitespace" both fall back to the manifest.
 */
export function setAppLabel(
  db: VaultDb,
  appId: string,
  label: string | null
): void {
  const trimmed = typeof label === "string" ? label.trim() : "";
  db.vault
    .prepare(
      `UPDATE consent_app SET label = ? WHERE name = ? AND status = 'active'`
    )
    .run(trimmed.length > 0 ? trimmed : null, appId);
}

/** Key-free — safe to serialize onto an owner-facing surface. */
export interface AppSummary {
  appId: string;
  name: string;
  status: string;
  origin: string;
  riskCeiling: Risk;
  installedAt: string;
}

/**
 * All active enrolled apps, without signing keys. `name` is the enrollment key
 * the desktop matches on — see `EnrolledApp.name`.
 */
export function listEnrolledApps(db: VaultDb): AppSummary[] {
  const rows = db.vault
    .prepare(
      `SELECT app_id, name, status, origin, risk_ceiling, installed_at
         FROM consent_app WHERE status = 'active' ORDER BY installed_at`
    )
    .all() as {
    app_id: string;
    name: string;
    status: string;
    origin: string;
    risk_ceiling: Risk;
    installed_at: string;
  }[];
  return rows.map((r) => ({
    appId: r.app_id,
    name: r.name,
    status: r.status,
    origin: r.origin,
    riskCeiling: r.risk_ceiling,
    installedAt: r.installed_at,
  }));
}
