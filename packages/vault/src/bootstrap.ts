// Vault bootstrap + enrollment helpers. These are the owner-administrative
// acts that must exist before the gateway can authenticate anyone (the first
// device is the chicken-and-egg). In a full system enrollment and granting
// graduate to typed commands themselves; the rows they write are identical.

import { randomBytes } from 'node:crypto';
import type { VaultDb } from './db.js';
import { nowIso, uuidv7 } from './ids.js';
import { ONTOLOGY_VERSION } from './schema/migrate.js';
import type { FilterClause, Risk } from './gateway/types.js';

export interface BootstrapResult {
  vaultId: string;
  /** The vault's owner-facing name (`core_vault.display_name`). */
  displayName: string;
  ownerPartyId: string;
  deviceId: string;
  /** The first device's key — the owner's credential. */
  deviceKey: string;
  concepts: Record<string, string>;
}

interface SeedConcept {
  scheme: string;
  notation: string;
  label: string;
}

// SKOS seed vocabulary: DPV purposes, PROV/SKOS relations, AS2 activity kinds.
const SEED_SCHEMES: Record<string, { uri: string; title: string }> = {
  purposes: { uri: 'https://w3id.org/dpv#Purpose', title: 'Consent purposes (DPV)' },
  relations: { uri: 'urn:duaility:relations', title: 'Link relation types' },
  'activity-kinds': { uri: 'urn:duaility:activity-kinds', title: 'Activity kinds' },
  'spend-categories': { uri: 'urn:duaility:spend-categories', title: 'Spend categories' },
  flags: { uri: 'urn:duaility:flags', title: 'Agent flags' },
  // Machine-tag vocabularies (issue #299) — concepts arrive on demand from
  // the enrichment publishers; only the scheme rows seed. Pre-v10 vaults
  // get these from the guarded v10 backfill instead.
  vision: { uri: 'urn:centraid:vision', title: 'Vision tags (machine)' },
  doctype: { uri: 'urn:centraid:doctype', title: 'Document types (machine)' },
};
const SEED_CONCEPTS: SeedConcept[] = [
  { scheme: 'purposes', notation: 'dpv:ServiceProvision', label: 'Service provision' },
  { scheme: 'purposes', notation: 'dpv:Billing', label: 'Billing' },
  { scheme: 'purposes', notation: 'dpv:HealthMonitoring', label: 'Health monitoring' },
  { scheme: 'relations', notation: 'same-as', label: 'Same as' },
  { scheme: 'relations', notation: 'about', label: 'About' },
  { scheme: 'relations', notation: 'works-for', label: 'Works for' },
  { scheme: 'relations', notation: 'duplicate-of', label: 'Duplicate of' },
  // Cross-referencing relations (issue #272) — also seeded into existing
  // vaults by the v3 migration, which must stay in step with these two.
  { scheme: 'relations', notation: 'references', label: 'References' },
  { scheme: 'relations', notation: 'attachment-of', label: 'Attachment of' },
  // Version lineage (issue #352): a newer content item revises an older one —
  // core.edit_document, core.replace_document_content,
  // core.restore_document_version, and knowledge.edit_note all assert it.
  { scheme: 'relations', notation: 'revises', label: 'Revises' },
  { scheme: 'activity-kinds', notation: 'meeting', label: 'Meeting' },
  { scheme: 'activity-kinds', notation: 'run', label: 'Run' },
  { scheme: 'activity-kinds', notation: 'sleep', label: 'Sleep' },
  { scheme: 'activity-kinds', notation: 'work', label: 'Work session' },
  { scheme: 'spend-categories', notation: 'groceries', label: 'Groceries' },
  { scheme: 'spend-categories', notation: 'dining', label: 'Dining out' },
  { scheme: 'spend-categories', notation: 'transport', label: 'Transport' },
  { scheme: 'spend-categories', notation: 'gifts', label: 'Gifts' },
  { scheme: 'flags', notation: 'anomaly', label: 'Anomaly' },
];

export interface BootstrapVaultOptions {
  ownerName: string;
  baseCurrency?: string;
  deviceName?: string;
  /**
   * Pre-minted vault id. A multi-vault host names each vault's directory
   * after its id, so the id must exist before the files do.
   */
  vaultId?: string;
  /** Owner-facing vault name. Default: `<ownerName>'s vault`. */
  vaultName?: string;
  /** IANA tz for the minted default "Personal" calendar. Default: UTC. */
  defaultTz?: string;
}

/** Create the vault row, owner party, seed vocabulary and first device. */
export function bootstrapVault(db: VaultDb, options: BootstrapVaultOptions): BootstrapResult {
  const now = nowIso();
  const concepts: Record<string, string> = {};
  const schemeIds: Record<string, string> = {};
  for (const [key, scheme] of Object.entries(SEED_SCHEMES)) {
    const schemeId = uuidv7();
    schemeIds[key] = schemeId;
    db.vault
      .prepare(
        `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version) VALUES (?, ?, ?, 'duaility', '1')`,
      )
      .run(schemeId, scheme.uri, scheme.title);
  }
  for (const seed of SEED_CONCEPTS) {
    const conceptId = uuidv7();
    concepts[seed.notation] = conceptId;
    db.vault
      .prepare(
        `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(conceptId, schemeIds[seed.scheme] ?? '', seed.notation, seed.label);
  }
  const ownerPartyId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, 'person', ?, NULL, NULL, NULL, ?, ?, ?)`,
    )
    .run(ownerPartyId, options.ownerName, now, now, ONTOLOGY_VERSION);
  const vaultId = options.vaultId ?? uuidv7();
  const displayName = options.vaultName ?? `${options.ownerName}'s vault`;
  db.vault
    .prepare(
      `INSERT INTO core_vault (vault_id, owner_party_id, display_name, status, base_currency, settings_json, created_at)
       VALUES (?, ?, ?, 'active', ?, '{}', ?)`,
    )
    .run(vaultId, ownerPartyId, displayName, options.baseCurrency ?? 'INR', now);
  // The enrichment-policy mirror (issue #352 phase 3/4, host.ts
  // readEnrichSettings/updateEnrichSettings): `local` is the default on both
  // domains, same as the settings-bag default this table shadows.
  for (const domain of ['photos', 'docs'] as const) {
    db.vault
      .prepare(`INSERT INTO enrich_policy (domain, tier, updated_at) VALUES (?, 'local', ?)`)
      .run(domain, now);
  }
  // Events require a calendar (schedule.propose_event's calendar_exists
  // precondition) but no vault command creates one — without a minted
  // default, a fresh vault can never hold a single event and Agenda's
  // propose flow is a permanent dead end. One private "Personal" calendar
  // makes the schedule domain usable from first boot, same spirit as the
  // owner party row above.
  db.vault
    .prepare(
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, color, default_tz, visibility, external_uri)
       VALUES (?, ?, 'Personal', NULL, ?, 'private', NULL)`,
    )
    .run(uuidv7(), ownerPartyId, options.defaultTz ?? 'UTC');
  // §03/§07: condition is the highest-sensitivity table — excluded from
  // default grant scopes. A minimization policy makes schema-wide scopes skip
  // it; only a scope naming the table explicitly covers it.
  db.vault
    .prepare(
      `INSERT INTO consent_policy (policy_id, kind, applies_schema, applies_table, rule_json, retention_days, residency_region, effective_from, priority)
       VALUES (?, 'minimization', 'health', 'condition', '{"require_explicit_scope":true}', NULL, NULL, ?, 1)`,
    )
    .run(uuidv7(), now);
  const device = enrollDevice(db, ownerPartyId, options.deviceName ?? 'first device');
  return {
    vaultId,
    displayName,
    ownerPartyId,
    deviceId: device.deviceId,
    deviceKey: device.deviceKey,
    concepts,
  };
}

export function enrollDevice(
  db: VaultDb,
  ownerPartyId: string,
  name: string,
  trust: 'full' | 'readonly' = 'full',
): { deviceId: string; deviceKey: string } {
  const deviceId = uuidv7();
  const deviceKey = randomBytes(32).toString('hex');
  db.vault
    .prepare(
      `INSERT INTO consent_device (device_id, owner_party_id, name, platform, public_key, trust, enrolled_at, last_seen_at, sync_cursor)
       VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, NULL)`,
    )
    .run(deviceId, ownerPartyId, name, deviceKey, trust, nowIso());
  return { deviceId, deviceKey };
}

export function enrollApp(
  db: VaultDb,
  options: {
    name: string;
    origin?: 'installed' | 'generated';
    riskCeiling?: Risk;
    displayName?: string;
  },
): { appId: string; signingKey: string } {
  const appId = uuidv7();
  const signingKey = randomBytes(32).toString('hex');
  db.vault
    .prepare(
      `INSERT INTO consent_app (app_id, name, display_name, publisher, manifest_uri, signing_key, status, origin, risk_ceiling, installed_at)
       VALUES (?, ?, ?, NULL, NULL, ?, 'active', ?, ?, ?)`,
    )
    .run(
      appId,
      options.name,
      options.displayName ?? null,
      signingKey,
      options.origin ?? 'installed',
      options.riskCeiling ?? 'low',
      nowIso(),
    );
  return { appId, signingKey };
}

export function enrollAgent(
  db: VaultDb,
  options: { name: string; modelRef: string; version?: string; displayName?: string },
): { agentId: string; partyId: string } {
  const now = nowIso();
  const partyId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, 'agent', ?, NULL, NULL, NULL, ?, ?, ?)`,
    )
    .run(partyId, options.displayName ?? options.name, now, now, ONTOLOGY_VERSION);
  const agentId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO agent_agent (agent_id, party_id, host_key, model_ref, version, enrolled_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    )
    .run(agentId, partyId, options.name, options.modelRef, options.version ?? '0', now);
  return { agentId, partyId };
}

export interface ScopeSpec {
  schema: string;
  table?: string;
  verbs: 'read' | 'read+act' | 'act' | 'reveal';
  rowFilter?: FilterClause[];
  fieldMask?: string[];
}

/** One consent decision: this grantee, this purpose, until this expiry. */
export function createGrant(
  db: VaultDb,
  options: {
    appId?: string;
    granteePartyId?: string;
    purposeConceptId: string;
    grantedByPartyId: string;
    scopes: ScopeSpec[];
    expiresAt?: string;
  },
): string {
  const grantId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO consent_access_grant
         (grant_id, app_id, grantee_party_id, purpose_concept_id, granted_by_party_id, granted_at, expires_at, revoked_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active')`,
    )
    .run(
      grantId,
      options.appId ?? null,
      options.granteePartyId ?? null,
      options.purposeConceptId,
      options.grantedByPartyId,
      nowIso(),
      options.expiresAt ?? null,
    );
  const stmt = db.vault.prepare(
    `INSERT INTO consent_grant_scope (scope_id, grant_id, schema_name, table_name, verbs, row_filter_json, field_mask_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const scope of options.scopes) {
    stmt.run(
      uuidv7(),
      grantId,
      scope.schema,
      scope.table ?? null,
      scope.verbs,
      scope.rowFilter ? JSON.stringify(scope.rowFilter) : null,
      scope.fieldMask ? JSON.stringify(scope.fieldMask) : null,
    );
  }
  return grantId;
}
