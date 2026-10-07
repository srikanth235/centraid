-- A LOGIN HAS NO MATCH POLICY — RUNG EIGHT (#1047, Q-1047-15).
--
-- **ON THE LADDER.** `LADDER` in `crates/vault/src/migrations.rs` ends here.
-- The file is both the migration and its fixture (D-1020-D1-13).
--
-- **NEVER EDITED FROM HERE ON.** A file in the field has already run this text;
-- an edit changes what a fresh file gets and nothing else, which is two schemas
-- with one number. A correction is rung nine.
--
-- ## What this is for
--
-- `locker_item.url_match_policy` and `locker_item_address.match_policy` said
-- how wide a login's address was — its registrable domain or its exact host —
-- for a matcher that decided whether a page got a credential. The matcher went
-- with the fill plane (R-1047-D3), and no OS credential provider can read the
-- vault (R-1020-24), so the column was a setting the phone's editor offered and
-- nothing obeyed. The owner's ruling of 2026-09-29 (Q-1047-15) is to drop it
-- rather than keep a control that does nothing.
--
-- ## Why `DROP COLUMN` and not a rebuild
--
-- Each column's one CHECK is its own column constraint, no index, trigger,
-- view or foreign key names either column, and neither table is keyed by
-- rowid for anything — so `ALTER TABLE … DROP COLUMN` is exact here, and it
-- is what rung five used for `locker_item.connection_id`. The stored values
-- are discarded; they described a behaviour no build has.

ALTER TABLE locker_item DROP COLUMN url_match_policy;

ALTER TABLE locker_item_address DROP COLUMN match_policy;
