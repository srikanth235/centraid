-- THE GATEWAY'S OWN STATE, rung 1 (#1080, #1191). Applied once, when state.db is founded;
-- a later change is a later rung, never an edit of this one once released.
--
-- Read the columns as the answer to "what does a gateway know?": public keys,
-- epochs, signatures the vault key made, the BLAKE3 of credentials, device
-- labels, keyed object names it cannot invert, digests of ciphertext, sizes
-- and its own clock. No plaintext, no plaintext hash and no key has a column
-- to arrive in.

CREATE TABLE vault (
  vault         BLOB    PRIMARY KEY CHECK (length(vault) = 32),
  writer_epoch  INTEGER NOT NULL CHECK (writer_epoch >= 1),
  paired_at_ms  INTEGER NOT NULL,
  moved_at_ms   INTEGER,
  generation    INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  writes        INTEGER NOT NULL DEFAULT 0 CHECK (writes >= 0),
  frozen_at_ms  INTEGER
) STRICT;

CREATE TABLE token (
  token_hash    BLOB    PRIMARY KEY CHECK (length(token_hash) = 32),
  vault         BLOB    NOT NULL REFERENCES vault (vault) ON DELETE CASCADE,
  epoch         INTEGER NOT NULL CHECK (epoch >= 0),
  kind          TEXT    NOT NULL CHECK (kind IN ('secret', 'claim', 'read')),
  label         TEXT    NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CHECK ((kind = 'read') = (epoch = 0)
         AND (kind <> 'secret' OR epoch = 1)
         AND (kind <> 'claim' OR epoch >= 2))
) STRICT;

CREATE INDEX token_by_vault ON token (vault, created_at_ms, token_hash);

-- What a takeover leaves of a token it revoked: the hash, so the old phone
-- still hears "moved". Never the token.
CREATE TABLE revoked_token (
  token_hash    BLOB    PRIMARY KEY CHECK (length(token_hash) = 32),
  vault         BLOB    NOT NULL REFERENCES vault (vault) ON DELETE CASCADE,
  epoch         INTEGER NOT NULL CHECK (epoch >= 0),
  revoked_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX revoked_token_by_vault ON revoked_token (vault, revoked_at_ms, token_hash);

-- The last claim a vault accepted, signed, so every MOVED can carry it.
CREATE TABLE claim (
  vault         BLOB    PRIMARY KEY REFERENCES vault (vault) ON DELETE CASCADE,
  epoch         INTEGER NOT NULL CHECK (epoch >= 2),
  head_seen     BLOB    CHECK (head_seen IS NULL OR length(head_seen) = 32),
  nonce         BLOB    NOT NULL CHECK (length(nonce) = 16),
  signature     BLOB    NOT NULL CHECK (length(signature) = 64),
  claimed_at_ms INTEGER NOT NULL
) STRICT;

-- A nonce names no vault: it is issued before anyone says who is asking.
CREATE TABLE nonce (
  nonce         BLOB    PRIMARY KEY CHECK (length(nonce) = 16),
  issued_at_ms  INTEGER NOT NULL
) STRICT;

CREATE TABLE pairing_secret (
  secret_hash   BLOB    PRIMARY KEY CHECK (length(secret_hash) = 32),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms    INTEGER,
  used_by       BLOB    CHECK (used_by IS NULL OR length(used_by) = 32),
  CHECK ((used_at_ms IS NULL) = (used_by IS NULL))
) STRICT;

CREATE INDEX pairing_secret_by_creation ON pairing_secret (created_at_ms, secret_hash);

-- The unspent secrets only, so "the oldest live one" walks at most the 64
-- live and the few expired-but-not-yet-pruned.
CREATE INDEX pairing_secret_unspent ON pairing_secret (created_at_ms, secret_hash)
  WHERE used_at_ms IS NULL;

CREATE TABLE object (
  vault            BLOB    NOT NULL REFERENCES vault (vault) ON DELETE CASCADE,
  name             BLOB    NOT NULL CHECK (length(name) = 32),
  digest           BLOB    NOT NULL CHECK (length(digest) = 32),
  size             INTEGER NOT NULL CHECK (size >= 0),
  stored_at_ms     INTEGER NOT NULL,
  held_at_ms       INTEGER,
  purge_after_ms   INTEGER,
  damaged_at_ms    INTEGER,
  PRIMARY KEY (vault, name),
  CHECK ((held_at_ms IS NULL) = (purge_after_ms IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX object_by_purge ON object (purge_after_ms, vault, name)
  WHERE purge_after_ms IS NOT NULL;

-- One row per signed head ever accepted that is still kept: a copy of the
-- record, and the hold of its manifest when that is held.
CREATE TABLE snapshot (
  vault            BLOB    NOT NULL REFERENCES vault (vault) ON DELETE CASCADE,
  name             BLOB    NOT NULL CHECK (length(name) = 32),
  taken_at_ms      INTEGER NOT NULL,
  registered_at_ms INTEGER NOT NULL,
  epoch            INTEGER NOT NULL,
  generation       INTEGER NOT NULL,
  writes           INTEGER NOT NULL,
  prev             BLOB    CHECK (prev IS NULL OR length(prev) = 32),
  signature        BLOB    NOT NULL CHECK (length(signature) = 64),
  held_at_ms       INTEGER,
  purge_after_ms   INTEGER,
  PRIMARY KEY (vault, name),
  FOREIGN KEY (vault, name) REFERENCES object (vault, name),
  CHECK ((held_at_ms IS NULL) = (purge_after_ms IS NULL))
) STRICT, WITHOUT ROWID;

-- The head, as the phone signed it. Keys run head -> snapshot -> object.
CREATE TABLE head (
  vault         BLOB    PRIMARY KEY REFERENCES vault (vault) ON DELETE CASCADE,
  name          BLOB    NOT NULL CHECK (length(name) = 32),
  prev          BLOB    CHECK (prev IS NULL OR length(prev) = 32),
  taken_at_ms   INTEGER NOT NULL,
  epoch         INTEGER NOT NULL,
  generation    INTEGER NOT NULL,
  writes        INTEGER NOT NULL,
  set_at_ms     INTEGER NOT NULL,
  signature     BLOB    NOT NULL CHECK (length(signature) = 64),
  FOREIGN KEY (vault, name) REFERENCES snapshot (vault, name)
) STRICT;
