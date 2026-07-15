// The durable replica protocol band (issue #406). It lives in vault.db so a
// base-table mutation and its change entry share one SQLite transaction. The
// per-entity triggers are installed after fresh schema bootstrap by replica/change-log.ts:
// generating them from the logical registry keeps this DDL independent of the
// ontology's many primary-key names and also covers live ext tables.

/**
 * Build-time replica contract epoch. This is intentionally independent of
 * PRAGMA user_version: v0 edits the single fresh schema rung in place, while
 * any incompatible replica wire/trigger change bumps this value and rotates
 * every cursor. It is an invalidation number, not a migration ladder.
 */
export const REPLICA_SCHEMA_EPOCH = 1;

export const REPLICA_DDL = `
CREATE TABLE IF NOT EXISTS replica_meta (
  singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch            TEXT NOT NULL,
  floor_seq        INTEGER NOT NULL DEFAULT 0 CHECK (floor_seq >= 0),
  schema_epoch     INTEGER NOT NULL CHECK (schema_epoch >= 1),
  trigger_schema_version INTEGER NOT NULL DEFAULT 0 CHECK (trigger_schema_version >= 0),
  epoch_reason     TEXT NOT NULL DEFAULT 'created',
  epoch_started_at TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;

INSERT OR IGNORE INTO replica_meta (
  singleton, epoch, floor_seq, schema_epoch, trigger_schema_version,
  epoch_reason, epoch_started_at, updated_at
)
VALUES (
  1,
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(6))),
  0,
  ${REPLICA_SCHEMA_EPOCH},
  0,
  'created',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE TABLE IF NOT EXISTS replica_change (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  epoch           TEXT NOT NULL,
  entity          TEXT NOT NULL,
  row_id          TEXT NOT NULL,
  op              TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
  old_values_json TEXT CHECK (old_values_json IS NULL OR json_valid(old_values_json)),
  changed_at      TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_replica_change_epoch_seq
  ON replica_change(epoch, seq);
CREATE INDEX IF NOT EXISTS idx_replica_change_latest_row
  ON replica_change(epoch, entity, row_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_replica_change_changed_at
  ON replica_change(epoch, changed_at, seq);

-- An intent's durable canonical outcome. The generic replica trigger installer
-- publishes this as the internal entity replica.intent, letting the initiating
-- device observe parked/committed/rejected transitions through the same log as
-- ontology writes. The gateway remains responsible for device scoping.
CREATE TABLE IF NOT EXISTS replica_intent_outcome (
  intent_id     TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL,
  app_id        TEXT NOT NULL,
  action        TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (
    status IN ('queued','sending','parked','executed','denied','failed')
  ),
  invocation_id TEXT,
  reason        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_replica_intent_device_status
  ON replica_intent_outcome(device_id, status, updated_at);

-- Canonical invocation commit receipts close the cross-database crash gap:
-- vault.db mutations and this row commit together, before journal.db can be
-- advanced to executed. A retry whose journal row is still checked (or is
-- absent) therefore replays this receipt instead of running the command a
-- second time. This is internal protocol state, not a replica-visible entity.
CREATE TABLE IF NOT EXISTS replica_invocation_commit (
  invocation_id       TEXT PRIMARY KEY,
  command_id          TEXT NOT NULL,
  intent_id           TEXT,
  -- Redacted/non-secret post-check + S5 reconstruction material. This row is
  -- in the canonical transaction, so replay can finish journal.db without
  -- re-entering the command handler after a cross-database crash.
  audit_json          TEXT NOT NULL CHECK (json_valid(audit_json)),
  committed_at        TEXT NOT NULL,
  -- Set only after one atomic journal transaction has verified checks,
  -- provenance, receipt, evidence, explanation, and executed status.
  journal_finalized_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_replica_invocation_commit_intent
  ON replica_invocation_commit(intent_id)
  WHERE intent_id IS NOT NULL;

-- Confirmation-gated commands may remain parked for days. The resumable raw
-- request lives here encrypted under the vault DEK; replica_intent_outcome
-- above carries only the non-secret device-visible status. This table is
-- internal protocol state (never shape/grant addressable and never trigger-
-- published) and is deleted as soon as the owner decides or consent ends.
CREATE TABLE IF NOT EXISTS replica_parked_payload (
  invocation_id TEXT PRIMARY KEY,
  intent_id     TEXT,
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  request_sealed TEXT NOT NULL,
  grant_id      TEXT,
  command_id    TEXT NOT NULL,
  command_name  TEXT NOT NULL,
  reason        TEXT NOT NULL,
  parked_at     TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_replica_parked_grant
  ON replica_parked_payload(grant_id, parked_at);
`;
