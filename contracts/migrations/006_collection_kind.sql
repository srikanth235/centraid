-- A COLLECTION IS A NOTEBOOK OR AN ALBUM, AND SAYS WHICH — RUNG SIX.
--
-- **ON THE LADDER.** `LADDER` in `crates/vault/src/migrations.rs` ends here.
-- The file is both the migration and its fixture (D-1020-D1-13).
--
-- **NEVER EDITED FROM HERE ON.** A file in the field has already run this text;
-- an edit changes what a fresh file gets and nothing else, which is two schemas
-- with one number. A correction is rung seven.
--
-- ## What this is for
--
-- `knowledge.create_notebook` and `media.create_album` inserted the same shape
-- into `core_collection`, and nothing said which surface a row belonged to.
-- Notes read every collection as a notebook and Photos read every collection
-- as an album, so each app showed the other's rows, a note could be filed into
-- an album and a photograph added to a notebook, a notebook's name collided
-- with an album's, and `knowledge.delete_notebook` on an album id removed every
-- photograph's placement in it with no undo record. The owner's ruling (the
-- Notes plan, Q7, option A) is a REQUIRED discriminator: `kind` is `notebook`
-- or `album`, every writer states it, every reader filters on it, and a kind
-- never changes. One table and one entry table stay — #274's single mechanism
-- — and only the surface is typed.
--
-- ## Why a rebuild, and not `ADD COLUMN`
--
-- SQLite cannot add a `NOT NULL` column without a default to a table that has
-- rows, and a default would make the kind optional: a writer that forgot it
-- would silently make a notebook. So the table is rebuilt under
-- `defer_foreign_keys`: the rows are carried in a TEMP table with their kind,
-- the table is dropped and created again with the column, and the rows come
-- back WITH THEIR ROWIDS — `fts_core_collection` is keyed by rowid, and a
-- renumbered row would search as somebody else's name. Dropping the table
-- counts every `core_collection_entry` row as an orphan; putting its parent
-- back uncounts it, so the deferred check at COMMIT sees nothing. Its indexes
-- and triggers go with the DROP and are created again below with the
-- baseline's own text, byte for byte, so the only object whose DDL moved is
-- the table.
--
-- The `DROP TABLE`'s implicit delete fires no trigger, so the `core_entity`
-- row each collection holds (#916) stays where it is and the rows coming back
-- still match it.
--
-- ## How an existing collection is classified, in order
--
-- 1. **It is nested** — it has a parent, or it is one → `notebook`. Only
--    `knowledge.create_notebook` takes a parent; `media.create_album` always
--    writes a flat row and `media.delete_album` refuses a collection with
--    children.
-- 2. **It holds a photograph** (`media.asset` entry) → `album`.
-- 3. **It holds a note** (`knowledge.note` entry) → `notebook`.
-- 4. **It is empty**, so its contents say nothing. The invocation journal
--    (`agent_command_invocation`) is the one record of which command made it:
--    an executed `media.create_album` whose input minted this id, or whose
--    `title` is this collection's name while no executed
--    `knowledge.create_notebook` minted this id or used this name → `album`.
-- 5. Anything else → `notebook`. An empty collection is the cheapest thing to
--    get wrong: nothing is filed in it, and the member can make another.
--
-- A MIXED collection (a photograph AND a note) is an `album` by rule 2. Its
-- note entries are removed, so those notes are UNFILED — each note is intact
-- and shows under "Unfiled" in Notes. A nested collection holding a
-- photograph is a `notebook` by rule 1, and its photograph entries are removed
-- the same way; the photographs stay in the library. Both shapes could only be
-- made by the cross-app writes this rung ends, and the pre-migration snapshot
-- `Vault::open` takes before the ladder runs holds the file as it was. A
-- notebook's cover that named a photograph no longer filed in it is cleared.
-- Entries of any other target type are left where they are: no command writes
-- one, and deciding for them is not this rung's to do.
--
-- ## What else the rung states
--
-- `core_collection_kind_is_immutable`: a notebook never becomes an album. Every
-- reader filters on `kind`, so a row that changed kind would move between two
-- apps with its entries still of the other app's type.
--
-- Name uniqueness stays a COMMAND rule, scoped by kind (`knowledge.rs`
-- `name_unused`): a vault written before this rung may already hold two
-- same-named rows that were never the same surface's, and a unique index here
-- would refuse to migrate it.

PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE collection_kind_carry AS
SELECT c.rowid AS carried_rowid,
       c.collection_id,
       c.owner_party_id,
       c.name,
       c.cover_content_id,
       c.parent_collection_id,
       c.sort_order,
       c.created_at,
       c.updated_at,
       c.row_version,
       CASE
         WHEN c.parent_collection_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM core_collection child
                       WHERE child.parent_collection_id = c.collection_id)
           THEN 'notebook'
         WHEN EXISTS (SELECT 1 FROM core_collection_entry e
                       WHERE e.collection_id = c.collection_id
                         AND e.target_type = 'media.asset')
           THEN 'album'
         WHEN EXISTS (SELECT 1 FROM core_collection_entry e
                       WHERE e.collection_id = c.collection_id
                         AND e.target_type = 'knowledge.note')
           THEN 'notebook'
         WHEN EXISTS (SELECT 1 FROM agent_command_invocation i
                       WHERE i.command_id = 'media.create_album'
                         AND i.status = 'executed'
                         AND json_valid(i.input_json)
                         AND json_extract(i.input_json, '$.album_id') = c.collection_id)
           THEN 'album'
         WHEN EXISTS (SELECT 1 FROM agent_command_invocation i
                       WHERE i.command_id = 'knowledge.create_notebook'
                         AND i.status = 'executed'
                         AND json_valid(i.input_json)
                         AND (json_extract(i.input_json, '$.notebook_id') = c.collection_id
                           OR json_extract(i.input_json, '$.name') = c.name))
           THEN 'notebook'
         WHEN EXISTS (SELECT 1 FROM agent_command_invocation i
                       WHERE i.command_id = 'media.create_album'
                         AND i.status = 'executed'
                         AND json_valid(i.input_json)
                         AND json_extract(i.input_json, '$.album_id') IS NULL
                         AND json_extract(i.input_json, '$.title') = c.name)
           THEN 'album'
         ELSE 'notebook'
       END AS kind
  FROM core_collection c;

-- The other kind's entries leave: notes out of albums, photographs out of
-- notebooks. Before the DROP, with foreign keys enforced as usual, so each
-- entry's `core_entity` row goes with it through the entry's own trigger.
DELETE FROM core_collection_entry
 WHERE (target_type = 'knowledge.note'
        AND collection_id IN (SELECT collection_id FROM temp.collection_kind_carry
                               WHERE kind = 'album'))
    OR (target_type = 'media.asset'
        AND collection_id IN (SELECT collection_id FROM temp.collection_kind_carry
                               WHERE kind = 'notebook'));

UPDATE temp.collection_kind_carry
   SET cover_content_id = NULL
 WHERE kind = 'notebook'
   AND cover_content_id IN (SELECT content_id FROM media_asset);

DROP TABLE core_collection;

CREATE TABLE core_collection (
  collection_id        TEXT PRIMARY KEY,
  owner_party_id       TEXT NOT NULL REFERENCES core_party(party_id),
  kind                 TEXT NOT NULL CHECK (kind IN ('notebook','album')),
  name                 TEXT NOT NULL,
  cover_content_id     TEXT REFERENCES core_content_item(content_id),
  parent_collection_id TEXT REFERENCES core_collection(collection_id),
  sort_order           INTEGER NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (collection_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

INSERT INTO core_collection
  (rowid, collection_id, owner_party_id, kind, name, cover_content_id,
   parent_collection_id, sort_order, created_at, updated_at, row_version)
SELECT carried_rowid, collection_id, owner_party_id, kind, name, cover_content_id,
       parent_collection_id, sort_order, created_at, updated_at, row_version
  FROM temp.collection_kind_carry
 ORDER BY carried_rowid;

DROP TABLE temp.collection_kind_carry;

-- The baseline's own objects on this table, in the baseline's own text.

CREATE INDEX core_collection_sort_page_idx
  ON core_collection(sort_order, collection_id);

CREATE INDEX idx_collection_cover_content ON core_collection(cover_content_id);

CREATE INDEX idx_collection_owner_party ON core_collection(owner_party_id);

CREATE INDEX idx_collection_parent_collection ON core_collection(parent_collection_id);

CREATE TRIGGER core_collection_entity_delete
AFTER DELETE ON core_collection
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.collection_id;
END;

CREATE TRIGGER core_collection_entity_insert
BEFORE INSERT ON core_collection
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_collection (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.collection_id AND entity_type <> 'core.collection');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.collection_id, 'core.collection', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

CREATE TRIGGER core_collection_touch_updated_at
AFTER UPDATE ON core_collection
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_collection
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE collection_id = NEW.collection_id;
END;

CREATE TRIGGER fts_core_collection_ad AFTER DELETE ON core_collection BEGIN
  DELETE FROM fts_core_collection WHERE rowid = old.rowid;
END;

CREATE TRIGGER fts_core_collection_ai AFTER INSERT ON core_collection BEGIN
  INSERT INTO fts_core_collection(rowid, collection_id, name) SELECT new.rowid, new."collection_id", new."name";
END;

CREATE TRIGGER fts_core_collection_au AFTER UPDATE ON core_collection BEGIN
  DELETE FROM fts_core_collection WHERE rowid = old.rowid;
  INSERT INTO fts_core_collection(rowid, collection_id, name) SELECT new.rowid, new."collection_id", new."name";
END;

-- New: a kind is for life.

CREATE TRIGGER core_collection_kind_is_immutable
BEFORE UPDATE OF kind ON core_collection
WHEN NEW.kind IS NOT OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'a collection''s kind never changes: a notebook stays a notebook and an album stays an album');
END;
