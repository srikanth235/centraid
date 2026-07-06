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
