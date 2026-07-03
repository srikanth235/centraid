// Host-integration helpers (§12): what an embedding process — the Centraid
// gateway — needs to run a vault across restarts without keeping credential
// state of its own. Identity is v0 key-equality, so the host (which owns the
// database files) recovers credentials by reading the enrolled rows back.

import type { VaultDb } from './db.js';
import {
  bootstrapVault,
  enrollAgent,
  enrollApp,
  type BootstrapResult,
  type BootstrapVaultOptions,
} from './bootstrap.js';
import type { Risk } from './gateway/types.js';

export interface HostBootstrap extends BootstrapResult {
  /** true when this call created the vault; false when it recovered one. */
  fresh: boolean;
}

/**
 * Bootstrap the vault on first boot, recover it on every later boot.
 * Recovery re-derives the owner credential from the oldest full-trust
 * owner device and rebuilds the seeded-concept map from the model.
 */
export function ensureVaultBootstrapped(
  db: VaultDb,
  options: BootstrapVaultOptions,
): HostBootstrap {
  const vaultRow = db.vault
    .prepare('SELECT vault_id, owner_party_id, display_name FROM core_vault LIMIT 1')
    .get() as { vault_id: string; owner_party_id: string; display_name: string } | undefined;
  if (!vaultRow) return { ...bootstrapVault(db, options), fresh: true };

  const device = db.vault
    .prepare(
      `SELECT device_id, public_key FROM consent_device
        WHERE owner_party_id = ? AND trust = 'full' ORDER BY enrolled_at LIMIT 1`,
    )
    .get(vaultRow.owner_party_id) as { device_id: string; public_key: string } | undefined;
  if (!device) {
    throw new Error('vault exists but has no full-trust owner device to recover');
  }
  const concepts: Record<string, string> = {};
  const rows = db.vault
    .prepare('SELECT notation, concept_id FROM core_concept ORDER BY concept_id')
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

/** Rename the vault (owner act on `core_vault.display_name`). */
export function renameVault(db: VaultDb, displayName: string): void {
  db.vault.prepare('UPDATE core_vault SET display_name = ?').run(displayName);
}

export interface EnrolledApp {
  appId: string;
  signingKey: string;
  name: string;
  status: string;
  riskCeiling: Risk;
}

/** Find an active enrolled app by its host-side name (the Centraid app id). */
export function lookupAppByName(db: VaultDb, name: string): EnrolledApp | undefined {
  const row = db.vault
    .prepare(
      `SELECT app_id, name, signing_key, status, risk_ceiling FROM consent_app
        WHERE name = ? AND status = 'active' ORDER BY installed_at LIMIT 1`,
    )
    .get(name) as
    | { app_id: string; name: string; signing_key: string; status: string; risk_ceiling: Risk }
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
 * republishes without minting a second identity.
 */
export function ensureAppEnrolled(
  db: VaultDb,
  name: string,
  options?: { origin?: 'installed' | 'generated'; riskCeiling?: Risk },
): EnrolledApp & { created: boolean } {
  const existing = lookupAppByName(db, name);
  if (existing) return { ...existing, created: false };
  const enrolled = enrollApp(db, {
    name,
    origin: options?.origin ?? 'generated',
    riskCeiling: options?.riskCeiling ?? 'low',
  });
  return {
    appId: enrolled.appId,
    signingKey: enrolled.signingKey,
    name,
    status: 'active',
    riskCeiling: options?.riskCeiling ?? 'low',
    created: true,
  };
}

export interface GrantSummary {
  grantId: string;
  purposeConceptId: string;
  purpose: string | null;
  expiresAt: string | null;
  scopes: { schema: string; table: string | null; verbs: string }[];
}

/** One query, two grantee planes: apps match on app_id, agents on their party. */
function grantSummariesBy(
  db: VaultDb,
  granteeColumn: 'app_id' | 'grantee_party_id',
  granteeId: string,
): GrantSummary[] {
  const grants = db.vault
    .prepare(
      `SELECT g.grant_id, g.purpose_concept_id, g.expires_at, c.notation
         FROM consent_access_grant g
         LEFT JOIN core_concept c ON c.concept_id = g.purpose_concept_id
        WHERE g.${granteeColumn} = ? AND g.status = 'active' ORDER BY g.granted_at`,
    )
    .all(granteeId) as {
    grant_id: string;
    purpose_concept_id: string;
    expires_at: string | null;
    notation: string | null;
  }[];
  const scopeStmt = db.vault.prepare(
    `SELECT schema_name, table_name, verbs FROM consent_grant_scope WHERE grant_id = ?`,
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
      }[]
    ).map((s) => ({ schema: s.schema_name, table: s.table_name, verbs: s.verbs })),
  }));
}

/** Active grants held by an app, with their scopes — the consent surface a host lists. */
export function listActiveGrants(db: VaultDb, appId: string): GrantSummary[] {
  return grantSummariesBy(db, 'app_id', appId);
}

/**
 * Active grants held by a party (an enrolled agent's grantee side). Same
 * summary shape as `listActiveGrants` — the owner surface lists both.
 */
export function listActiveAgentGrants(db: VaultDb, partyId: string): GrantSummary[] {
  return grantSummariesBy(db, 'grantee_party_id', partyId);
}

export interface EnrolledAgent {
  agentId: string;
  partyId: string;
  name: string;
  status: string;
}

/**
 * Find an active enrolled agent by its host-side name. Automations enroll
 * under their Centraid app id, the same way `lookupAppByName` keys apps —
 * the agent's `core.party` (kind=agent) carries the name.
 */
export function lookupAgentByName(db: VaultDb, name: string): EnrolledAgent | undefined {
  const row = db.vault
    .prepare(
      `SELECT a.agent_id, a.party_id, p.display_name, a.status
         FROM agent_agent a JOIN core_party p ON p.party_id = a.party_id
        WHERE p.display_name = ? AND p.kind = 'agent' AND a.status = 'active'
        ORDER BY a.enrolled_at LIMIT 1`,
    )
    .get(name) as
    | { agent_id: string; party_id: string; display_name: string; status: string }
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
 * Enroll an agent under a host-side name, once (duaility §12: "the
 * conversation runner and automation fires act as an enrolled agent.agent").
 * Re-enrolling an active name returns the existing row. Identity only —
 * authority still requires an owner-approved grant on the agent's party.
 */
export function ensureAgentEnrolled(
  db: VaultDb,
  name: string,
  options?: { modelRef?: string; version?: string },
): EnrolledAgent & { created: boolean } {
  const existing = lookupAgentByName(db, name);
  if (existing) return { ...existing, created: false };
  const enrolled = enrollAgent(db, {
    name,
    modelRef: options?.modelRef ?? 'centraid-automation',
    ...(options?.version ? { version: options.version } : {}),
  });
  return {
    agentId: enrolled.agentId,
    partyId: enrolled.partyId,
    name,
    status: 'active',
    created: true,
  };
}

/**
 * Retire an agent's enrollment (uninstall). Grants must be revoked through
 * the gateway first so the cascade runs; this only pauses the identity row.
 * The agent's party — and every receipt it left — remains.
 */
export function markAgentRevoked(db: VaultDb, agentId: string): void {
  db.vault.prepare(`UPDATE agent_agent SET status = 'revoked' WHERE agent_id = ?`).run(agentId);
}

/** Key-free agent summary — safe to serialize onto an owner-facing surface. */
export interface AgentSummary {
  agentId: string;
  partyId: string;
  name: string;
  modelRef: string;
  enrolledAt: string;
}

/** All active enrolled agents. */
export function listEnrolledAgents(db: VaultDb): AgentSummary[] {
  const rows = db.vault
    .prepare(
      `SELECT a.agent_id, a.party_id, p.display_name, a.model_ref, a.enrolled_at
         FROM agent_agent a JOIN core_party p ON p.party_id = a.party_id
        WHERE a.status = 'active' ORDER BY a.enrolled_at`,
    )
    .all() as {
    agent_id: string;
    party_id: string;
    display_name: string;
    model_ref: string;
    enrolled_at: string;
  }[];
  return rows.map((r) => ({
    agentId: r.agent_id,
    partyId: r.party_id,
    name: r.display_name,
    modelRef: r.model_ref,
    enrolledAt: r.enrolled_at,
  }));
}

/** Resolve a purpose notation (e.g. `dpv:ServiceProvision`) to its concept id. */
export function purposeConceptId(db: VaultDb, notation: string): string | undefined {
  const row = db.vault
    .prepare('SELECT concept_id FROM core_concept WHERE notation = ? LIMIT 1')
    .get(notation) as { concept_id: string } | undefined;
  return row?.concept_id;
}

/**
 * Mark an app's enrollment revoked (uninstall). Grants must be revoked
 * through the gateway first so the cascade runs; this only retires the
 * identity row. A reinstall under the same name mints a fresh identity.
 */
export function markAppRevoked(db: VaultDb, appId: string): void {
  db.vault.prepare(`UPDATE consent_app SET status = 'revoked' WHERE app_id = ?`).run(appId);
}

/** Key-free app summary — safe to serialize onto an owner-facing surface. */
export interface AppSummary {
  appId: string;
  name: string;
  status: string;
  origin: string;
  riskCeiling: Risk;
  installedAt: string;
}

/** All active enrolled apps, without their signing keys. */
export function listEnrolledApps(db: VaultDb): AppSummary[] {
  const rows = db.vault
    .prepare(
      `SELECT app_id, name, status, origin, risk_ceiling, installed_at
         FROM consent_app WHERE status = 'active' ORDER BY installed_at`,
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
