// Consent plane DDL — schema `consent` from duaility-ontology.html §03.
// Only the *model* half lives in vault.db; the append-only audit stream
// (consent.receipt, consent.provenance) lives in journal.db — see journal.ts.

export const CONSENT_DDL = `
CREATE TABLE consent_app (
  app_id       TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
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

// v8 (issue #293): widen the grant-scope verbs CHECK with 'reveal'. SQLite
// cannot ALTER a CHECK constraint, so existing vaults rebuild the table in
// place — nothing references consent_grant_scope by FK, and the copy is
// column-for-column. Fresh vaults get the widened CHECK from v1 and this
// rung degenerates to the same copy.
export const GRANT_SCOPE_REVEAL_DDL = `
CREATE TABLE consent_grant_scope_v8 (
  scope_id        TEXT PRIMARY KEY,
  grant_id        TEXT NOT NULL REFERENCES consent_access_grant(grant_id),
  schema_name     TEXT NOT NULL,
  table_name      TEXT,
  verbs           TEXT NOT NULL CHECK (verbs IN ('read','read+act','act','reveal')),
  row_filter_json TEXT CHECK (row_filter_json IS NULL OR json_valid(row_filter_json)),
  field_mask_json TEXT CHECK (field_mask_json IS NULL OR json_valid(field_mask_json))
) STRICT;
INSERT INTO consent_grant_scope_v8 SELECT * FROM consent_grant_scope;
DROP TABLE consent_grant_scope;
ALTER TABLE consent_grant_scope_v8 RENAME TO consent_grant_scope;
`;
