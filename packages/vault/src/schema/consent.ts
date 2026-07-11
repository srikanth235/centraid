// Consent plane DDL — schema `consent` from duaility-ontology.html §03.
// Only the *model* half lives in vault.db; the append-only audit stream
// (consent.receipt, consent.provenance) lives in journal.db — see journal.ts.

export const CONSENT_DDL = `
CREATE TABLE consent_app (
  app_id       TEXT PRIMARY KEY,
  -- The host-side enrollment key (Centraid app id) — lookup identity,
  -- never shown to the owner directly. display_name (nullable, falls
  -- back to a humanized name — see host.ts) is what an approval/consent
  -- surface renders (issue: parked-invocation trust legibility).
  name         TEXT NOT NULL,
  display_name TEXT,
  publisher    TEXT,
  manifest_uri TEXT,
  signing_key  TEXT UNIQUE,
  status       TEXT NOT NULL CHECK (status IN ('active','suspended','revoked')),
  origin       TEXT NOT NULL CHECK (origin IN ('installed','generated')),
  risk_ceiling TEXT NOT NULL CHECK (risk_ceiling IN ('low','medium','high')),
  installed_at TEXT NOT NULL
) STRICT;

CREATE TABLE consent_app_view (
  view_id         TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL REFERENCES consent_app(app_id),
  name            TEXT NOT NULL,
  base_entity     TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  materialized    INTEGER NOT NULL CHECK (materialized IN (0,1)),
  refreshed_at    TEXT,
  created_at      TEXT NOT NULL,
  revoked_at      TEXT,
  UNIQUE (app_id, name)
) STRICT;

CREATE TABLE consent_access_grant (
  grant_id            TEXT PRIMARY KEY,
  app_id              TEXT REFERENCES consent_app(app_id),
  grantee_party_id    TEXT REFERENCES core_party(party_id),
  purpose_concept_id  TEXT NOT NULL REFERENCES core_concept(concept_id),
  granted_by_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  granted_at          TEXT NOT NULL,
  expires_at          TEXT,
  revoked_at          TEXT,
  status              TEXT NOT NULL CHECK (status IN ('active','expired','revoked'))
) STRICT;

CREATE TABLE consent_grant_scope (
  scope_id        TEXT PRIMARY KEY,
  grant_id        TEXT NOT NULL REFERENCES consent_access_grant(grant_id),
  schema_name     TEXT NOT NULL,
  table_name      TEXT,
  verbs           TEXT NOT NULL CHECK (verbs IN ('read','read+act','act','reveal')),
  row_filter_json TEXT CHECK (row_filter_json IS NULL OR json_valid(row_filter_json)),
  field_mask_json TEXT CHECK (field_mask_json IS NULL OR json_valid(field_mask_json))
) STRICT;

CREATE TABLE consent_share (
  share_id            TEXT PRIMARY KEY,
  owner_party_id      TEXT NOT NULL REFERENCES core_party(party_id),
  audience            TEXT NOT NULL CHECK (audience IN ('party','circle','public_link')),
  recipient_party_id  TEXT REFERENCES core_party(party_id),
  recipient_circle_id TEXT REFERENCES social_circle(circle_id),
  target_type         TEXT NOT NULL,
  target_id           TEXT NOT NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('view','comment','edit')),
  created_at          TEXT NOT NULL,
  expires_at          TEXT,
  revoked_at          TEXT
) STRICT;

CREATE TABLE consent_policy (
  policy_id        TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('retention','residency','purpose','minimization')),
  applies_schema   TEXT NOT NULL,
  applies_table    TEXT,
  rule_json        TEXT NOT NULL CHECK (json_valid(rule_json)),
  retention_days   INTEGER CHECK (retention_days > 0),
  residency_region TEXT,
  effective_from   TEXT NOT NULL,
  priority         INTEGER NOT NULL
) STRICT;

CREATE TABLE consent_device (
  device_id      TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  platform       TEXT,
  public_key     TEXT NOT NULL UNIQUE,
  trust          TEXT NOT NULL CHECK (trust IN ('full','readonly','revoked')),
  enrolled_at    TEXT NOT NULL,
  last_seen_at   TEXT,
  sync_cursor    TEXT
) STRICT;

CREATE TABLE consent_export_job (
  export_id             TEXT PRIMARY KEY,
  requested_by_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  scope_json            TEXT NOT NULL CHECK (json_valid(scope_json)),
  format                TEXT NOT NULL CHECK (format IN ('sqlite','jsonld','tar')),
  requested_at          TEXT NOT NULL,
  completed_at          TEXT,
  artifact_content_id   TEXT REFERENCES core_content_item(content_id),
  verify_hash           TEXT
) STRICT;
`;

// v14 (issue #308 A3/A4): consent memory for the install-grant top-up.
//
// `consent_scope_tombstone` — the owner's "no", made durable. #306's top-up
// diffed declared scopes against ACTIVE grants only, so an owner-revoked
// scope was silently re-minted on the next mount/sync/publish. A revocation
// now writes one tombstone per scope triple; the top-up (and the widening
// request below) skip tombstoned triples, and only an explicit owner
// re-approval clears them. Uninstall clears the app's tombstones — a
// reinstall is a fresh consent.
//
// `consent_scope_request` — a manifest that widens BEYOND the last owner
// consent parks here as a blocking item instead of auto-granting: agents
// author their own manifests, so "install was the consent" must not be
// bypassable by the very actor consent contains. One open request per
// (plane, app); re-publishes replace the open request's scope set.
export const CONSENT_INSTALL_MEMORY_DDL = `
CREATE TABLE IF NOT EXISTS consent_scope_tombstone (
  tombstone_id     TEXT PRIMARY KEY,
  app_id           TEXT REFERENCES consent_app(app_id),
  grantee_party_id TEXT REFERENCES core_party(party_id),
  schema_name      TEXT NOT NULL,
  table_name       TEXT,
  verbs            TEXT NOT NULL CHECK (verbs IN ('read','read+act','act','reveal')),
  revoked_at       TEXT NOT NULL,
  CHECK (app_id IS NOT NULL OR grantee_party_id IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_scope_tombstone_app ON consent_scope_tombstone(app_id);
CREATE INDEX IF NOT EXISTS idx_scope_tombstone_party ON consent_scope_tombstone(grantee_party_id);

CREATE TABLE IF NOT EXISTS consent_scope_request (
  request_id   TEXT PRIMARY KEY,
  plane        TEXT NOT NULL CHECK (plane IN ('app','agent')),
  app_id       TEXT NOT NULL,
  purpose      TEXT NOT NULL,
  scopes_json  TEXT NOT NULL CHECK (json_valid(scopes_json)),
  requested_at TEXT NOT NULL,
  decided_at   TEXT,
  decision     TEXT CHECK (decision IN ('approved','denied'))
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scope_request_open
  ON consent_scope_request(plane, app_id) WHERE decided_at IS NULL;
`;
