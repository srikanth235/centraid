-- THE LOCKER HAS ONE GENERATION — RUNG SEVEN (#1047, R-1047-D2).
--
-- **ON THE LADDER.** `LADDER` in `crates/vault/src/migrations.rs` ends here.
-- The file is both the migration and its fixture (D-1020-D1-13).
--
-- **NEVER EDITED FROM HERE ON.** A file in the field has already run this text;
-- an edit changes what a fresh file gets and nothing else, which is two schemas
-- with one number. A correction is rung eight.
--
-- ## What this is for
--
-- `locker_key` named the Locker key `K`'s generations: `retired_at` marked the
-- ones rotation had replaced, and `locker_key_live_idx`, a unique index on the
-- predicate `retired_at IS NULL`, let exactly one live row stand beside any
-- number of retired ones. Rotation was the only writer of `retired_at`, and it
-- is gone (R-1047-D1): `K` is the 24 words' own leaf (D-6), so there is no
-- `K′` to rotate to and nothing retires a generation. The column had no writer
-- and the index guarded a state nothing could reach.
--
-- What stays is the property the index held — a vault names ONE generation,
-- so every sealed cell's AAD names the same id — and it is now stated
-- directly: `locker_key_one_generation` is a unique index on a constant, so a
-- second row is refused by the file whoever writes it.
--
-- ## Why a rebuild, and what is carried
--
-- `ALTER TABLE DROP COLUMN` refuses a column an index uses and leaves the
-- table's text edited in place; a rebuild states the table in one clean
-- `CREATE`. Only the live row is carried. A retired row named a key file that
-- no build holds any more, and a cell sealed under it was already unopenable:
-- the guard refuses a write that names it and the reveal names it stale,
-- with or without the row. Nothing references `locker_key` by foreign key —
-- a sealed cell carries its generation as a value in `key_id` — so the drop
-- orphans nothing.

CREATE TEMP TABLE locker_key_carry AS
SELECT key_id, created_at
  FROM locker_key
 WHERE retired_at IS NULL;

DROP TABLE locker_key;

CREATE TABLE locker_key (
  key_id     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO locker_key (key_id, created_at)
SELECT key_id, created_at FROM temp.locker_key_carry;

DROP TABLE temp.locker_key_carry;

CREATE UNIQUE INDEX locker_key_one_generation ON locker_key((1));
