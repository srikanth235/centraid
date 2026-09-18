-- EVERY BLOB HAS ITS OWN RANDOM FILE KEY (#1029 §4) — RUNG FOUR.
--
-- **ON THE LADDER.** `LADDER` in `crates/vault/src/migrations.rs` ends here.
-- The file is both the migration and its fixture (D-1020-D1-13).
--
-- **NEVER EDITED FROM HERE ON.** A file in the field has already run this text;
-- an edit changes what a fresh file gets and nothing else, which is two schemas
-- with one number. A correction is rung five.
--
-- ## What this is for
--
-- §4, "Every blob has its own random file key":
--
--   Originals and thumbnails are encrypted once, each under a fresh 32-byte
--   file key. The file key is stored in the vault's blob-custody row, which the
--   backup itself encrypts. **Consequence:** sharing a photo means handing out
--   its file key and a read capability. The bytes are uploaded once, whether
--   they are a backup or shared with ten people.
--
-- and §4, "The vault is the index":
--
--   Blob custody and the manifests record `(object, offset, length)` for every
--   item, so there are no separate index files to load, and no index that grows
--   with the whole backup in memory.
--
-- Two tables, because those are two different facts. `backup_blob_custody` is
-- the KEY and the identity; `backup_blob_placement` is WHERE the bytes are, and
-- there may be several rows of it for one blob — an original over 16 MiB is a
-- list of `blob` objects (F6), and a thumbnail is a range inside a pack.
--
-- ## Why the file key is stored as it is
--
-- The row holds the raw 32 bytes. That is §4's sentence — "stored in the
-- vault's blob-custody row, which the backup itself encrypts" — and not an
-- oversight beside `blob_content_key`, which wraps its keys under a device
-- wrap. The two answer different questions: that table is the superseded v0
-- shape, where a key had to survive in a file the backup copied in the clear
-- (B1). Rung three's header already records why the plaintext hash is safe in
-- this file for the same reason, and `crates/vault/src/backup/base.rs` seals
-- every range of it.
--
-- What this buys, and it is the whole reason the key is a row rather than a
-- header field: **rotating the vault root key does not touch a photograph.** A
-- `blob` or `thumbnail` object carries no wrapped key at all, so a rotation
-- re-wraps base, segment and manifest headers and leaves every original and
-- every thumbnail exactly where it is.
--
-- ## Why the plaintext hash is the primary key
--
-- §4: "**The phone deduplicates on its own.** It is the only writer and knows
-- every plaintext hash." Making the hash the key is what makes the second
-- import of the same photograph a lookup rather than a second upload, and it is
-- what makes the property W8 needs true — the bytes are uploaded once, whether
-- they are a backup or shared with ten people, because there is one row and one
-- file key for one set of bytes.
--
-- ## Why `byte_length` may be zero and `byte_offset` may not be the file's
--
-- A placement is a range inside an OBJECT, not inside the original. For a blob
-- that is its own object the offset is 0; for a thumbnail inside a pack it is
-- where the item starts. An empty blob is a legal object with a zero-length
-- plaintext, so the length's check is `>= 0` and the part index is what orders
-- the parts.

-- table backup_blob_custody
CREATE TABLE backup_blob_custody (
  plaintext_hash  TEXT PRIMARY KEY CHECK (length(plaintext_hash) = 64 AND plaintext_hash NOT GLOB '*[^0-9a-f]*'),
  file_key        BLOB NOT NULL CHECK (length(file_key) = 32),
  plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes >= 0),
  blob_role       TEXT NOT NULL CHECK (blob_role IN ('original','thumbnail')),
  created_at      TEXT NOT NULL
) STRICT;

CREATE INDEX backup_blob_custody_by_role ON backup_blob_custody (blob_role);

-- table backup_blob_placement
CREATE TABLE backup_blob_placement (
  plaintext_hash TEXT NOT NULL REFERENCES backup_blob_custody(plaintext_hash) ON DELETE CASCADE,
  part_index     INTEGER NOT NULL CHECK (part_index >= 0),
  object_name    TEXT NOT NULL CHECK (length(object_name) = 64 AND object_name NOT GLOB '*[^0-9a-f]*'),
  byte_offset    INTEGER NOT NULL CHECK (byte_offset >= 0),
  byte_length    INTEGER NOT NULL CHECK (byte_length >= 0),
  PRIMARY KEY (plaintext_hash, part_index)
) STRICT;

-- THE INDEX A RESTORE'S THUMBNAIL GRID READS. The grid is fetched by OBJECT,
-- one request per pack, so this is the index that makes "proportional to packs,
-- not thumbnails" a query and not a scan.
CREATE INDEX backup_blob_placement_by_object ON backup_blob_placement (object_name);
