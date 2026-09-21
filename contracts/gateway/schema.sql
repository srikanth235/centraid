-- THE GATEWAY'S STATE, AND AN ADAPTER HOLDS IT IN THIS SHAPE (#1029 §3).
--
-- One schema, kept as a contract rather than folded into the adapter: a second
-- schema would be a second place for the rules in `crates/gateway-core` to be
-- wrong, and the conformance suite could not tell. It was written for two
-- adapters; the hosted one is struck (scope amendment 2026-09-21) and the
-- separation is kept because the suite, not an adapter, defines the protocol.
--
-- It lives under `contracts/` and not inside the crate for two reasons. It is a
-- contract between two adapters neither of which is the reference
-- implementation, which is what `contracts/` is for; and `crates/gateway-core`
-- is a pure state machine with no SQL of its own — it reaches this file through
-- `include_str!` and hands it to whichever adapter is applying it. That is also
-- why `cargo xtask rules`' sql-confinement is not tripped and its allowlist was
-- not touched: there is no SQL in a Rust string literal here to confine.
--
-- THE GATEWAY IS BLIND. Read every column below and ask what it could tell
-- somebody who stole this file: identity keys, generation ids, txid ranges,
-- object kinds, PADDED sizes and timing. There is no column for plaintext, for
-- a plaintext hash, for a table name, for an exact size, or for a key — and
-- there is nowhere for one to arrive, because a column is the only way it
-- could. `crates/gateway-core`'s canary asserts that against a live store.

-- --------------------------------------------------------------- accounts --
--
-- Keyed by the ACCOUNT KEY (§0): `seed / account'`. There is no email address,
-- no phone number and no name here, and no column to put one in.
CREATE TABLE IF NOT EXISTS account (
  account_key      BLOB PRIMARY KEY NOT NULL,   -- 32-byte Ed25519 public key
  admitted_at_ms   INTEGER NOT NULL,
  -- The bound the owner set when they minted the invite. Zero is a legitimate
  -- bound and is not "no limit". `plan_state`, `lapse_at_ms` and
  -- `retain_until_ms` were here while a purchase could lapse (F13); the scope
  -- amendment of 2026-09-21 struck the account's purchase half from v0.
  quota_bytes      INTEGER NOT NULL
) STRICT;

-- ----------------------------------------------------------------- vaults --
--
-- A vault is addressed by its identity key and there is no second id to map
-- (§0). `moved_at_ms` is the TOMBSTONE that makes `VAULT_MOVED` a different
-- answer from a stranger's `UNAUTHORIZED`.
CREATE TABLE IF NOT EXISTS vault (
  vault_key        BLOB PRIMARY KEY NOT NULL,
  account_key      BLOB NOT NULL REFERENCES account(account_key) ON DELETE RESTRICT,
  registered_at_ms INTEGER NOT NULL,
  -- The current lease, `(epoch, device key)`. The epoch is the lease's own
  -- monotonic counter and NEVER a backup generation, which is 128 random bits
  -- and has no order at all (F3).
  lease_device     BLOB,
  lease_epoch      INTEGER NOT NULL DEFAULT 0,
  lease_taken_at_ms INTEGER,
  -- The manifest head. It moves ONLY by compare-and-set (F7).
  head_object      BLOB,
  head_set_at_ms   INTEGER,
  -- Set when a higher epoch took the vault. Not a deletion.
  moved_at_ms      INTEGER,
  -- The server owner's append-only flag: deletes are disabled for devices
  -- entirely and the owner prunes from the admin CLI.
  append_only      INTEGER NOT NULL DEFAULT 0,
  used_bytes       INTEGER NOT NULL DEFAULT 0
) STRICT;

-- ---------------------------------------------------------------- objects --
--
-- Write-once and self-verifying. `name` is the BLAKE3-256 of the sealed bytes —
-- the id everything in this repository uses. `attested_checksum` is the SHA-256
-- of the same bytes, declared UP FRONT, because the object store's API is not
-- ours: R2 and every S3-compatible store attest SHA-256 and nothing else, and
-- R2 records it only when the client sent it. The declaration is what binds the
-- two names together for a gateway that can only ever see one of them.
CREATE TABLE IF NOT EXISTS object (
  vault_key         BLOB NOT NULL REFERENCES vault(vault_key) ON DELETE CASCADE,
  name              BLOB NOT NULL,
  attested_checksum BLOB NOT NULL,
  -- 'base' | 'segment' | 'manifest' | 'blob' | 'pack' | 'share-entry'
  kind              TEXT NOT NULL,
  -- After zstd and Padmé. A SIZE CLASS, not a size, and the only census a
  -- blind store can take — which is why the shrink guard is defined over it
  -- and not over a row count (F4).
  padded_size       INTEGER NOT NULL,
  -- 'declared' | 'committed' | 'tombstoned'
  state             TEXT NOT NULL,
  -- The GATEWAY'S OWN receipt time. Retention is judged by this and by nothing
  -- a client sends, which is what stops a stolen phone backdating real bases
  -- out of retention (F10).
  received_at_ms    INTEGER NOT NULL,
  committed_at_ms   INTEGER,
  -- A tombstoned object becomes purgeable here, not before. Until then a
  -- restored phone can undelete or restore an older generation.
  purge_after_ms    INTEGER,
  generation        TEXT NOT NULL,
  PRIMARY KEY (vault_key, name)
) STRICT;

CREATE INDEX IF NOT EXISTS object_by_kind
  ON object (vault_key, kind, received_at_ms);

-- ------------------------------------------------------------ generations --
CREATE TABLE IF NOT EXISTS generation (
  vault_key        BLOB NOT NULL REFERENCES vault(vault_key) ON DELETE CASCADE,
  -- 128 random bits, hex. Never a counter (#116).
  generation       TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  first_txid       INTEGER NOT NULL,
  last_txid        INTEGER NOT NULL,
  head_object      BLOB,
  PRIMARY KEY (vault_key, generation)
) STRICT;

-- ------------------------------------------------------------------ bases --
--
-- THE BASE IS THE UNIT OF RETENTION (F10), and a base is SEVERAL objects — the
-- `base`-kind 4 MiB page ranges one commit brought. The floor, the coverage
-- window and the size guard are all defined over the group, not over its
-- members, so the group has to be a row: `object.generation` cannot stand in
-- for it, because a phone may commit many bases under one generation id (the
-- retention abuse run in `gateway-core`'s conformance suite lands fifty of
-- them under one) and a generation is an open-ended append stream rather than
-- a point in time.
--
-- `base_id` is the commit's manifest head, which is already a unique name: a
-- counter invented for this would be a second id to keep in step.
-- `received_at_ms` is the GATEWAY'S OWN receipt time, which is the whole of
-- F10's defence, and `padded_size` is the summed padded size of the group — the
-- only census a blind store can take (F4).
CREATE TABLE IF NOT EXISTS base (
  vault_key      BLOB NOT NULL REFERENCES vault(vault_key) ON DELETE CASCADE,
  base_id        BLOB NOT NULL,
  generation     TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  padded_size    INTEGER NOT NULL,
  tombstoned     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_key, base_id)
) STRICT;

-- Which objects one base is made of. `ordinal` keeps the group's order stable
-- across adapters, so two gateways answering the same restore hand the phone
-- the same list rather than whichever order their store iterates in.
CREATE TABLE IF NOT EXISTS base_object (
  vault_key   BLOB NOT NULL,
  base_id     BLOB NOT NULL,
  object_name BLOB NOT NULL,
  ordinal     INTEGER NOT NULL,
  PRIMARY KEY (vault_key, base_id, object_name)
) STRICT;

CREATE INDEX IF NOT EXISTS base_object_by_object
  ON base_object (vault_key, object_name);

-- ---------------------------------------------------------- delete ledger --
--
-- AT MOST ONE CLIENT-DIRECTED BASE TOMBSTONE PER VAULT PER DAY (F4). A stolen
-- phone cannot outrun a rate limit, and this table is the only memory the rule
-- has: the gateway cannot read a census, so what it counts is its own acts.
CREATE TABLE IF NOT EXISTS client_delete (
  vault_key    BLOB NOT NULL REFERENCES vault(vault_key) ON DELETE CASCADE,
  object_name  BLOB NOT NULL,
  kind         TEXT NOT NULL,
  deleted_at_ms INTEGER NOT NULL,
  PRIMARY KEY (vault_key, object_name)
) STRICT;

-- The rate limit's own memory, and it is a SEPARATE row from the ledger above
-- on purpose: `StateStore::record_client_base_delete(vault, at)` carries no
-- object name, because the rule does not need one — what it asks is "when did
-- this vault last tombstone a base", once per vault. `client_delete` is the
-- per-object audit ledger and is keyed by name; this is the counter the rule
-- reads. Folding them would mean either inventing a name the port never sent,
-- or making the rule scan a growing table for a MAX on every delete.
CREATE TABLE IF NOT EXISTS client_base_delete (
  vault_key     BLOB PRIMARY KEY NOT NULL REFERENCES vault(vault_key) ON DELETE CASCADE,
  deleted_at_ms INTEGER NOT NULL
) STRICT;
