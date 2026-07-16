// Durable blob ingress + offsite transit state (issue #414).
//
// These are plumbing tables, deliberately separate from the ontology and
// from `blob_staging`: an upload session is not yet a content claim, and an
// outbox row is only a custody obligation. Both survive process restarts so
// resumability never depends on an in-memory hash/multipart object.

export const BLOB_TRANSFER_DDL = `
CREATE TABLE IF NOT EXISTS blob_outbox (
  sha256          TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  byte_size       INTEGER NOT NULL CHECK (byte_size >= 0),
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','uploading')),
  temp_id         TEXT,
  upload_id       TEXT,
  parts_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(parts_json)),
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at   TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_blob_outbox_retry
  ON blob_outbox(state, next_retry_at, created_at);

CREATE TABLE IF NOT EXISTS blob_ingress_session (
  session_id       TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('fallback','stream-through','direct')),
  state            TEXT NOT NULL DEFAULT 'open'
                     CHECK (state IN ('open','committing','complete','aborted')),
  expected_sha256  TEXT CHECK (expected_sha256 IS NULL OR length(expected_sha256) = 64),
  expected_size    INTEGER CHECK (expected_size IS NULL OR expected_size >= 0),
  received_bytes   INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  hash_state_json  TEXT CHECK (hash_state_json IS NULL OR json_valid(hash_state_json)),
  temp_path        TEXT,
  remote_temp_id   TEXT,
  remote_upload_id TEXT,
  remote_parts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(remote_parts_json)),
  media_type       TEXT,
  original_name    TEXT,
  meta_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  staged_by        TEXT,
  sealed_size      INTEGER CHECK (sealed_size IS NULL OR sealed_size >= 0),
  part_count       INTEGER CHECK (part_count IS NULL OR (part_count > 0 AND part_count <= 10000)),
  device_id        TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_blob_ingress_expiry
  ON blob_ingress_session(state, expires_at);

CREATE TABLE IF NOT EXISTS blob_ingress_probe (
  session_id  TEXT PRIMARY KEY REFERENCES blob_ingress_session(session_id) ON DELETE CASCADE,
  head_bytes  BLOB,
  tail_bytes  BLOB
) STRICT;

CREATE TABLE IF NOT EXISTS blob_content_key (
  sha256       TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  wrapped_key  BLOB NOT NULL,
  wrap_nonce   BLOB NOT NULL CHECK (length(wrap_nonce) = 12),
  key_epoch    INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch > 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS blob_device_content_key (
  sha256       TEXT NOT NULL REFERENCES blob_content_key(sha256) ON DELETE CASCADE,
  device_id    TEXT NOT NULL REFERENCES consent_device(device_id) ON DELETE CASCADE,
  wrapped_key  BLOB NOT NULL,
  wrap_nonce   BLOB NOT NULL CHECK (length(wrap_nonce) = 12),
  device_key_epoch INTEGER NOT NULL CHECK (device_key_epoch > 0),
  granted_at   TEXT NOT NULL,
  PRIMARY KEY (sha256, device_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_blob_device_content_key_device
  ON blob_device_content_key(device_id);

CREATE TABLE IF NOT EXISTS blob_device_wrap_key (
  device_id    TEXT PRIMARY KEY REFERENCES consent_device(device_id) ON DELETE CASCADE,
  key_epoch    INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch > 0),
  salt         BLOB NOT NULL CHECK (length(salt) = 32),
  updated_at   TEXT NOT NULL
) STRICT;
`;
