-- THE GATEWAY'S OWN STATE, rung 1 (#1080, #1191). Applied once, when state.db is founded;
-- a later change is a later rung, never an edit of this one once released.
--
-- Read the columns as the answer to "what does a gateway know?": public keys,
-- epochs, the BLAKE3 of credentials, device labels, keyed object names it
-- cannot invert, digests of ciphertext, sizes and its own clock. No plaintext,
-- no plaintext hash and no key has a column to arrive in.

CREATE TABLE vault (
  vault         BLOB    PRIMARY KEY CHECK (length(vault) = 32),
  writer_epoch  INTEGER NOT NULL CHECK (writer_epoch >= 1),
  paired_at_ms  INTEGER NOT NULL,
  moved_at_ms   INTEGER
) STRICT;

CREATE TABLE token (
  token_hash    BLOB    PRIMARY KEY CHECK (length(token_hash) = 32),
  vault         BLOB    NOT NULL REFERENCES vault (vault) ON DELETE CASCADE,
  epoch         INTEGER NOT NULL CHECK (epoch >= 0),
  kind          TEXT    NOT NULL CHECK (kind IN ('secret', 'claim', 'read')),
  label         TEXT    NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX token_by_vault ON token (vault, created_at_ms);

CREATE TABLE pairing_secret (
  secret_hash   BLOB    PRIMARY KEY CHECK (length(secret_hash) = 32),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms    INTEGER,
  used_by       BLOB    CHECK (used_by IS NULL OR length(used_by) = 32),
  CHECK ((used_at_ms IS NULL) = (used_by IS NULL))
) STRICT;

CREATE TABLE head (
  vault         BLOB    PRIMARY KEY REFERENCES vault (vault) ON DELETE CASCADE,
  name          BLOB    NOT NULL CHECK (length(name) = 32),
  taken_at_ms   INTEGER NOT NULL,
  set_at_ms     INTEGER NOT NULL
) STRICT;

CREATE TABLE snapshot (
  vault            BLOB    NOT NULL REFERENCES vault (vault) ON DELETE CASCADE,
  name             BLOB    NOT NULL CHECK (length(name) = 32),
  taken_at_ms      INTEGER NOT NULL,
  registered_at_ms INTEGER NOT NULL,
  PRIMARY KEY (vault, name)
) STRICT, WITHOUT ROWID;

CREATE TABLE object (
  vault            BLOB    NOT NULL REFERENCES vault (vault) ON DELETE CASCADE,
  name             BLOB    NOT NULL CHECK (length(name) = 32),
  digest           BLOB    NOT NULL CHECK (length(digest) = 32),
  size             INTEGER NOT NULL CHECK (size >= 0),
  stored_at_ms     INTEGER NOT NULL,
  tombstoned_at_ms INTEGER,
  purge_after_ms   INTEGER,
  damaged_at_ms    INTEGER,
  PRIMARY KEY (vault, name),
  CHECK ((tombstoned_at_ms IS NULL) = (purge_after_ms IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX object_by_purge ON object (purge_after_ms)
  WHERE purge_after_ms IS NOT NULL;
