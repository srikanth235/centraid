// Password-manager DDL — schema `locker`. "Everything, locked up": logins,
// cards, secure notes, identities, Wi-Fi and standalone passwords, each an
// owner-only secret item. One flat `locker_item` table carries the common
// spine (type, title, timestamps, trash + purge date like Docs) plus every
// type's fields as nullable columns — the prototype's record shape, 1:1.
//
// Secret fields live here in the clear at the SQLite layer: field-level
// encryption-at-rest is the vault file's responsibility (a future crypto
// seam), not a per-column cipher this domain invents. The security boundary
// the app upholds is at the projection: secrets are NEVER in list payloads,
// only in the single-item read, and never logged. Watchtower's `weak` and
// `reused` are derived at read time from the passwords the server holds;
// `compromised` is the one stored flag (a breach-check result), so it is the
// only Watchtower fact that is a column.
//
// The gestures the ontology already models are reused, not re-invented (issue
// #274): favorites are the flags-scheme star on the item (target_type
// 'locker.item'), the same star Docs/Photos write. Tags went the same way
// (issue #310 S3): free-form labels are SKOS concepts in the locker-tags
// scheme carried by core_tag rows — the second tagging mechanism the old
// locker_item_tag table re-introduced is gone.
//
// All tables STRICT; PKs are TEXT UUIDv7; timestamps are TEXT ISO-8601 UTC —
// the core spine's conventions.

export const LOCKER_DDL = `
CREATE TABLE locker_item (
  item_id      TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('login','card','note','identity','wifi','password')),
  title        TEXT NOT NULL,
  -- login
  username     TEXT,
  password     TEXT,
  url          TEXT,
  url_match_policy TEXT NOT NULL DEFAULT 'registrable-domain'
    CHECK (url_match_policy IN ('registrable-domain','exact-host')),
  otp_seed     TEXT,
  notes        TEXT,
  -- card
  cardholder   TEXT,
  card_number  TEXT,
  expiry       TEXT,
  cvv          TEXT,
  brand        TEXT,
  -- note
  content      TEXT,
  -- identity
  fullname     TEXT,
  email        TEXT,
  phone        TEXT,
  address      TEXT,
  -- wifi (network; the passphrase reuses the login 'password' column)
  network      TEXT,
  -- The service anchor (issue #310 S3): which broker connection this
  -- credential is FOR, when one exists — "which logins belong to services I
  -- have connections for" becomes a join, and Watchtower can correlate a
  -- breach with the connection that uses the password. Nullable: most items
  -- guard services the vault never talks to.
  connection_id TEXT REFERENCES sync_connection(connection_id),
  -- watchtower: the one stored security fact (breach flag); weak/reused derive
  compromised  INTEGER NOT NULL DEFAULT 0 CHECK (compromised IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  -- trash: soft-delete keeps the row (and its star) so restore is lossless;
  -- purge_at is set ~30 days out, mirroring Docs. The guard (issue #441 A4)
  -- makes purge_at-without-deleted_at unrepresentable, matching the other
  -- trash-bearing tables.
  deleted_at   TEXT,
  purge_at     TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL)
) STRICT;

CREATE INDEX locker_item_type_idx ON locker_item(type);
CREATE INDEX locker_item_connection_idx ON locker_item(connection_id);
`;

// A stable, owner-assigned alias for an item (issue #298 item 4). A
// connector binds `locker:@<alias>:<column>` instead of the raw UUID, so
// the natural rotation gesture — trash the old login, add the new one —
// heals the binding the moment the owner puts the same alias on the
// replacement. A SIDECAR table, not a column on locker_item: the alias is
// the PRIMARY KEY (globally unique), which a nullable column cannot express
// as cleanly. Uniqueness
// AMONG LIVE items is enforced in the command handler (single-writer vault),
// so a trashed item's alias frees for its successor once reassigned. ON
// DELETE CASCADE drops the mapping when the item is purged.
export const LOCKER_ALIAS_DDL = `
CREATE TABLE IF NOT EXISTS locker_item_alias (
  alias    TEXT PRIMARY KEY,
  item_id  TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS locker_item_alias_item_idx ON locker_item_alias(item_id);
`;
