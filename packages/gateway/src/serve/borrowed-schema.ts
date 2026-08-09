/*
 * The borrowed store's DDL (#726 P4 D4), extracted so `borrowed-store.ts`
 * stays under the repo's file-size limit. The tables ARE
 * `packages/client/src/replica/store-core.ts`'s six plus FTS5 — a borrowed
 * scope is a replica of someone else's vault, and there is no second answer
 * to what a projected consent scope looks like on disk. Every delta from
 * store-core is annotated below; all of them come from ONE file holding MANY
 * origins rather than one replica of one vault.
 */

export const BORROWED_DDL = `
  CREATE TABLE IF NOT EXISTS replica_bootstrap_progress (
    shape_id TEXT PRIMARY KEY,
    protocol_version INTEGER NOT NULL,
    origin_vault_id TEXT NOT NULL,
    schema_epoch TEXT NOT NULL,
    cursor_epoch TEXT,
    cursor_seq INTEGER
  ) STRICT;
  CREATE TABLE IF NOT EXISTS replica_meta (
    shape_id TEXT PRIMARY KEY,
    protocol_version INTEGER NOT NULL,
    origin_vault_id TEXT NOT NULL,
    cursor_epoch TEXT NOT NULL,
    cursor_seq INTEGER NOT NULL,
    schema_epoch TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS replica_shape (
    shape_id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    origin_vault_id TEXT NOT NULL,
    edge_id TEXT NOT NULL,
    schema_epoch TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS replica_shape_edge ON replica_shape(edge_id);
  CREATE TABLE IF NOT EXISTS replica_entity_schema (
    shape_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    primary_key TEXT NOT NULL,
    columns_json TEXT NOT NULL,
    has_unavailable_fields INTEGER NOT NULL CHECK (has_unavailable_fields IN (0, 1)),
    PRIMARY KEY (shape_id, entity)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS replica_row (
    shape_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    row_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    oversized_json TEXT NOT NULL,
    server_version INTEGER NOT NULL DEFAULT 0 CHECK (server_version >= 0),
    PRIMARY KEY (shape_id, entity, row_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS replica_row_entity ON replica_row(shape_id, entity);
  CREATE VIRTUAL TABLE IF NOT EXISTS replica_search USING fts5(
    shape_id UNINDEXED,
    entity UNINDEXED,
    row_id UNINDEXED,
    body,
    tokenize = "unicode61 remove_diacritics 2"
  );
  CREATE TABLE IF NOT EXISTS replica_search_gap (
    shape_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    row_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (shape_id, entity, row_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS borrowed_blob (
    shape_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    rung TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    custody_state TEXT NOT NULL CHECK (custody_state IN ('pinned', 'cached', 'at-origin')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (shape_id, sha256)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS borrowed_blob_sha ON borrowed_blob(sha256);
  -- The audience's own outbox for a read+act edge (#726 P5). Same wire
  -- shape a device's own offline intent carries — {intent_id, action,
  -- payload_hash, baseVersions} — queued HERE because there is no open
  -- origin vault on this machine to hold it in. Drained by pushing to the
  -- origin over the peer plane (or a co-hosted door); the origin's own
  -- vault.db replica_intent_outcome is the canonical record once it
  -- answers — this row is the audience's local mirror of that answer, plus
  -- whatever has not yet been asked.
  CREATE TABLE IF NOT EXISTS borrowed_intent (
    intent_id TEXT PRIMARY KEY,
    edge_id TEXT NOT NULL,
    action TEXT NOT NULL,
    input_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    base_versions_json TEXT,
    status TEXT NOT NULL CHECK (
      status IN ('queued', 'sending', 'parked', 'executed', 'denied', 'failed', 'conflict')
    ),
    invocation_id TEXT,
    reason TEXT,
    conflict_json TEXT,
    output_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS borrowed_intent_edge_status
    ON borrowed_intent(edge_id, status, updated_at);
  -- A device-tailable change log for ONE borrowed shape (#726 P5 device
  -- route). The store's own cursor (replica_meta) tracks what THIS gateway
  -- has pulled from the origin; this table is the separate, downstream
  -- question of what a device mounting the shape has not yet seen. Rows are
  -- swept with the shape in dropShape (no external content to reconcile,
  -- unlike FTS).
  CREATE TABLE IF NOT EXISTS borrowed_change (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    shape_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    row_id TEXT NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
    changed_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS borrowed_change_shape_seq
    ON borrowed_change(shape_id, seq);
`;
