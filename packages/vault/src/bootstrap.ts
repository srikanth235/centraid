import { randomBytes } from "node:crypto";

import type { VaultDb } from "./db.js";
import type { FilterClause, Risk } from "./gateway/types.js";
import { setDeviceTrust } from "./grant/device-trust.js";
import { nowIso, uuidv7 } from "./ids.js";

export interface BootstrapResult {
  vaultId: string;
  displayName: string;
  ownerPartyId: string;
  deviceId: string;
  deviceKey: string;
  concepts: Record<string, string>;
}

interface SeedConcept {
  scheme: string;
  notation: string;
  label: string;
}

const SEED_SCHEMES: Record<string, { uri: string; title: string }> = {
  purposes: {
    uri: "https://w3id.org/dpv#Purpose",
    title: "Consent purposes (DPV)",
  },
  relations: { uri: "urn:duaility:relations", title: "Link relation types" },
  "activity-kinds": {
    uri: "urn:duaility:activity-kinds",
    title: "Activity kinds",
  },
  "spend-categories": {
    uri: "urn:duaility:spend-categories",
    title: "Spend categories",
  },
  flags: { uri: "urn:duaility:flags", title: "Agent flags" },
  vision: { uri: "urn:centraid:vision", title: "Vision tags (machine)" },
  doctype: { uri: "urn:centraid:doctype", title: "Document types (machine)" },
};
const SEED_CONCEPTS: SeedConcept[] = [
  {
    scheme: "purposes",
    notation: "dpv:ServiceProvision",
    label: "Service provision",
  },
  { scheme: "purposes", notation: "dpv:Billing", label: "Billing" },
  {
    scheme: "purposes",
    notation: "dpv:HealthMonitoring",
    label: "Health monitoring",
  },
  { scheme: "relations", notation: "same-as", label: "Same as" },
  { scheme: "relations", notation: "about", label: "About" },
  { scheme: "relations", notation: "works-for", label: "Works for" },
  { scheme: "relations", notation: "duplicate-of", label: "Duplicate of" },
  { scheme: "relations", notation: "references", label: "References" },
  { scheme: "relations", notation: "attachment-of", label: "Attachment of" },
  { scheme: "relations", notation: "revises", label: "Revises" },
  { scheme: "activity-kinds", notation: "meeting", label: "Meeting" },
  { scheme: "activity-kinds", notation: "run", label: "Run" },
  { scheme: "activity-kinds", notation: "sleep", label: "Sleep" },
  { scheme: "activity-kinds", notation: "work", label: "Work session" },
  { scheme: "spend-categories", notation: "groceries", label: "Groceries" },
  { scheme: "spend-categories", notation: "dining", label: "Dining out" },
  { scheme: "spend-categories", notation: "transport", label: "Transport" },
  { scheme: "spend-categories", notation: "gifts", label: "Gifts" },
  { scheme: "flags", notation: "anomaly", label: "Anomaly" },
];

export interface BootstrapVaultOptions {
  ownerName: string;
  baseCurrency?: string;
  deviceName?: string;
  vaultId?: string;
  vaultName?: string;
  defaultTz?: string;
}

export function bootstrapVault(
  db: VaultDb,
  options: BootstrapVaultOptions
): BootstrapResult {
  const now = nowIso();
  const concepts: Record<string, string> = {};
  const schemeIds: Record<string, string> = {};
  for (const [key, scheme] of Object.entries(SEED_SCHEMES)) {
    const schemeId = uuidv7();
    schemeIds[key] = schemeId;
    db.vault
      .prepare(
        `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version) VALUES (?, ?, ?, 'duaility', '1')`
      )
      .run(schemeId, scheme.uri, scheme.title);
  }
  for (const seed of SEED_CONCEPTS) {
    const conceptId = uuidv7();
    concepts[seed.notation] = conceptId;
    db.vault
      .prepare(
        `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL)`
      )
      .run(conceptId, schemeIds[seed.scheme] ?? "", seed.notation, seed.label);
  }
  const ownerPartyId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at)
       VALUES (?, 'person', ?, NULL, NULL, NULL, ?, ?)`
    )
    .run(ownerPartyId, options.ownerName, now, now);
  const vaultId = options.vaultId ?? uuidv7();
  const displayName = options.vaultName ?? `${options.ownerName}'s vault`;
  db.vault
    .prepare(
      `INSERT INTO core_vault (vault_id, self_party_id, display_name, status, base_currency, settings_json, created_at)
       VALUES (?, ?, ?, 'active', ?, '{}', ?)`
    )
    .run(
      vaultId,
      ownerPartyId,
      displayName,
      options.baseCurrency ?? "USD",
      now
    );
  for (const domain of ["photos", "docs"] as const) {
    db.vault
      .prepare(
        `INSERT INTO enrich_policy (domain, tier, updated_at) VALUES (?, 'gateway', ?)`
      )
      .run(domain, now);
  }
  db.vault
    .prepare(
      `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, color, default_tz, visibility, external_uri)
       VALUES (?, ?, 'Personal', NULL, ?, 'private', NULL)`
    )
    .run(uuidv7(), ownerPartyId, options.defaultTz ?? "UTC");
  const device = enrollDevice(
    db,
    ownerPartyId,
    options.deviceName ?? "first device"
  );
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
  trust: "full" | "readonly" = "full"
): { deviceId: string; deviceKey: string } {
  const deviceId = uuidv7();
  const deviceKey = randomBytes(32).toString("hex");
  const now = nowIso();
  db.vault
    .prepare(
      `INSERT INTO access_device (device_id, owner_party_id, name, platform, public_key, enrolled_at, last_seen_at, sync_cursor)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL)`
    )
    .run(deviceId, ownerPartyId, name, deviceKey, now);
  setDeviceTrust(db.vault, { deviceId, ownerPartyId, trust, now });
  return { deviceId, deviceKey };
}

export function enrollApp(
  db: VaultDb,
  options: {
    name: string;
    riskCeiling?: Risk;
    displayName?: string;
  }
): { appId: string; signingKey: string } {
  const appId = uuidv7();
  const signingKey = randomBytes(32).toString("hex");
  db.vault
    .prepare(
      `INSERT INTO access_app (app_id, name, display_name, publisher, manifest_uri, signing_key, status, origin, risk_ceiling, installed_at)
       VALUES (?, ?, ?, NULL, NULL, ?, 'active', 'installed', ?, ?)`
    )
    .run(
      appId,
      options.name,
      options.displayName ?? null,
      signingKey,
      options.riskCeiling ?? "low",
      nowIso()
    );
  return { appId, signingKey };
}

export function enrollAgent(
  db: VaultDb,
  options: {
    name: string;
    modelRef: string;
    version?: string;
    displayName?: string;
  }
): { agentId: string; partyId: string } {
  const now = nowIso();
  const partyId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at)
       VALUES (?, 'agent', ?, NULL, NULL, NULL, ?, ?)`
    )
    .run(partyId, options.displayName ?? options.name, now, now);
  const agentId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO access_agent (agent_id, party_id, enrollment_key, model_ref, version, enrolled_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    )
    .run(
      agentId,
      partyId,
      options.name,
      options.modelRef,
      options.version ?? "0",
      now
    );
  return { agentId, partyId };
}

export interface ScopeSpec {
  schema: string;
  table?: string;
  verbs: "read" | "read+act" | "act" | "reveal";
  rowFilter?: FilterClause[];
  fieldMask?: string[];
}

export function createGrant(
  db: VaultDb,
  options: {
    appId?: string;
    granteePartyId?: string;
    purposeConceptId: string;
    grantedByPartyId: string;
    scopes: ScopeSpec[];
    expiresAt?: string;
  }
): string {
  const grantId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO access_grant
         (grant_id, app_id, grantee_party_id, purpose_concept_id, granted_by_party_id, granted_at, expires_at, revoked_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active')`
    )
    .run(
      grantId,
      options.appId ?? null,
      options.granteePartyId ?? null,
      options.purposeConceptId,
      options.grantedByPartyId,
      nowIso(),
      options.expiresAt ?? null
    );
  const stmt = db.vault.prepare(
    `INSERT INTO access_grant_scope (scope_id, grant_id, entity, verbs, row_filter_json, field_mask_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const scope of options.scopes) {
    stmt.run(
      uuidv7(),
      grantId,
      scope.table === undefined
        ? scope.schema
        : `${scope.schema}.${scope.table}`,
      scope.verbs,
      scope.rowFilter ? JSON.stringify(scope.rowFilter) : null,
      scope.fieldMask ? JSON.stringify(scope.fieldMask) : null
    );
  }
  return grantId;
}
