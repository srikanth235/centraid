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
// (#310): free-form labels are SKOS concepts in the locker-tags
// scheme carried by core_tag rows — the second tagging mechanism the old
// locker_item_tag table re-introduced is gone.
//
// A TYPE IS A SET OF SECTIONS AND FIELDS, not a set of columns (#872). The six
// original types kept their fields as nullable columns because they were the
// prototype's record shape; the nine that follow — SSH key, API credential,
// passport, bank account, driving licence, software licence, crypto wallet,
// membership, document — add NO columns at all. Their fields are rows in
// `locker_item_field`, minted from the templates in
// `commands/locker-types.ts`, which is also what lets a type this build does
// not know degrade to a note carrying its custom fields rather than to
// nothing. The rule for a future type is therefore "add a template", never
// "add a column".
//
// All tables STRICT; PKs are TEXT UUIDv7; timestamps are TEXT ISO-8601 UTC —
// the core spine's conventions.

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
  updated_at   TEXT NOT NULL,
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
  CHECK (archived_at IS NULL OR deleted_at IS NULL)
) STRICT;

CREATE INDEX locker_item_type_idx ON locker_item(type);
CREATE INDEX locker_item_connection_idx ON locker_item(connection_id);
CREATE INDEX locker_item_archived_idx ON locker_item(archived_at);
`;

// A stable, owner-assigned alias for an item (#298). A
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

// Locker's user-presence credential store (#630). The verifier is
// derived from a vault-key HMAC of the credential before scrypt, so a copied
// vault database is not an offline passphrase oracle: verification also needs
// the separately-custodied seal key. Live unlock and per-item permits are
// deliberately memory-only in gateway/locker-auth.ts and therefore disappear
// on restart, background lock, or inactivity.
//
// This is its own forward migration rung. Unlike the pre-release base schema,
// an existing vault may already contain Locker data when #630 lands; adding
// authentication must preserve it rather than ask the owner to erase it.
export const LOCKER_AUTH_DDL = `
CREATE TABLE locker_auth_credential (
  credential_id TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('passphrase','device')),
  label         TEXT NOT NULL,
  salt          BLOB NOT NULL,
  verifier      BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;
CREATE INDEX locker_auth_credential_kind_idx
  ON locker_auth_credential(kind);
`;

// Owner-defined sections and fields (#872, GAPS §3.3 #2 — "the largest
// structural gap: without it every unusual credential lands in a note, and
// notes are unsearchable by design"). Also the storage the nine new item types
// are built from, and what an unknown type degrades ONTO.
//
// TWO value columns, not one, because sealing is per COLUMN (schema/sealed.ts)
// and a custom field's kind is per ROW. `value_text` carries text/url/date/otp
// values and stays readable; `value_sealed` is declared sealed, so a
// `kind = 'sealed'` value is ciphertext at rest, a placeholder in every
// default read and in the browser replica, hash-not-value in the journal, and
// structurally outside FTS — the same six enforcement points as
// `locker_item.password`. A single polymorphic `value` column would have had
// to seal every custom field, including the ones the member wants to read at
// a glance. The CHECK is what makes "a sealed custom value cannot land in the
// plain column" a property of the schema rather than of the handler.
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
  updated_at   TEXT NOT NULL,
  CHECK (kind = 'sealed' OR value_sealed IS NULL),
  CHECK (kind <> 'sealed' OR value_text IS NULL)
) STRICT;
CREATE INDEX locker_item_field_item_idx
  ON locker_item_field(item_id, section, position);
`;

// More than one address per login (#872, GAPS §3.3 #4), each with its OWN
// match policy. A sidecar rather than a second column set: the count is
// unbounded and every address needs the same registrable-domain/exact-host
// decision the primary one carries. `locker_item.url` and
// `locker_item.url_match_policy` STAY the primary address — every existing
// reader, the Companion candidate list and the connector binding keep working
// unchanged, and this table is strictly additional addresses.
export const LOCKER_ADDRESS_DDL = `
CREATE TABLE locker_item_address (
  address_id   TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  match_policy TEXT NOT NULL DEFAULT 'registrable-domain'
    CHECK (match_policy IN ('registrable-domain','exact-host')),
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX locker_item_address_item_idx
  ON locker_item_address(item_id, position);
`;

// The passkey slot (#872, GAPS §3.3 #3 — "the item-level slot is drawn now so
// the fill path can follow"). STORAGE ONLY: no WebAuthn ceremony lives here
// and none is implied. What a passkey is, at rest, is credential metadata
// (which relying party, which user handle, when it was made) plus private key
// material — so the metadata is plain and browsable and `private_key` is a
// declared sealed column, ciphertext at rest like any other secret.
// One passkey per item today; the PK is the item so a second one is a
// deliberate schema change rather than an accidental duplicate.
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
  updated_at    TEXT NOT NULL
) STRICT;
CREATE INDEX locker_item_passkey_rp_idx ON locker_item_passkey(rp_id);
`;

// Item and password history (#872, GAPS §3.3 #5 — "also fixes 'I rotated it
// and the new one did not save'"). Deliberately NOT `core_entity_revision`:
// that ledger is the 10-second UNDO window and `pruneExpiredEntityRevisions`
// deletes from it by design, so a password rotated last March would be gone.
// This one is durable for the life of the item.
//
// `password` is a declared sealed column: a PREVIOUS password is exactly as
// much of a secret as the current one, so it is ciphertext at rest here too
// and never rides a read. `changed_json` carries the non-secret shape of the
// change (which fields moved, the title before it) so History can say what
// happened without unsealing anything. CASCADE on purge: "erase for good"
// must not leave the old passwords behind.
export const LOCKER_HISTORY_DDL = `
CREATE TABLE locker_item_history (
  revision_id  TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  operation    TEXT NOT NULL,
  title        TEXT,
  password     TEXT,
  changed_json TEXT NOT NULL CHECK (json_valid(changed_json)),
  recorded_at  TEXT NOT NULL
) STRICT;
CREATE INDEX locker_item_history_item_idx
  ON locker_item_history(item_id, recorded_at DESC);
`;
