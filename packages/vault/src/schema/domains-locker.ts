import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export const LOCKER_DDL = `
CREATE TABLE locker_item (
  item_id      TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN (
    'login','card','note','identity','wifi','password',
    'ssh_key','api_credential','passport','bank_account','driving_licence',
    'software_licence','crypto_wallet','membership','document')),
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
  -- When the CURRENT password was set (#872, GAPS §3.3 #6d). Stamped by the
  -- write path, never derived from updated_at — an edit that only retags an
  -- item must not make its password look fresh. Nullable: an item with no
  -- password, and a row that predates the column, honestly say "unknown"
  -- rather than claiming an age Review would then reason from.
  password_set_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- archive (#872, GAPS §3.3 #9): "keep forever, hide from lists", the
  -- opposite end of trash's 30-day countdown. Deliberately EXCLUSIVE with
  -- deleted_at rather than orthogonal: an item is live, archived, or trashed,
  -- and the CHECK is what stops a future write inventing a fourth state where
  -- a purge sweep and an archive shelf both claim the same row.
  archived_at  TEXT,
  -- trash: soft-delete keeps the row (and its star) so restore is lossless;
  -- purge_at is set ~30 days out, mirroring Docs. The guard (issue #441 A4)
  -- makes purge_at-without-deleted_at unrepresentable, matching the other
  -- trash-bearing tables.
  deleted_at   TEXT,
  purge_at     TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  CHECK (archived_at IS NULL OR deleted_at IS NULL),
  FOREIGN KEY (item_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX locker_item_type_idx ON locker_item(type);
CREATE INDEX locker_item_connection_idx ON locker_item(connection_id);
CREATE INDEX locker_item_archived_idx ON locker_item(archived_at);
CREATE INDEX IF NOT EXISTS locker_item_purge_idx
  ON locker_item(purge_at) WHERE purge_at IS NOT NULL;
${touchUpdatedAt("locker_item", "item_id")}
`;

export const LOCKER_ALIAS_DDL = `
CREATE TABLE locker_item_alias (
  alias      TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;
CREATE INDEX IF NOT EXISTS locker_item_alias_item_idx ON locker_item_alias(item_id);
`;

export const LOCKER_AUTH_DDL = `
CREATE TABLE locker_auth_credential (
  credential_id TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('passphrase','device')),
  label         TEXT NOT NULL,
  salt          BLOB NOT NULL,
  verifier      BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;
CREATE INDEX locker_auth_credential_kind_idx
  ON locker_auth_credential(kind);
${touchUpdatedAt("locker_auth_credential", "credential_id")}
`;

export const LOCKER_FIELD_DDL = `
CREATE TABLE locker_item_field (
  field_id     TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  -- '' is the item's unnamed leading section, so a field always has one.
  section      TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('text','sealed','url','date','otp')),
  value_text   TEXT,
  value_sealed TEXT,
  -- Owner ordering within (item, section); ties break on label.
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  CHECK (kind = 'sealed' OR value_sealed IS NULL),
  CHECK (kind <> 'sealed' OR value_text IS NULL),
  FOREIGN KEY (field_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX locker_item_field_item_idx
  ON locker_item_field(item_id, section, position);
${touchUpdatedAt("locker_item_field", "field_id")}
`;

export const LOCKER_ADDRESS_DDL = `
CREATE TABLE locker_item_address (
  address_id   TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  match_policy TEXT NOT NULL DEFAULT 'registrable-domain'
    CHECK (match_policy IN ('registrable-domain','exact-host')),
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  FOREIGN KEY (address_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX locker_item_address_item_idx
  ON locker_item_address(item_id, position);
`;

export const LOCKER_PASSKEY_DDL = `
CREATE TABLE locker_item_passkey (
  item_id       TEXT PRIMARY KEY REFERENCES locker_item(item_id) ON DELETE CASCADE,
  rp_id         TEXT NOT NULL,
  user_handle   TEXT,
  display_name  TEXT,
  credential_id TEXT,
  algorithm     TEXT,
  private_key   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;
CREATE INDEX locker_item_passkey_rp_idx ON locker_item_passkey(rp_id);
${touchUpdatedAt("locker_item_passkey", "item_id")}
`;
