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
// 'locker.item'), the same star Docs/Photos write. Tags are free-form, one
// `locker_item_tag` row per (item, tag).
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
  -- watchtower: the one stored security fact (breach flag); weak/reused derive
  compromised  INTEGER NOT NULL DEFAULT 0 CHECK (compromised IN (0,1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  -- trash: soft-delete keeps the row (and its star) so restore is lossless;
  -- purge_at is set ~30 days out, mirroring Docs.
  deleted_at   TEXT,
  purge_at     TEXT
) STRICT;

CREATE TABLE locker_item_tag (
  item_id  TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
) STRICT;

CREATE INDEX locker_item_type_idx ON locker_item(type);
CREATE INDEX locker_item_tag_tag_idx ON locker_item_tag(tag);
`;
