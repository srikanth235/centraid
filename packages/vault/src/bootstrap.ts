// Vault bootstrap + enrollment: the owner-administrative acts before the
// gateway can authenticate anyone (first device = chicken-and-egg).

import { randomBytes } from "node:crypto";

import type { VaultDb } from "./db.js";
import type { FilterClause, Risk } from "./gateway/types.js";
import { setDeviceTrust } from "./grant/device-trust.js";
import { nowIso, uuidv7 } from "./ids.js";

export interface BootstrapResult {
  vaultId: string;
  displayName: string;
  /**
   * The vault's SELF party (#916, ruling ONT-05): the person as DATA. It
   * confers no permission — authority is gateway-side (`vault_owners`) and in
   * `share_authority` — and the column it lands in is `core_vault.
   * self_party_id`. The field keeps its name because every caller in the
   * monorepo reads it as "whose vault is this", which is still true.
   */
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

const SEED_SCHEMES: Record<string, { uri: string; title: string }> = {
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
  // Machine-tag vocabularies (#299): concepts arrive on demand from the
  // enrichment publishers; pre-v10 vaults use the guarded v10 backfill.
  vision: { uri: "urn:centraid:vision", title: "Vision tags (machine)" },
  doctype: { uri: "urn:centraid:doctype", title: "Document types (machine)" },
};
const SEED_CONCEPTS: SeedConcept[] = [
  { scheme: "relations", notation: "same-as", label: "Same as" },
  { scheme: "relations", notation: "about", label: "About" },
  { scheme: "relations", notation: "works-for", label: "Works for" },
  { scheme: "relations", notation: "duplicate-of", label: "Duplicate of" },
  // Cross-referencing relations (#272), also seeded by migration: keep in
  // step.
  { scheme: "relations", notation: "references", label: "References" },
  { scheme: "relations", notation: "attachment-of", label: "Attachment of" },
  // Version lineage (#352): newer content revises older, asserted by the
  // document and note edit commands.
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
  /** Pre-minted id: multi-vault hosts name each vault's directory after it. */
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
      // No caller passes baseCurrency today, so this USD default IS the
      // currency every real vault displays; readers fall back to USD anyway.
      options.baseCurrency ?? "USD",
      now
    );
  // Enrichment-policy mirror (#352): `gateway` is the default on both domains,
  // same as the settings bag this table shadows. A third-party provider seeing
  // bytes stays gated separately per call and capability (#567).
  for (const domain of ["photos", "docs"] as const) {
    db.vault
      .prepare(
        `INSERT INTO enrich_policy (domain, tier, updated_at) VALUES (?, 'gateway', ?)`
      )
      .run(domain, now);
  }
  // Events require a calendar (schedule.propose_event precondition) but no
  // command mints one — seed a private "Personal" calendar so schedule works
  // from first boot.
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
  // Identity here, authority next door: `access_device` says who the device
  // is, `share_authority` what the member let it do (#883).
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
      // `origin` is a one-value vocabulary (#916, ruling ONT-07): an app
      // reaches a vault by being installed, and has had no other door
      // since #799.
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
