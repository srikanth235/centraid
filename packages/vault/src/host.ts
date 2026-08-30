// governance: allow-repo-hygiene file-size-limit pre-existing debt; splitting is a separate cleanup, not bundled into a feature change
// Host-integration helpers (§12): run a vault across restarts without storing credentials. v0 identity is key-equality.

import { enrollAgent, enrollApp } from "./bootstrap.js";
import type { BootstrapResult } from "./bootstrap.js";
import type { VaultDb } from "./db.js";
import type { FilterClause, Risk } from "./gateway/types.js";
import { nowIso } from "./ids.js";

export interface HostBootstrap extends BootstrapResult {
  fresh: boolean;
}

/** Recover an existing vault. Absent `core_vault` is uninitialized — creation belongs to the founding gate. */
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
      // Full trust is an authority answer (#883), so the owner's recovery
      // device joins the device-kind row that carries it.
      `SELECT d.device_id AS device_id, d.public_key AS public_key
         FROM consent_device d
         JOIN share_authority a
           ON a.principal_kind = 'device' AND a.principal_id = d.device_id
          AND a.subject_type = 'core.vault' AND a.subject_id = ''
          AND a.revoked_at IS NULL AND a.decision = 'granted'
          AND a.verb = 'edit'
        WHERE d.owner_party_id = ? ORDER BY d.enrolled_at LIMIT 1`
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

/** Owner-facing presentation (#280) in `core_vault.settings_json` — not client localStorage. */
export interface VaultPresentation {
  color?: string;
  icon?: string;
  blurb?: string;
}

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

/** Personal vault (the default when unnamed). The marker is settings, not creation order — UUIDv7 "oldest" is the household vault. */
export function readVaultPersonal(db: VaultDb): boolean {
  return readVaultSettings(db).personal === true;
}

export function markVaultPersonal(db: VaultDb): void {
  const settings = readVaultSettings(db);
  settings.personal = true;
  db.vault
    .prepare("UPDATE core_vault SET settings_json = ?")
    .run(JSON.stringify(settings));
}

/** `null`/empty-string CLEARS a field. */
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

/** Patch `blob_store` / `media.location` into settings (#296). Credentials never live here. Re-read on every use — no reopen. */
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

/** Per-domain enrich (#299 §2 / #712 C5): `off` / `device` / `gateway` (model turns). Absent = `gateway`. */
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

/** Default `gateway` (Tier-0 stays in-trust). Third-party bytes are gated separately (#567), independently of this tier. */
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
  // Mirror into `enrich_policy` (#352): settings bag stays owner-only; apps read this column via consent-checked table read.
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
  /** Host-side enrollment key (Centraid app id), never the pretty name. Pretty name is `consent_app.display_name`. */
  name: string;
  status: string;
  riskCeiling: Risk;
}

/** Readable fallback from the enrollment key — pure, so re-enrollment never oscillates. */
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

/** Enroll once under the host-side name; re-register returns the existing row. `displayName` self-heals without minting a second identity. */
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

/** Automations enroll under Centraid app id; assistant under `_assistant`. Key is `consent_agent.enrollment_key`, not `display_name`. */
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

/** Enroll once under host-side key. Identity only — authority still needs an owner-approved grant. `displayName` self-heals without minting a new identity. */
export function ensureAgentEnrolled(
  db: VaultDb,
  name: string,
  options?: { modelRef?: string; version?: string; displayName?: string }
): EnrolledAgent & { created: boolean } {
  const resolvedName = options?.displayName ?? humanizeSlug(name);
  const existing = lookupAgentByName(db, name);
  if (existing) {
    // Only a caller that knows `displayName` may overwrite. Name-less must not regress to `humanizeSlug` except the legacy raw slug (`existing.name === name`).
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

/** Pause the identity row. Grants MUST be revoked through the gateway first so the cascade runs. */
export function markAgentRevoked(db: VaultDb, agentId: string): void {
  db.vault
    .prepare(`UPDATE consent_agent SET status = 'revoked' WHERE agent_id = ?`)
    .run(agentId);
}

/** Key-free — safe to serialize. */
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

/** Retire the identity row. Grants MUST be revoked through the gateway first. Reinstall under the same name mints a fresh identity. */
export function markAppRevoked(db: VaultDb, appId: string): void {
  db.vault
    .prepare(`UPDATE consent_app SET status = 'revoked' WHERE app_id = ?`)
    .run(appId);
}

export interface InstalledAppRow {
  name: string;
  /** Per-vault rename, or null (manifest name). */
  label: string | null;
}

/** `origin = 'installed'` (#434) — git-free install registry. */
export function listInstalledApps(db: VaultDb): InstalledAppRow[] {
  const rows = db.vault
    .prepare(
      `SELECT name, label FROM consent_app
        WHERE origin = 'installed' AND status = 'active' ORDER BY installed_at`
    )
    .all() as { name: string; label: string | null }[];
  return rows.map((r) => ({ name: r.name, label: r.label ?? null }));
}

/** Per-vault rename (#434). Blank → NULL (manifest fallback). No-op if not enrolled. */
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

/** Key-free — safe to serialize. */
export interface AppSummary {
  appId: string;
  name: string;
  status: string;
  origin: string;
  riskCeiling: Risk;
  installedAt: string;
}

/** Active enrolled apps, no signing keys. `name` is the enrollment key. */
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
