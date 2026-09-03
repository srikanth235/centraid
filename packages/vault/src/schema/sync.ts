import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export const SYNC_DDL = `
CREATE TABLE sync_connection (
  connection_id TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  label         TEXT NOT NULL,
  principal     TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active','needs-auth','failing','paused')),
  trust         TEXT NOT NULL CHECK (trust IN ('staged','auto-publish')),
  -- Per-class standing consent for enrichment (issue #310 C3): NULL means
  -- auto-publish trust covers every derived-data class; a JSON array
  -- (['caption','tag','face','collection','filing']) narrows it — classes
  -- outside it stage as drafts for review instead of landing silently.
  enrich_classes_json TEXT CHECK (enrich_classes_json IS NULL OR json_valid(enrich_classes_json)),
  created_at    TEXT NOT NULL,
  last_run_at   TEXT,
  UNIQUE (kind, label)
) STRICT;

CREATE TABLE sync_external_entity (
  map_id        TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL
    REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  gone_upstream INTEGER NOT NULL CHECK (gone_upstream IN (0,1)) DEFAULT 0,
  UNIQUE (connection_id, external_id),
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_sync_external_entity
  ON sync_external_entity(target_type, target_id);

CREATE TABLE sync_import_batch (
  batch_id      TEXT PRIMARY KEY,
  -- NO CASCADE, deliberately (#916, W2a): a batch is RECEIPTED HISTORY — what
  -- was imported, when, and what it became — so removing the connection is
  -- REFUSED while any exists rather than shredding the record of it.
  -- \`sync.remove_connection\` says so in its denial.
  connection_id TEXT NOT NULL REFERENCES sync_connection(connection_id),
  status        TEXT NOT NULL CHECK (status IN ('draft','published','discarded')),
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  summary_json  TEXT NOT NULL CHECK (json_valid(summary_json))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_sync_import_batch_connection ON sync_import_batch(connection_id);

CREATE TABLE sync_import_row (
  row_id              TEXT PRIMARY KEY,
  batch_id            TEXT NOT NULL
    REFERENCES sync_import_batch(batch_id) ON DELETE CASCADE,
  seq                 INTEGER NOT NULL,
  entity_type         TEXT NOT NULL,
  external_id         TEXT NOT NULL,
  payload_json        TEXT NOT NULL CHECK (json_valid(payload_json)),
  disposition         TEXT NOT NULL CHECK (disposition IN ('create','update','skip','merge-candidate')),
  target_entity_id    TEXT,
  published_entity_id TEXT,
  note                TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_sync_import_row_batch ON sync_import_row(batch_id, seq);

CREATE TABLE sync_connection_cursor (
  cursor_id     TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL
    REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value_json    TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  UNIQUE (connection_id, key)
) STRICT;

CREATE TABLE sync_connection_run (
  run_id        TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL
    REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('running','ok','failed','aborted')) ,
  staged        INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  error         TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_sync_connection_run_connection ON sync_connection_run(connection_id);
${touchUpdatedAt("sync_connection_cursor", "cursor_id")}
`;

export const SYNC_CREDENTIAL_DDL = `
CREATE TABLE sync_connection_credential (
  connection_id    TEXT PRIMARY KEY REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  cred_kind        TEXT NOT NULL CHECK (cred_kind IN ('oauth2','api_key')),
  oauth_mode       TEXT NOT NULL DEFAULT 'byo' CHECK (oauth_mode IN ('byo','assist')),
  provider         TEXT,
  auth_url         TEXT,
  token_url        TEXT,
  scopes           TEXT,
  client_id        TEXT,
  client_secret    TEXT,
  access_token     TEXT,
  refresh_token    TEXT,
  api_key          TEXT,
  token_expires_at TEXT,
  allowed_hosts    TEXT NOT NULL CHECK (json_valid(allowed_hosts)),
  -- The exchange-minted HMAC capability an Assist refresh token is redeemable
  -- at the OAuth Worker with (#865). Sealed, re-persisted on every rotation.
  refresh_capability TEXT,
  updated_at       TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;

CREATE TABLE sync_connection_health (
  connection_id TEXT PRIMARY KEY REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  auth_note     TEXT,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;
${touchUpdatedAt("sync_connection_credential", "connection_id")}
${touchUpdatedAt("sync_connection_health", "connection_id")}
`;
