-- THE VAULT IS THE INDEX (#1029 §2, §4) — RUNG THREE.
--
-- **ON THE LADDER.** `LADDER` in `crates/vault/src/migrations.rs` ends here.
-- The file is both the migration and its fixture (D-1020-D1-13), and
-- `crates/vault/tests/backup_crash_matrix.rs` is what makes it reviewable.
--
-- **NEVER EDITED FROM HERE ON.** A file in the field has already run this text;
-- an edit changes what a fresh file gets and nothing else, which is two schemas
-- with one number. A correction is rung four.
--
-- ## What this is for
--
-- §4: "**The vault is the index.** Blob custody and the manifests record
-- `(object, offset, length)` for every item, so there are no separate index
-- files to load, and no index that grows with the whole backup in memory."
--
-- §2, on the base: "A range whose content hash is unchanged since the previous
-- generation reuses the existing object. **The phone decides that from a local
-- upload index; the gateway is never asked.** […] The range-dedup index lives
-- **in the vault**, like blob custody, so a restored phone does not re-upload
-- the whole file for its first base."
--
-- Both sentences land in these two tables. `backup_object_range` is the dedup
-- index — plaintext hash to the object that already holds those bytes.
-- `backup_base_range` is one generation's base, as an ordered list of ranges.
--
-- ## Why the plaintext hash is the key, and why it is safe here
--
-- The plaintext hash is a confirmable commitment to content: anyone holding it
-- can test a guess. That is why §4 keeps it **out of the object** and names an
-- object by its *ciphertext* hash instead. It lives here because the vault file
-- is itself encrypted in every backup, so the commitment never leaves the
-- phone — which is the same argument blob custody already makes for the file
-- keys it holds.
--
-- ## Why there is no foreign key between the two tables
--
-- A base range names a plaintext hash, and the object holding those bytes may
-- be pruned from `backup_object_range` when retention drops the last generation
-- that used it, while the base row stays as the record of what that generation
-- was. A cascade would delete history to tidy a cache.

-- table backup_object_range
CREATE TABLE backup_object_range (
  plaintext_hash  TEXT PRIMARY KEY CHECK (length(plaintext_hash) = 64),
  object_name     TEXT NOT NULL CHECK (length(object_name) = 64),
  object_bytes    INTEGER NOT NULL CHECK (object_bytes >= 0),
  plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes >= 0),
  created_at      TEXT NOT NULL
) STRICT;

CREATE INDEX backup_object_range_by_object ON backup_object_range (object_name);

-- table backup_base_range
CREATE TABLE backup_base_range (
  generation      TEXT NOT NULL CHECK (length(generation) = 32),
  range_index     INTEGER NOT NULL CHECK (range_index >= 0),
  byte_offset     INTEGER NOT NULL CHECK (byte_offset >= 0),
  byte_length     INTEGER NOT NULL CHECK (byte_length > 0),
  plaintext_hash  TEXT NOT NULL CHECK (length(plaintext_hash) = 64),
  object_name     TEXT NOT NULL CHECK (length(object_name) = 64),
  PRIMARY KEY (generation, range_index)
) STRICT;

CREATE INDEX backup_base_range_by_hash ON backup_base_range (plaintext_hash);
