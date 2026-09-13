-- ONE REVISION GRAPH, ENFORCED ON STORAGE (#1020, D-1020-N2) — A PROPOSAL.
--
-- **NOT ON THE LADDER YET.** `LADDER` in `crates/vault/src/migrations.rs` still
-- ends at rung one, and adding this rung is the root's per-slot migration (the
-- Notes lane brief). This file is the proposal plus its tests:
-- `crates/vault/tests/revisions_migration.rs` applies it to a founded vault,
-- proves each guard refuses what it is for, and proves the guards accept
-- everything the nine `knowledge.*` commands actually write.
--
-- ## What is broken today, and why a reader cannot fix it
--
-- [#916]'s ONT-revisions ruled `core_entity_revision` the ONLY history table.
-- [#996] R20(a) made a revision an OCCURRENCE — its own immutable row naming the
-- content that became current and the occurrence before it — and deleted the
-- content→content `revises` `core_link` graph from every WRITER. Drift ONT-22 is
-- closed in v0's code, and `crates/vault/tests/knowledge_commands.rs` proves no
-- `revises` link is written by any body edit.
--
-- **The SCHEMA still permits all of it.** Four rows nothing forbids:
--
--   1. `parent_revision_id = revision_id` — a revision that is its own ancestor.
--      The only guard on the column is the foreign key.
--   2. A parent belonging to ANOTHER object. "A revision belongs to one object"
--      is enforced by `knowledge.restore_note_version`'s precondition and by
--      `revisionChainOf`; a direct write, an import or a replica apply is not
--      asked.
--   3. An UPDATE that re-points `parent_revision_id`. History is never rewritten
--      (#916 R3) and nothing says so to SQLite — and this is the row that makes a
--      LONGER cycle reachable: a fresh insert cannot close one, because its own
--      id is not yet in any chain, so A→B→A needs a second statement that moves
--      a parent.
--   4. A `core_link` whose relation is `revises`. The concept is deliberately
--      unseeded (`crates/vault/src/bootstrap.rs`), but a seeded vocabulary or an
--      import could bring it back, and then there are two history graphs again.
--
-- Every one of those is a MALFORMED chain a reader has to defend against, and a
-- reader's only honest answer is a refusal: `centraid_apps_notes`'
-- `VersionChainError::Cycle` draws no history at all rather than four versions of
-- forty. That refusal is correct and it is not a fix — the member still cannot
-- see their history.
--
-- ## What this rung does
--
-- Three guards that make (1), (2) and (3) unrepresentable, one that makes (4)
-- unrepresentable, and four backfill checks that REFUSE THE MIGRATION rather
-- than silently leaving a bad row behind. With (1)-(3) closed, a cycle is
-- unreachable by construction: revisions are insert-only and a fresh id cannot
-- already be in its own parent's chain.
--
-- ## Which readers move, and which stays
--
--   * `crates/apps/notes/src/version_chain.rs` — `VersionChainError::Cycle`
--     becomes unreachable for a file this rung has run. **It STAYS**: the ladder
--     is forward-only and this vault may have been written by an older binary,
--     so the reader is the defence for the rows the guards were added after.
--   * `crates/vault/src/commands/knowledge.rs` — `restore_note_version`'s
--     `target_in_chain` precondition and its handler guard both stay: they answer
--     "that version belongs to something else" as a SENTENCE a member reads,
--     which a constraint violation is not.
--   * `packages/blueprints/apps/notes/version-chain.ts` and
--     `packages/vault/src/commands/revisions.ts` — **the v0 readers do not move.**
--     v0 is the pinned oracle until wave 6 and its `break`-on-seen walk is what
--     the parity fixtures were generated against; changing it would change the
--     oracle.
--
-- ## Cost
--
-- Two triggers on `core_entity_revision` (one INSERT, one UPDATE) and one on
-- `core_link`. Every body edit already writes one revision row, so the INSERT
-- guard runs once per edit over a single indexed lookup
-- (`core_entity_revision.revision_id` is the primary key). The `core_link` guard
-- joins the concept and its scheme, which `core_link_entities` already does in
-- its own precondition.

---- backfill checks (4)
--
-- A CHECK that cannot hold is how a migration refuses: the `INSERT ... SELECT`
-- lands a count, the constraint rejects any count but zero, and the rung's own
-- transaction rolls the file back untouched. A vault carrying a malformed chain
-- has to be repaired deliberately — a migration that dropped the row would be
-- deciding which of two histories the member keeps.

CREATE TABLE migration_002_guard (
  what  TEXT NOT NULL,
  found INTEGER NOT NULL CHECK (found = 0)
) STRICT;

-- (1) A revision that is its own ancestor.
INSERT INTO migration_002_guard (what, found)
SELECT 'self_parent', COUNT(*) FROM core_entity_revision
 WHERE parent_revision_id = revision_id;

-- (2) A parent belonging to another object.
INSERT INTO migration_002_guard (what, found)
SELECT 'foreign_parent', COUNT(*)
  FROM core_entity_revision r
  JOIN core_entity_revision p ON p.revision_id = r.parent_revision_id
 WHERE p.entity_type <> r.entity_type OR p.entity_id <> r.entity_id;

-- (3) A cycle of length two or more, which only an UPDATE can have made. Bounded
-- at the reader's own `MAX_CHAIN_STEPS`, so a malformed file cannot make the
-- check itself run forever.
INSERT INTO migration_002_guard (what, found)
SELECT 'cycle', COUNT(*) FROM (
  WITH RECURSIVE walk(root, at, steps) AS (
    SELECT revision_id, parent_revision_id, 1
      FROM core_entity_revision
     WHERE parent_revision_id IS NOT NULL
    UNION ALL
    SELECT walk.root, r.parent_revision_id, walk.steps + 1
      FROM walk
      JOIN core_entity_revision r ON r.revision_id = walk.at
     WHERE walk.at IS NOT NULL AND walk.at <> walk.root AND walk.steps < 500
  )
  SELECT DISTINCT root FROM walk WHERE at = root
);

-- (4) The second history graph's edge.
INSERT INTO migration_002_guard (what, found)
SELECT 'revises_link', COUNT(*)
  FROM core_link l
  JOIN core_concept c ON c.concept_id = l.relation_concept_id
  JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
 WHERE c.notation = 'revises' AND s.uri = 'urn:duaility:relations';

DROP TABLE migration_002_guard;

---- triggers (4)

-- A REVISION IS NOT ITS OWN ANCESTOR.
CREATE TRIGGER core_entity_revision_no_self_parent
BEFORE INSERT ON core_entity_revision
WHEN NEW.parent_revision_id IS NOT NULL AND NEW.parent_revision_id = NEW.revision_id
BEGIN
  SELECT RAISE(ABORT, 'a revision cannot be its own ancestor (issue #1020, D-1020-N2)');
END;

-- A REVISION BELONGS TO ONE OBJECT (#996, ruling R20(a)).
--
-- Before the occurrence model a version was a CONTENT id, so this was not even
-- detectable: two notes with identical bodies shared one history and a restore
-- could bring back a revision belonging to another object.
-- **The self-parent case is EXCLUDED here on purpose.** Both guards would fire
-- on `parent_revision_id = revision_id` — the parent does not exist yet, so the
-- same-object test cannot find it — and SQLite does not order `BEFORE INSERT`
-- triggers, so the member would get whichever sentence fired first. One row, one
-- sentence: a self-parent is answered by the guard named after it.
CREATE TRIGGER core_entity_revision_parent_is_same_object
BEFORE INSERT ON core_entity_revision
WHEN NEW.parent_revision_id IS NOT NULL
 AND NEW.parent_revision_id <> NEW.revision_id
 AND NOT EXISTS(
       SELECT 1 FROM core_entity_revision p
        WHERE p.revision_id = NEW.parent_revision_id
          AND p.entity_type = NEW.entity_type
          AND p.entity_id = NEW.entity_id)
BEGIN
  SELECT RAISE(ABORT, 'a revision belongs to one object: its parent must be a revision of the same entity (issue #1020, D-1020-N2)');
END;

-- HISTORY IS NEVER REWRITTEN (#916, rule R3), and this is also what makes a
-- cycle unreachable: revisions are insert-only, so a fresh id cannot already sit
-- in its own parent's chain, and the only way to close a loop is to move a
-- parent afterwards.
CREATE TRIGGER core_entity_revision_parent_is_immutable
BEFORE UPDATE OF parent_revision_id ON core_entity_revision
WHEN NEW.parent_revision_id IS NOT OLD.parent_revision_id
BEGIN
  SELECT RAISE(ABORT, 'a revision occurrence is immutable: history is appended to, never re-pointed (issue #916, R3)');
END;

-- ONE HISTORY GRAPH (#916, ONT-revisions; drift ONT-22).
--
-- The `revises` concept is deliberately unseeded, so this trigger is dormant in
-- a vault founded by this build — and it is the guard for the one that was not:
-- a seeded vocabulary, an import or a replica apply could bring the edge back,
-- and then `core_entity_revision` stops being the only history table.
CREATE TRIGGER core_link_no_revises_edge
BEFORE INSERT ON core_link
WHEN EXISTS(
       SELECT 1 FROM core_concept c
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE c.concept_id = NEW.relation_concept_id
          AND c.notation = 'revises'
          AND s.uri = 'urn:duaility:relations')
BEGIN
  SELECT RAISE(ABORT, 'version lineage is core_entity_revision, not a content-to-content link (issue #996, R20(a))');
END;
