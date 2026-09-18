-- A MIGRATION THAT FAILS MID-WAY, ON PURPOSE (#1020, wave 2 lane R, D-1020-R7).
--
-- This is NOT a rung of the ladder and must never be added to one. It exists
-- so one rule can be proven rather than asserted:
--
--   a migration that fails mid-way restores from the pre-migration snapshot
--   it took first.
--
-- The rule needs a failure that LEAVES THE FILE CHANGED. A rung whose single
-- statement fails is rolled back by the ladder's own transaction and proves
-- nothing; the case the snapshot exists for is the one where earlier work
-- already landed. So the fixture below succeeds twice and then fails, and the
-- half-migrated file is what the drill restores away from.
--
-- Read by `crates/vault/src/backup/drill.rs::run_upgrade_failure_drill` and by
-- nothing else. `LADDER` in `crates/vault/src/migrations.rs` does not and will
-- not contain it.

-- Statement 1 — succeeds. A real upgrade's first move: a new table.
CREATE TABLE drill_upgrade_scratch (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL
) STRICT;

-- Statement 2 — succeeds. A row in it, so the change is visible in a census.
INSERT INTO drill_upgrade_scratch (id, label) VALUES ('half', 'the upgrade got this far');

-- Statement 3 — FAILS. A NOT NULL column with no value: the kind of mistake a
-- real backfill makes on a column whose data turned out not to be uniform.
INSERT INTO drill_upgrade_scratch (id, label) VALUES ('boom', NULL);
