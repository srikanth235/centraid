// The sync domain (issue #290 phases 2–4): connections, the universal
// external-id map, and the staging band every import flows through —
// source → connector → staging → review/merge → live. File drops and live
// connectors are the same shape; a file connection simply has no principal
// and no cursor.
//
// Policy stances the schema encodes (issue #290 decision 6):
//   - the vault wins conflicts: an upstream change lands as a staged
//     `update` row for review, never an overwrite;
//   - upstream deletions never delete: `gone_upstream` is a flag the owner
//     acts on deliberately;
//   - ingestion is one-way: nothing here models write-back.
//
// Ships as its own migration step — earlier DDL versions are applied.
export const SYNC_DDL = `
CREATE TABLE IF NOT EXISTS sync_connection (
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

CREATE TABLE IF NOT EXISTS sync_external_entity (
  map_id        TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES sync_connection(connection_id),
  external_id   TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  gone_upstream INTEGER NOT NULL CHECK (gone_upstream IN (0,1)) DEFAULT 0,
  UNIQUE (connection_id, external_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_sync_external_entity
  ON sync_external_entity(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS sync_import_batch (
  batch_id      TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES sync_connection(connection_id),
  status        TEXT NOT NULL CHECK (status IN ('draft','published','discarded')),
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  summary_json  TEXT NOT NULL CHECK (json_valid(summary_json))
) STRICT;

CREATE TABLE IF NOT EXISTS sync_import_row (
  row_id              TEXT PRIMARY KEY,
  batch_id            TEXT NOT NULL REFERENCES sync_import_batch(batch_id),
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

CREATE TABLE IF NOT EXISTS sync_connection_cursor (
  cursor_id     TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES sync_connection(connection_id),
  key           TEXT NOT NULL,
  value_json    TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at    TEXT NOT NULL,
  UNIQUE (connection_id, key)
) STRICT;

CREATE TABLE IF NOT EXISTS sync_connection_run (
  run_id        TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES sync_connection(connection_id),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('running','ok','failed','aborted')) ,
  staged        INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  error         TEXT
) STRICT;
`;

// Broker-owned credentials (issue #304, amending #290 decision 4): a
// connection may CARRY its credential instead of borrowing the harness's —
// `oauth2` (BYO client: the owner registers their own OAuth app per
// provider) or `api_key` (a static PAT). Both live in a SIDECAR keyed by
// the connection (not columns on sync_connection — migration
// re-runnability, the same call #298/#299 made): no row = today's
// harness-ambient lane. Secret cells (client_secret, access_token,
// refresh_token, api_key) are sealed columns — ciphertext at rest,
// placeholder on read, hash in the journal — and are only ever INJECTED by
// the gateway broker into `ctx.fetch` requests toward `allowed_hosts`;
// connector code never sees a token.
//
// `sync_connection_health` carries WHY a connection sits in needs-auth
// (refresh refused, scope withdrawn) so the reconnect surface is
// actionable, not a mystery — its own sidecar because notes outlive and
// predate credentials (a missing locker secret flips needs-auth too).
export const SYNC_CREDENTIAL_DDL = `
CREATE TABLE IF NOT EXISTS sync_connection_credential (
  connection_id    TEXT PRIMARY KEY REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  cred_kind        TEXT NOT NULL CHECK (cred_kind IN ('oauth2','api_key')),
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
  updated_at       TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sync_connection_health (
  connection_id TEXT PRIMARY KEY REFERENCES sync_connection(connection_id) ON DELETE CASCADE,
  auth_note     TEXT,
  updated_at    TEXT NOT NULL
) STRICT;
`;
