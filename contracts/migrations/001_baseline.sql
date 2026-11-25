-- THE TARGET v0 VAULT SCHEMA, ON PAPER ([#1214](https://github.com/srikanth235/centraid/issues/1214), checkpoint 0).
--
-- A design document in executable form: the whole DDL that will replace `001_baseline.sql` in one
-- step, then the rows founding seeds, then (last, clearly apart) the ladder of the attached
-- `<stem>.index.db`. Nothing reads this file yet; no code, test or digest depends on it. The tags
-- `-- A13`, `-- K1` ... name the item of #1214 a statement carries out.
--
-- THE DOCTRINE this file keeps, so a reader can check it table by table:
--   * STRICT tables; every foreign key says its ON DELETE; every foreign key's first child column
--     leads an index (partial `WHERE col IS NOT NULL` when mostly NULL); every index names its reader.
--   * A kind row has a generated VIRTUAL `kind` constant and a composite key `(id, kind)` into `entity`.
--   * Every time column has an exact format CHECK (A2): an instant is `strftime('%Y-%m-%dT%H:%M:%fZ', c) IS c`,
--     a floating wall clock `strftime('%Y-%m-%dT%H:%M', c) IS c`, a date `date(c) IS c`. NULL passes
--     each (`strftime(f, NULL) IS NULL`), so a nullable column needs no extra clause.
--   * A vocabulary that will grow is a seeded WITHOUT ROWID lookup table that carries its attributes
--     (A1). No CHECK, trigger or index predicate on a referencing table names one of its values. Where
--     a column's shape depends on the value, the child holds a GENERATED column that is 1 exactly
--     when the shaped thing is present and NULL otherwise, and a composite foreign key sends
--     `(value, that column)` at the lookup row's attribute. A NULL is not checked by a foreign key, so
--     the absent case passes and the present case needs the attribute the lookup row carries:
--     `derivative` (`has_out` is 0/1, so both cases are checked), `concept.color`, `origin.retired_at`,
--     `entity.parent_id`, `entity.title`. (The generated constants of a kind row, `'person'`, `'place'`,
--     are the kind-row idiom itself and name the row's own kind.)
--   * Closed sets (statuses, booleans, `timing`, `message.outcome`, `revision.actor`) keep CHECKs.
--   * No `'now'`, `CURRENT_*`, `unixepoch()` or `julianday()`: the command stamps the injected clock.
--   * A hash is only ever a foreign key into `blob(hash)`: never inside JSON or a sealed value.
--   * `position` is REAL wherever rows are ordered.
--   * Lookup rows are written only by a migration rung, and the Rust connection will refuse any other write to a
--     lookup table (checkpoint 1; nothing in this file enforces it).

-- ---------------------------------------------------------------------------------------------
-- Lookup tables (A1): the values that will grow, each with the attributes the schema keys on.
-- Adding a value is an INSERT in a later rung, so `user_version` moves and an older build refuses
-- the file (`DowngradeRefused`). Nothing deletes or edits a lookup row.
-- ---------------------------------------------------------------------------------------------

-- A1: every kind of entity, and what the kind lets a row do.
--   linkable      the kind may be an end of a hand-made `link` and the target of a `[[title]]` (F1: a reading is neither).
--   may_be_top    a row of the kind may sit at the top level; 0 means it must have a home (A19: an event needs a calendar, a section a project).
--   may_be_unnamed  a row of the kind may have an empty (or blank) title; 0 means it needs one (K11: a note). A kind starts at 1 and
--                 its app lane sets 0 when its command says the kind needs a title.
--   may_be_named  a row of the kind may carry a non-empty title; 0 means the title must be empty (F1: a reading's is empty, the screen formats the figure).
CREATE TABLE entity_kind (
  code         TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*'),
  linkable     INTEGER NOT NULL CHECK (linkable IN (0,1)),
  may_be_top   INTEGER NOT NULL CHECK (may_be_top IN (0,1)),
  may_be_named INTEGER NOT NULL CHECK (may_be_named IN (0,1)),
  may_be_unnamed INTEGER NOT NULL CHECK (may_be_unnamed IN (0,1)),
  UNIQUE (code, may_be_top),
  UNIQUE (code, may_be_named),
  UNIQUE (code, may_be_unnamed)
) STRICT, WITHOUT ROWID;

-- A19: which kind may sit in which home, as `edge_shape` says which kinds an edge may join. The
-- composite key `(kind, parent_kind)` on `entity` is what enforces it.
CREATE TABLE home_shape (
  kind      TEXT NOT NULL REFERENCES entity_kind(code) ON DELETE NO ACTION,
  home_kind TEXT NOT NULL REFERENCES entity_kind(code) ON DELETE NO ACTION,
  PRIMARY KEY (kind, home_kind)
) STRICT, WITHOUT ROWID;
-- Child side of `home_kind`'s key: which kinds a holder of this kind may hold (the shape seed's own check).
CREATE INDEX home_shape_by_home ON home_shape(home_kind, kind);

-- A1: the kinds `concept` hosts. `takes_color` is the attribute the colour rule keys on (A1, J1).
CREATE TABLE concept_kind (
  code        TEXT PRIMARY KEY REFERENCES entity_kind(code) ON DELETE NO ACTION,
  takes_color INTEGER NOT NULL CHECK (takes_color IN (0,1)),
  UNIQUE (code, takes_color)
) STRICT, WITHOUT ROWID;

-- A1: the kinds `container` hosts.
CREATE TABLE container_kind (
  code TEXT PRIMARY KEY REFERENCES entity_kind(code) ON DELETE NO ACTION
) STRICT, WITHOUT ROWID;

-- A1, J1: the design palette, as plain keys (`list` in design/tokens.toml). A phone calendar's hue is a key too.
CREATE TABLE palette (
  key TEXT PRIMARY KEY CHECK (key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z]*')
) STRICT, WITHOUT ROWID;

-- A1, A10: the one-time arrivals that stamp `entity.arrived_via`.
CREATE TABLE arrival_via (
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*')
) STRICT, WITHOUT ROWID;

-- A1, A10, A11: the stores the engine follows (an `origin` is one of these only).
--   fills_kind  the kind of home a follow of this system fills (a calendar's calendar, a folder's folder,
--               the phone reminders' project, a statement's account); NULL: it fills none.
--   can_retire  stop-following retires the origin instead of deleting it (statements are not stopped).
--   on_device   the origin may name the device it reads (a statement is an account's, not a phone's, #1146).
CREATE TABLE origin_system (
  code       TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*'),
  fills_kind TEXT REFERENCES entity_kind(code) ON DELETE NO ACTION,
  can_retire INTEGER NOT NULL CHECK (can_retire IN (0,1)),
  on_device  INTEGER NOT NULL CHECK (on_device IN (0,1)),
  UNIQUE (code, fills_kind),
  UNIQUE (code, can_retire),
  UNIQUE (code, on_device)
) STRICT, WITHOUT ROWID;
-- Child side of `fills_kind`'s key.
CREATE INDEX origin_system_by_fills ON origin_system(fills_kind) WHERE fills_kind IS NOT NULL;

-- A1: which kind of record each followed system yields: the system/kind pairs of #1146 as rows.
CREATE TABLE source_shape (
  system      TEXT NOT NULL REFERENCES origin_system(code) ON DELETE NO ACTION,
  entity_kind TEXT NOT NULL REFERENCES entity_kind(code) ON DELETE NO ACTION,
  PRIMARY KEY (system, entity_kind)
) STRICT, WITHOUT ROWID;
-- Child side of `entity_kind`'s key.
CREATE INDEX source_shape_by_kind ON source_shape(entity_kind, system);

-- A1: what a derivative is. `has_out`: it is a file (a thumbnail, a preview, a poster) and not text.
CREATE TABLE derivative_variant (
  code    TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*'),
  has_out INTEGER NOT NULL CHECK (has_out IN (0,1)),
  UNIQUE (code, has_out)
) STRICT, WITHOUT ROWID;

CREATE TABLE contact_point_kind (   -- A1
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*')
) STRICT, WITHOUT ROWID;

CREATE TABLE photo_form (           -- A1
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*')
) STRICT, WITHOUT ROWID;

CREATE TABLE account_type (         -- A1, E5
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*')
) STRICT, WITHOUT ROWID;

CREATE TABLE locker_type (          -- A1: the 15 types; a 16th is a row, not a rebuild (I2)
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*')
) STRICT, WITHOUT ROWID;

CREATE TABLE message_refusal (      -- A1
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*')
) STRICT, WITHOUT ROWID;

CREATE TABLE message_notice (       -- A1
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*')
) STRICT, WITHOUT ROWID;

-- A1 (amendment 6): what a person row is, like `photo_form`.
CREATE TABLE person_form (
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*')
) STRICT, WITHOUT ROWID;

-- A1, G3 (amendment 1): what a person's date is. `single`: a person has at most one date of this kind
-- (a birthday); the row carries it, a composite key ties it to this lookup row, and a partial unique index
-- on `single = 1` does the rest, so nothing names `birthday`.
CREATE TABLE person_date_kind (
  code   TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*'),
  single INTEGER NOT NULL CHECK (single IN (0,1)),
  UNIQUE (code, single)
) STRICT, WITHOUT ROWID;

-- D2 (amendment 3): where a reminder may go, because only these have a time to fire at. `via_child`: the
-- reminder must name a dated child row (a person's date, a Locker date field) when 1, and none when 0.
CREATE TABLE reminder_target (
  kind      TEXT NOT NULL REFERENCES entity_kind(code) ON DELETE NO ACTION,
  via_child INTEGER NOT NULL CHECK (via_child IN (0,1)),
  PRIMARY KEY (kind, via_child)
) STRICT, WITHOUT ROWID;

-- A1, F1: the Health metrics. `cadence` says how a figure of the metric arrives: 'total' is one figure
-- per person and day (`measurement`), 'reading' one measurement taken at a moment (`reading`).
-- `has_value2`: the second figure a reading carries (blood pressure's diastolic).
CREATE TABLE health_metric (
  code       TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_0-9]*'),
  cadence    TEXT NOT NULL CHECK (cadence IN ('total','reading')),
  has_value2 INTEGER NOT NULL CHECK (has_value2 IN (0,1)),
  unit       TEXT NOT NULL CHECK (length(trim(unit)) > 0),
  CHECK (cadence = 'reading' OR has_value2 = 0),
  UNIQUE (code, cadence),
  UNIQUE (code, cadence, has_value2)
) STRICT, WITHOUT ROWID;

-- ---------------------------------------------------------------------------------------------
-- The kernel: the vault, the entity, its home, the graph.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE vault (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  self_id    TEXT NOT NULL,
  self_kind  TEXT GENERATED ALWAYS AS ('person') VIRTUAL,
  currency   TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  zone       TEXT CHECK (zone IS NULL OR length(trim(zone)) > 0),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  -- How many commits changed something a screen reads, and when the last did, on the vault's
  -- clock: a takeover compares the counter to tell which copy is ahead (#1146). Bumped by the
  -- commit guard, once per such commit; nothing else writes them.
  writes     INTEGER NOT NULL DEFAULT 0 CHECK (writes >= 0),
  written_at TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', written_at) IS written_at),
  FOREIGN KEY (self_id, self_kind) REFERENCES entity(id, kind) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- The supertype: one row per thing with a title and a trash. Every kind row hangs off it.
CREATE TABLE entity (
  -- A18: AUTOINCREMENT, so a row number is never reused. Both search indexes (a separate file, A15)
  -- and the spatial index use it as their row id; a reused number would show a purged item's words
  -- under a new item.
  n          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- A17: a canonical lowercase UUIDv7 (minted from the injected clock), or a seeded `kind:key` slug
  -- whose prefix is the row's own kind. The grammar is checked; that a slug names a seeded row is
  -- the founding's and the commands' (nothing else mints one).
  id         TEXT NOT NULL UNIQUE CHECK (
               (length(id) = 36 AND id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
               OR (instr(id, ':') > 1 AND length(id) > instr(id, ':') AND length(id) <= 96
                   AND id NOT GLOB '*[^a-z0-9_:.-]*' AND substr(id, 1, instr(id, ':') - 1) = kind)),
  kind       TEXT NOT NULL REFERENCES entity_kind(code) ON DELETE NO ACTION,
  title      TEXT NOT NULL,
  -- A19: ONE home column for every kind (a note's notebook, a document's folder, an event's calendar,
  -- a task's project, section or parent task, a section's project, a project's area, a concept's
  -- parent). `home_shape` says which kind may sit in which; `parent_kind` is the home's kind, kept
  -- beside it so a composite key can state the shape and a second one the home's identity. A holder
  -- (notebook, folder, project, calendar...) trashes what it holds (A13).
  parent_id   TEXT,
  parent_kind TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  deleted_at TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) IS deleted_at),
  purge_at   TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', purge_at) IS purge_at),
  -- A13: the holder whose trash took this row with it; NULL when it was trashed on its own. A restore
  -- of the holder brings back exactly the rows naming it, and no timestamp is compared.
  trashed_by TEXT REFERENCES entity(id) ON DELETE SET NULL,
  -- A14: starred, pinned and archived are instants on the row. Setting one stamps neither
  -- `updated_at` nor a revision (the commit triggers skip these columns).
  starred_at  TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', starred_at) IS starred_at),
  pinned_at   TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', pinned_at) IS pinned_at),
  archived_at TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', archived_at) IS archived_at),
  -- A10: a one-time import (a vCard, a CSV, an upload, a picked photo, a Markdown file, a scan) says
  -- where the row came from, in both columns or neither. `origin`/`source` hold followed stores only.
  arrived_via   TEXT REFERENCES arrival_via(code) ON DELETE NO ACTION,
  arrived_label TEXT CHECK (arrived_label IS NULL OR length(trim(arrived_label)) > 0),
  -- 1 when the row has no home, 1 when its title is non-empty, else NULL: the keys below check them
  -- against the kind's `may_be_top` and `may_be_named`.
  topless INTEGER GENERATED ALWAYS AS (CASE WHEN parent_id IS NULL THEN 1 END) VIRTUAL,
  named   INTEGER GENERATED ALWAYS AS (CASE WHEN title <> '' THEN 1 END) VIRTUAL,
  unnamed INTEGER GENERATED ALWAYS AS (CASE WHEN trim(title) = '' THEN 1 END) VIRTUAL,
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK ((parent_id IS NULL) = (parent_kind IS NULL)),
  CHECK ((deleted_at IS NULL) = (purge_at IS NULL)),
  CHECK (trashed_by IS NULL OR deleted_at IS NOT NULL),
  CHECK (trashed_by IS NULL OR trashed_by <> id),
  CHECK ((arrived_via IS NULL) = (arrived_label IS NULL)),
  UNIQUE (id, kind),
  FOREIGN KEY (parent_id, parent_kind) REFERENCES entity(id, kind) ON DELETE NO ACTION,
  FOREIGN KEY (kind, parent_kind) REFERENCES home_shape(kind, home_kind) ON DELETE NO ACTION,
  FOREIGN KEY (kind, topless) REFERENCES entity_kind(code, may_be_top) ON DELETE NO ACTION,
  FOREIGN KEY (kind, named) REFERENCES entity_kind(code, may_be_named) ON DELETE NO ACTION,
  FOREIGN KEY (kind, unnamed) REFERENCES entity_kind(code, may_be_unnamed) ON DELETE NO ACTION
) STRICT;
-- Reader: a kind's list by title (the People roster, Docs by name); also the child side of `kind`.
CREATE INDEX entity_by_title   ON entity(kind, deleted_at, title, id);
-- Reader: a kind's list by last edited.
CREATE INDEX entity_by_updated ON entity(kind, deleted_at, updated_at, id);
-- Reader: the case-insensitive title match a contact import and a followed record's match key make.
CREATE INDEX entity_by_title_nocase ON entity(kind, title COLLATE NOCASE, created_at, id) WHERE deleted_at IS NULL;
-- Reader: a window of one kind, newest made first (People roster, Docs drive, Tasks board).
CREATE INDEX entity_by_created ON entity(kind, created_at, id);
-- Reader: the launch pass that empties what is due (`purge_at <= ?`).
CREATE INDEX entity_purge      ON entity(purge_at) WHERE purge_at IS NOT NULL;
-- Reader: the trash, oldest first (`WHERE deleted_at IS NOT NULL ORDER BY deleted_at, n`).
CREATE INDEX entity_trashed    ON entity(deleted_at, n) WHERE deleted_at IS NOT NULL;
-- A19. Reader: what a holder holds ("notes in this notebook by last edited", a folder's documents, a
-- project's sections and tasks, a calendar's events); also the child side of the home key.
CREATE INDEX entity_by_home    ON entity(parent_id, kind, updated_at, id) WHERE parent_id IS NOT NULL;
-- A13. Reader: restoring or purging a holder finds the rows its trash took; also the child side of `trashed_by`.
CREATE INDEX entity_by_trashed_by ON entity(trashed_by) WHERE trashed_by IS NOT NULL;
-- A14. Readers: every app's Starred, Pinned and Archived shelf is one seek here.
CREATE INDEX entity_starred    ON entity(kind, starred_at, id)  WHERE starred_at IS NOT NULL;
CREATE INDEX entity_pinned     ON entity(kind, pinned_at, id)   WHERE pinned_at IS NOT NULL;
CREATE INDEX entity_archived   ON entity(kind, archived_at, id) WHERE archived_at IS NOT NULL;
-- A10. Child side of `arrived_via`'s key (nothing reads "everything from this import" by itself).
CREATE INDEX entity_by_arrival ON entity(arrived_via, n) WHERE arrived_via IS NOT NULL;
CREATE TRIGGER entity_kind_is_fixed BEFORE UPDATE OF id, kind ON entity
  BEGIN SELECT RAISE(ABORT, 'an entity''s id and kind never change'); END;
-- A19: the ONE loop check for every home. The home's own shape is the key's.
CREATE TRIGGER entity_home_is_acyclic BEFORE UPDATE OF parent_id ON entity
  WHEN new.parent_id IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'that home is already inside this item: a home has no loops')
     WHERE EXISTS (
       WITH RECURSIVE ancestors(id) AS (
         SELECT new.parent_id
         UNION
         SELECT e.parent_id FROM entity e JOIN ancestors a ON e.id = a.id WHERE e.parent_id IS NOT NULL)
       SELECT 1 FROM ancestors WHERE id = new.id);
  END;
-- A13, A19: nothing live sits inside a trash. A row is not made in, moved into or restored under a
-- home that is in the trash. A row restored out of a trashed home leaves it first (to the top level,
-- where its kind may sit); a holder that comes back brings back the rows that name it. (A holder's own trash updates its members
-- to deleted, which none of these catch.)
CREATE TRIGGER entity_not_born_in_a_trash BEFORE INSERT ON entity
  WHEN new.deleted_at IS NULL AND new.parent_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM entity h WHERE h.id = new.parent_id AND h.deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'that home is in the trash: restore it first'); END;
CREATE TRIGGER entity_not_moved_into_a_trash BEFORE UPDATE OF parent_id ON entity
  WHEN new.deleted_at IS NULL AND new.parent_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM entity h WHERE h.id = new.parent_id AND h.deleted_at IS NOT NULL)
  BEGIN SELECT RAISE(ABORT, 'that home is in the trash: restore it first'); END;
CREATE TRIGGER entity_not_restored_into_a_trash BEFORE UPDATE OF deleted_at ON entity
  WHEN old.deleted_at IS NOT NULL AND new.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM entity h WHERE h.deleted_at IS NOT NULL AND h.id = new.parent_id)
  BEGIN SELECT RAISE(ABORT, 'that home is in the trash: restore it first'); END;


-- A7: the plain graph relations only: contains, tagged, about, attached, with, related, depicts.
-- `edge_shape` is the relation vocabulary and says which kinds each joins; it is pruned of
-- everything another table now holds (`links` -> `link` A4; flags -> columns A14; attendee ->
-- `event_guest` A6; an event `about` a person -> `person_date` G3).
--   label_kind  the kind of the label a relation wears (`related`'s relation concept); NULL: no label.
--   ordered     the relation keeps a `position` (an album's photos, a list's people).
--   anchored    the edge may carry an `anchor` (where in a note's text it was made): only a note's `about`.
-- `*` means ANY LINKABLE KIND (`entity_kind.linkable`), the same attribute `link` and `mention` use, not
-- any kind: a reading, a chat, a container or a label is not at the end of a wildcard shape.
CREATE TABLE edge_shape (
  rel        TEXT NOT NULL CHECK (rel GLOB '[a-z]*' AND rel NOT GLOB '*[^a-z_]*'),
  from_kind  TEXT NOT NULL,
  to_kind    TEXT NOT NULL,
  label_kind TEXT,
  ordered    INTEGER NOT NULL DEFAULT 0 CHECK (ordered IN (0,1)),
  anchored   INTEGER NOT NULL DEFAULT 0 CHECK (anchored IN (0,1)),
  PRIMARY KEY (rel, from_kind, to_kind)
) STRICT, WITHOUT ROWID;

CREATE TABLE edge (
  from_id    TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  rel        TEXT NOT NULL,          -- A1: no CHECK; `edge_shape` is the vocabulary
  to_id      TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  label_id   TEXT REFERENCES entity(id) ON DELETE CASCADE,
  position   REAL,
  -- A5 (amended): where in a note the member made this `about`, set by hand and so an edge's, never the
  -- note-rebuilt `mention`'s. A3: a JSON object the vault defines carries "v":1.
  anchor     TEXT CHECK (anchor IS NULL OR (json_valid(anchor) AND json_type(anchor) = 'object' AND json_extract(anchor, '$.v') IS 1)),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (from_id <> to_id)
) STRICT;
-- Reader: an item's outgoing edges of one relation; the edge's identity (a duplicate is refused).
CREATE UNIQUE INDEX edge_key ON edge(from_id, rel, to_id, ifnull(label_id, ''));
-- Reader: an item's incoming edges (backlinks, "what is in this album", a tag's members).
CREATE INDEX edge_to    ON edge(to_id, rel, from_id);
-- Reader: an ordered relation in order (an album's photos, a list's people).
CREATE INDEX edge_order ON edge(from_id, rel, position) WHERE position IS NOT NULL;
-- Reader: who wears this relation label; also the child side of `label_id`.
CREATE INDEX edge_label ON edge(label_id) WHERE label_id IS NOT NULL;
-- An edge joins only the kinds a shape allows (`*` is any linkable kind), wears a label exactly when its
-- relation does, of the kind the shape names, is ordered only where the relation is, and carries an anchor
-- only where the shape says so. No vocabulary value is named here.
CREATE TRIGGER edge_has_a_shape BEFORE INSERT ON edge
  WHEN NOT EXISTS (
    SELECT 1 FROM edge_shape s
      JOIN entity f ON f.id = new.from_id JOIN entity_kind fk ON fk.code = f.kind
      JOIN entity t ON t.id = new.to_id   JOIN entity_kind tk ON tk.code = t.kind
      LEFT JOIN entity l ON l.id = new.label_id
     WHERE s.rel = new.rel
       AND (s.from_kind = f.kind OR (s.from_kind = '*' AND fk.linkable = 1))
       AND (s.to_kind   = t.kind OR (s.to_kind   = '*' AND tk.linkable = 1))
       AND s.label_kind IS l.kind AND (new.position IS NULL OR s.ordered = 1)
       AND (new.anchor IS NULL OR s.anchored = 1))
  BEGIN SELECT RAISE(ABORT, 'no edge of this relation joins these kinds, or it cannot carry this'); END;
CREATE TRIGGER edge_anchor_needs_an_anchored_shape BEFORE UPDATE OF anchor ON edge
  WHEN new.anchor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM edge_shape s
      JOIN entity f ON f.id = new.from_id JOIN entity_kind fk ON fk.code = f.kind
      JOIN entity t ON t.id = new.to_id   JOIN entity_kind tk ON tk.code = t.kind
     WHERE s.rel = new.rel AND s.anchored = 1
       AND (s.from_kind = f.kind OR (s.from_kind = '*' AND fk.linkable = 1))
       AND (s.to_kind   = t.kind OR (s.to_kind   = '*' AND tk.linkable = 1)))
  BEGIN SELECT RAISE(ABORT, 'this edge cannot carry an anchor'); END;
-- A place in a list is kept only by a relation that is ordered (the insert trigger says the same of a new edge).
CREATE TRIGGER edge_position_needs_an_ordered_shape BEFORE UPDATE OF position ON edge
  WHEN new.position IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM edge_shape s
      JOIN entity f ON f.id = new.from_id JOIN entity_kind fk ON fk.code = f.kind
      JOIN entity t ON t.id = new.to_id   JOIN entity_kind tk ON tk.code = t.kind
     WHERE s.rel = new.rel AND s.ordered = 1
       AND (s.from_kind = f.kind OR (s.from_kind = '*' AND fk.linkable = 1))
       AND (s.to_kind   = t.kind OR (s.to_kind   = '*' AND tk.linkable = 1)))
  BEGIN SELECT RAISE(ABORT, 'this edge cannot keep a place in a list'); END;
CREATE TRIGGER edge_ends_are_fixed BEFORE UPDATE OF from_id, rel, to_id, label_id ON edge
  BEGIN SELECT RAISE(ABORT, 'an edge''s ends never change; remove it and add another'); END;

-- A4, K1, K2: a hand-made link between two items of ANY linkable kind, Locker items included. The
-- member never sees a direction, so there is none: the lower id is `a`, a pair is one row whichever
-- end is asked about. A note's `[[title]]` links are `mention`, not this table.
CREATE TABLE link (
  a          TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  b          TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  PRIMARY KEY (a, b),
  CHECK (a < b)
) STRICT, WITHOUT ROWID;
-- Reader: an item's links read from the b side (`a` leads the key); also the child side of `b`.
CREATE INDEX link_by_b ON link(b, a);
-- F1: a reading (and every kind that is not an item) is not a link end. The kind says so.
CREATE TRIGGER link_ends_are_linkable BEFORE INSERT ON link
  WHEN EXISTS (SELECT 1 FROM entity e JOIN entity_kind k ON k.code = e.kind
                WHERE e.id IN (new.a, new.b) AND k.linkable = 0)
  BEGIN SELECT RAISE(ABORT, 'this kind of item cannot be linked'); END;
CREATE TRIGGER link_ends_are_fixed BEFORE UPDATE OF a, b ON link
  BEGIN SELECT RAISE(ABORT, 'a link''s ends never change; remove it and add another'); END;

-- A5, K6 (amended): the `[[title]]` links of a note, and nothing else. The note owns this table and
-- rebuilds it on every save, so it must not hold what the member set by hand: every `about`, anchored or
-- not, is an `edge` (an anchored one wears `edge.anchor`). `wikilink` holds the words; `to_id` is the item
-- it resolves to, or NULL while nothing carries the title (creating or renaming an item resolves the
-- waiting mentions; purging a target turns its mentions back into unresolved ones, as the note's text reads).
-- Key `(note_id, ordinal)`: `[[Alex]]` twice, or two items sharing a title, keep both.
CREATE TABLE mention (
  note_id  TEXT NOT NULL,
  ordinal  INTEGER NOT NULL CHECK (ordinal >= 0),
  wikilink TEXT NOT NULL CHECK (length(trim(wikilink)) > 0),
  to_id    TEXT REFERENCES entity(id) ON DELETE SET NULL,
  PRIMARY KEY (note_id, ordinal),
  FOREIGN KEY (note_id) REFERENCES note(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
-- Reader: backlinks ("mentioned in"), and the child side of `to_id`.
CREATE INDEX mention_by_target ON mention(to_id, note_id) WHERE to_id IS NOT NULL;
-- Reader: the mentions waiting for a title, found when an item is made or renamed.
CREATE INDEX mention_by_words  ON mention(wikilink COLLATE NOCASE) WHERE to_id IS NULL;
CREATE TRIGGER mention_target_is_linkable BEFORE INSERT ON mention
  WHEN new.to_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM entity e JOIN entity_kind k ON k.code = e.kind WHERE e.id = new.to_id AND k.linkable = 0)
  BEGIN SELECT RAISE(ABORT, 'a note cannot mention this kind of item'); END;
CREATE TRIGGER mention_target_is_linkable_on_resolve BEFORE UPDATE OF to_id ON mention
  WHEN new.to_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM entity e JOIN entity_kind k ON k.code = e.kind WHERE e.id = new.to_id AND k.linkable = 0)
  BEGIN SELECT RAISE(ABORT, 'a note cannot mention this kind of item'); END;

-- A1, J1: a label's kind row. Tags, categories, workout kinds, touch kinds, relations. The colour is a
-- palette key and only a kind that takes one may wear one; the hierarchy is `entity.parent_id` (A19).
CREATE TABLE concept (
  id      TEXT PRIMARY KEY,
  kind    TEXT NOT NULL REFERENCES concept_kind(code) ON DELETE NO ACTION,
  key     TEXT NOT NULL,
  color   TEXT REFERENCES palette(key) ON DELETE NO ACTION,
  colored INTEGER GENERATED ALWAYS AS (CASE WHEN color IS NOT NULL THEN 1 END) VIRTUAL,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (kind, colored) REFERENCES concept_kind(code, takes_color) ON DELETE NO ACTION,
  UNIQUE (kind, key)
) STRICT;
-- Child side of `color`'s key (a recolour of the palette is a rung; the reader is the colour picker's "in use").
CREATE INDEX concept_by_color ON concept(color) WHERE color IS NOT NULL;

-- A1, A19, J1: a holder's kind row: notebooks, folders, albums, lists, projects, sections, areas,
-- calendars. What it holds is `entity.parent_id` (a folder's documents) or `contains` edges (an
-- album's photos, a list's people: an item may be in several).
CREATE TABLE container (
  id       TEXT PRIMARY KEY,
  kind     TEXT NOT NULL REFERENCES container_kind(code) ON DELETE NO ACTION,
  color    TEXT REFERENCES palette(key) ON DELETE NO ACTION,
  -- A key of `design/icons.toml`; the command boundary says which keys a list or calendar may wear.
  icon     TEXT CHECK (icon IS NULL OR length(trim(icon)) > 0),
  cover    TEXT REFERENCES blob(hash) ON DELETE NO ACTION,
  position REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;
-- Reader: every container of a kind (Lists, Projects, Notebooks screens); also the child side of `kind`.
CREATE INDEX container_by_kind  ON container(kind, id);
-- Child side of `color`'s key.
CREATE INDEX container_by_color ON container(color) WHERE color IS NOT NULL;
-- Reader: the blob collector (a cover is a rented blob).
CREATE INDEX container_by_cover ON container(cover) WHERE cover IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Bytes: a blob is the vault's claim on bytes the content store names by the same hash.
-- ---------------------------------------------------------------------------------------------

-- `seq` numbers the claims in the order they were made: assigned at insert, never reused, so a
-- reader can keep "the last blob I saw" and ask for the ones after it.
CREATE TABLE blob (
  seq  INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK (size >= 0)
) STRICT;

-- A1: a variant is a lookup row; whether it is a file or text is its `has_out` attribute, and the
-- row's own shape says which it is (`has_out` is generated from `out`), so the key checks the pair.
CREATE TABLE derivative (
  blob       TEXT NOT NULL REFERENCES blob(hash) ON DELETE CASCADE,
  variant    TEXT NOT NULL,
  out        TEXT REFERENCES blob(hash) ON DELETE NO ACTION,
  media_type TEXT,
  text       TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  has_out    INTEGER GENERATED ALWAYS AS (out IS NOT NULL) VIRTUAL,
  PRIMARY KEY (blob, variant),
  FOREIGN KEY (variant, has_out) REFERENCES derivative_variant(code, has_out) ON DELETE NO ACTION,
  CHECK ((out IS NULL) = (media_type IS NULL)),
  CHECK ((out IS NULL) = (text IS NOT NULL))
) STRICT;
-- Reader: the blob collector (a derivative file is a rented blob).
CREATE INDEX derivative_by_out ON derivative(out) WHERE out IS NOT NULL;
-- Reader: what still lacks a variant (the idle pass that makes thumbnails and extracts text); also the child side of `variant`.
CREATE INDEX derivative_by_variant ON derivative(variant, blob);

-- ---------------------------------------------------------------------------------------------
-- Following: where a row came from. The followed stores only (A10): a one-time import is two
-- columns on `entity`.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE origin (
  id         TEXT PRIMARY KEY,
  system     TEXT NOT NULL REFERENCES origin_system(code) ON DELETE NO ACTION,
  ref        TEXT NOT NULL CHECK (length(trim(ref)) > 0),
  label      TEXT NOT NULL CHECK (length(trim(label)) > 0),
  device_id  TEXT CHECK (device_id IS NULL OR length(trim(device_id)) > 0),
  -- The home a follow filled, of the kind its system makes (`origin_system.fills_kind`).
  fills      TEXT,
  fills_kind TEXT,
  -- Where the last pass of a followed store stopped (its change token). Cleared when the follow stops.
  cursor     TEXT,
  config     TEXT CHECK (config IS NULL OR (json_valid(config) AND json_type(config) = 'object' AND json_extract(config, '$.v') IS 1)),  -- A3
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  -- Stop following RETIRES an origin instead of deleting it: it keeps its `fills` and its sources,
  -- so following the same `ref` again finds them. A retired origin is followed by nobody.
  retired_at TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', retired_at) IS retired_at),
  -- 1 when retired / when it names a device, else NULL: keys into the system's `can_retire` / `on_device`.
  retired INTEGER GENERATED ALWAYS AS (CASE WHEN retired_at IS NOT NULL THEN 1 END) VIRTUAL,
  bound   INTEGER GENERATED ALWAYS AS (CASE WHEN device_id  IS NOT NULL THEN 1 END) VIRTUAL,
  UNIQUE (system, ref),
  UNIQUE (id, system),
  CHECK ((fills IS NULL) = (fills_kind IS NULL)),
  -- K9: a cursor is the word of the install that read (`device_id`), and a retired origin holds none.
  CHECK (cursor IS NULL OR device_id IS NOT NULL),
  CHECK (cursor IS NULL OR retired_at IS NULL),
  FOREIGN KEY (system, fills_kind) REFERENCES origin_system(code, fills_kind) ON DELETE NO ACTION,
  FOREIGN KEY (system, retired)    REFERENCES origin_system(code, can_retire) ON DELETE NO ACTION,
  FOREIGN KEY (system, bound)      REFERENCES origin_system(code, on_device)  ON DELETE NO ACTION,
  FOREIGN KEY (fills, fills_kind)  REFERENCES entity(id, kind) ON DELETE NO ACTION
) STRICT;
-- One home is filled by one origin, whatever its system (a statement origin per account, #1146; a
-- second follow of the same calendar finds the first). Reader: finding a follow by its home; the child side of `fills`.
CREATE UNIQUE INDEX origin_one_per_home ON origin(fills) WHERE fills IS NOT NULL;

-- A9: a record may be stated by several sources (a merged person keeps every one it had). Each
-- source's own `stated` is what the field-by-field three-way merge compares against.
CREATE TABLE source (
  id          TEXT PRIMARY KEY,
  origin_id   TEXT NOT NULL,
  system      TEXT NOT NULL,
  external_id TEXT NOT NULL CHECK (length(trim(external_id)) > 0),
  device_id   TEXT CHECK (device_id IS NULL OR length(trim(device_id)) > 0),
  entity_id   TEXT,
  entity_kind TEXT,
  -- A copy of the outside system's record, versioned by its origin system (A3: no "v").
  stated      TEXT NOT NULL CHECK (json_valid(stated)),
  stated_title TEXT,
  seen_at     TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', seen_at) IS seen_at),
  -- When the follower trashed the row because its record left a complete read: the trash it may
  -- undo if the record returns and the member has not touched the row since (#1146).
  gone_at     TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', gone_at) IS gone_at),
  bound       INTEGER GENERATED ALWAYS AS (CASE WHEN device_id IS NOT NULL THEN 1 END) VIRTUAL,
  FOREIGN KEY (origin_id, system) REFERENCES origin(id, system) ON DELETE NO ACTION,
  FOREIGN KEY (system, bound)     REFERENCES origin_system(code, on_device) ON DELETE NO ACTION,
  FOREIGN KEY (system, entity_kind) REFERENCES source_shape(system, entity_kind) ON DELETE NO ACTION,
  FOREIGN KEY (entity_id, entity_kind) REFERENCES entity(id, kind) ON DELETE SET NULL,
  CHECK ((entity_id IS NULL) = (entity_kind IS NULL))
) STRICT;
-- Reader: the follower's lookup of a record it already holds; also the child side of `origin_id`.
CREATE UNIQUE INDEX source_key    ON source(origin_id, external_id, ifnull(device_id, ''));
-- A9 (no longer unique). Reader: an item's sources (the merge, "Phone says X"); the child side of `entity_id`.
CREATE INDEX source_by_entity ON source(entity_id) WHERE entity_id IS NOT NULL;
-- Reader: a system's lines, newest seen first (the last statement import); also the child side of `system`.
CREATE INDEX source_by_seen ON source(system, seen_at, id);
CREATE TRIGGER source_tombstone_is_final BEFORE UPDATE OF entity_id ON source
  WHEN old.entity_id IS NULL AND new.entity_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a purged row''s source never takes a row again'); END;
-- K9: the owner is nobody's record: no source ever names the vault's own person.
CREATE TRIGGER source_never_names_the_owner BEFORE INSERT ON source
  WHEN new.entity_id IS NOT NULL AND new.entity_id IS (SELECT self_id FROM vault)
  BEGIN SELECT RAISE(ABORT, 'a source never names the vault''s owner'); END;
CREATE TRIGGER source_never_moves_to_the_owner BEFORE UPDATE OF entity_id ON source
  WHEN new.entity_id IS NOT NULL AND new.entity_id IS (SELECT self_id FROM vault)
  BEGIN SELECT RAISE(ABORT, 'a source never names the vault''s owner'); END;

-- ---------------------------------------------------------------------------------------------
-- History, and the keys of acts already run.
-- ---------------------------------------------------------------------------------------------

-- Every record's history: one row per commit that changed an entity, holding its state as it was
-- BEFORE that commit. `state` is canonical JSON of the title, the kind row and its owned children
-- (B1: `budget`, `rule`, `occurrence` and edges are not part of a host's snapshot), minus the
-- columns `history::OMITTED` names. A hash never sits in `state`: every blob a version names is a
-- `revision_blob` row (B3). `history::settle` writes these at commit.
CREATE TABLE revision (
  entity_id  TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL CHECK (seq >= 1),
  at         TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', at) IS at),
  -- B4: who made the change. `cause` stays as a diagnostic and is never parsed.
  actor      TEXT NOT NULL CHECK (actor IN ('member','assistant','store')),
  -- B4: for a store, the origin it followed.
  origin_id  TEXT REFERENCES origin(id) ON DELETE NO ACTION,
  cause      TEXT NOT NULL DEFAULT '',
  -- A3: the version of the snapshot's grammar this row was written in.
  shape      INTEGER NOT NULL CHECK (shape >= 1),
  state      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state)),
  -- A note's words live in a cell of their own so `fill_body` can read the nearest newer version that kept one.
  body       TEXT,
  -- Whether a quiet save (an editor's autosave) made this version, and when its session last folded
  -- another in (NULL: never). A quiet save of the same command by the same actor within ten idle
  -- minutes, and within an hour of `at`, writes no version.
  autosave   INTEGER NOT NULL DEFAULT 0 CHECK (autosave IN (0, 1)),
  touched_at TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', touched_at) IS touched_at),
  CHECK ((actor = 'store') = (origin_id IS NOT NULL)),
  PRIMARY KEY (entity_id, seq)
) STRICT;
-- Reader: "what did this store change" and the child side of `origin_id`.
CREATE INDEX revision_by_origin ON revision(origin_id) WHERE origin_id IS NOT NULL;
-- Only `touched_at` moves, when a quiet save folds into the version's session; what it holds never.
-- B2: there is NO `revision_is_kept` trigger and v0 deletes no revision row: `fill_body` fills a
-- version that elided its body from the nearest newer one that kept it, so a deletion would silently
-- rewrite older versions. Any future thinning copies the body back and rebuilds `search_past` first.
CREATE TRIGGER revision_is_history
  BEFORE UPDATE OF entity_id, seq, at, actor, origin_id, cause, shape, state, body, autosave ON revision
  BEGIN SELECT RAISE(ABORT, 'a revision is history'); END;

-- B3: EVERY blob an earlier version names: a document's bytes, a Locker sealed file (I7), a note
-- asset (H2), an avatar, a cover, a Live Photo's motion clip. `slot` says which column or child it
-- was (`blob`, `avatar`, `cover`, `motion`, `field:<id>`, `asset:<id>`); `media_type` is kept for
-- the document-bytes slot. No hash is stored inside `state`, so the blob collector and the backup
-- read this table and `PRAGMA foreign_key_list` alone.
CREATE TABLE revision_blob (
  entity_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  slot       TEXT NOT NULL CHECK (length(trim(slot)) > 0),
  blob       TEXT NOT NULL REFERENCES blob(hash) ON DELETE NO ACTION,
  media_type TEXT CHECK (media_type IS NULL OR length(trim(media_type)) > 0),
  PRIMARY KEY (entity_id, seq, slot),
  FOREIGN KEY (entity_id, seq) REFERENCES revision(entity_id, seq) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
-- Reader: the blob collector and the backup's `RENTERS` (is this blob named by an earlier version?).
CREATE INDEX revision_blob_by_blob ON revision_blob(blob);
CREATE TRIGGER revision_blob_is_history BEFORE UPDATE ON revision_blob
  BEGIN SELECT RAISE(ABORT, 'a revision is history'); END;

-- An act's key and a digest of what it asked, written in the commit it names, so a delivery the
-- phone repeats after a restart is answered `replayed` and runs nothing (#1146). Both columns are
-- opaque. The commit that writes a key forgets the keys older than 30 days.
CREATE TABLE action_key (
  key   TEXT PRIMARY KEY,
  asked TEXT NOT NULL,
  at    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', at) IS at)
) STRICT, WITHOUT ROWID;
-- Reader: the prune of keys older than 30 days.
CREATE INDEX action_key_by_at ON action_key(at);

-- A15: the queue of what the index file owes, written in the SAME commit as the change. WAL gives no
-- atomic transaction across two files, so there is no boolean "stale" stamp; this is the catch-up
-- (the idle pass drains it and a rebuild empties it).
--   n      the owed entity's `entity.n`. No foreign key on purpose: a purged entity's rows must still be
--          removed from the index, and A18 means the number is never given to another item.
--   after  NULL: re-index (or remove) the entity itself. Not NULL: a label whose title is part of its
--          members' text; its members are owed in id order after this id (a label of thousands would
--          hold the vault for seconds, so a commit writes the first piece and leaves the rest here, #1146).
CREATE TABLE search_owed (
  n     INTEGER PRIMARY KEY,
  after TEXT
) STRICT;

-- ---------------------------------------------------------------------------------------------
-- The kinds. Every kind row is its entity's own: `kind` is a generated constant, and the
-- composite foreign key is what keeps a person row from naming a note.
-- ---------------------------------------------------------------------------------------------

-- G1, G2: a person. `org` is vCard ORG beside `role` (TITLE). No `person.title` (it would clash with
-- `entity.title`). The birthday and every other date are `person_date` (G3).
CREATE TABLE person (
  id           TEXT PRIMARY KEY,
  kind         TEXT GENERATED ALWAYS AS ('person') VIRTUAL,
  form         TEXT NOT NULL DEFAULT 'person' REFERENCES person_form(code) ON DELETE NO ACTION,   -- A1 (amendment 6)
  sort_name    TEXT,
  given        TEXT,
  family       TEXT,
  phonetic     TEXT,
  nickname     TEXT,
  role         TEXT,
  org          TEXT,
  met          TEXT,
  avatar       TEXT REFERENCES blob(hash) ON DELETE NO ACTION,
  cadence_days INTEGER CHECK (cadence_days IS NULL OR cadence_days > 0),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;
-- Reader: People's filter by form (people, organisations, groups, pets); the child side of `form`.
CREATE INDEX person_by_form ON person(form, id);
-- Reader: the blob collector (an avatar is a rented blob).
CREATE INDEX person_by_avatar ON person(avatar) WHERE avatar IS NOT NULL;

-- G3: EVERY date of a person, the birthday included; anniversaries are no longer yearly events
-- `about` the person. `date` is a full date or a yearless vCard `--MM-DD`. Each row has its own id
-- so a reminder can name it (D2). Calendar shows them derived from these rows; a reminder is optional.
-- `kind` is a lookup the app translates (amendment 1); `label` is only the member's own words, absent
-- when they added none. `single` is the kind's attribute copied onto the row so a composite key holds it
-- and a partial unique index keeps one date per person of a kind that says so.
CREATE TABLE person_date (
  id        TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  single    INTEGER NOT NULL CHECK (single IN (0,1)),
  label     TEXT CHECK (label IS NULL OR length(trim(label)) > 0),
  date      TEXT NOT NULL CHECK (
              date(date) IS date
              OR (length(date) = 7 AND substr(date, 1, 2) = '--'
                  AND date('2000-' || substr(date, 3)) IS '2000-' || substr(date, 3))),
  position  REAL NOT NULL DEFAULT 0,
  UNIQUE (id, person_id),
  FOREIGN KEY (kind, single) REFERENCES person_date_kind(code, single) ON DELETE NO ACTION
) STRICT;
-- Reader: a person's dates; the child side of `person_id`.
CREATE INDEX person_date_by_person ON person_date(person_id, position, id);
-- Reader: Calendar's day and month views ("whose date is on 03-14"), whatever the year or none.
CREATE INDEX person_date_by_day ON person_date(substr(date, -5), person_id);
-- Reader: "everyone's birthdays"; the child side of `kind`.
CREATE INDEX person_date_by_kind ON person_date(kind, person_id);
-- One date per person of a kind that is `single` (a birthday). Reader: the person's own birthday.
CREATE UNIQUE INDEX person_date_one_of_a_single_kind ON person_date(person_id, kind) WHERE single = 1;

CREATE TABLE contact_point (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL REFERENCES contact_point_kind(code) ON DELETE NO ACTION,   -- A1
  value      TEXT NOT NULL CHECK (length(trim(value)) > 0),
  normalized TEXT NOT NULL,
  label      TEXT,
  preferred  INTEGER NOT NULL DEFAULT 0 CHECK (preferred IN (0,1)),
  position   REAL NOT NULL,
  UNIQUE (person_id, kind, normalized)
) STRICT;
-- Reader: a guest's address finds the person who has it (`person_of_email`); the child side of `kind`.
CREATE INDEX contact_point_by_value ON contact_point(kind, normalized, person_id);
CREATE UNIQUE INDEX contact_point_preferred ON contact_point(person_id, kind) WHERE preferred = 1;

CREATE TABLE place (
  id       TEXT PRIMARY KEY,
  kind     TEXT GENERATED ALWAYS AS ('place') VIRTUAL,
  lat      REAL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lon      REAL CHECK (lon IS NULL OR lon BETWEEN -180 AND 180),
  address  TEXT,
  locality TEXT,
  zone     TEXT,
  CHECK ((lat IS NULL) = (lon IS NULL)),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

-- D1, D5, L3, L4. `timing` says how `starts`/`ends` read (A2): a zoned time is an instant, a floating
-- one a wall clock to the minute, an all-day one a date; `zone` is set exactly when zoned. The
-- calendar is the event's HOME (`entity.parent_id`, required by `entity_kind.may_be_top`).
-- `location` is free text; `place_id` is a real place the member has (D5). Overlapping busy events
-- are allowed (L3): no rule here. "This and following" splits the series (L4): the old series' `rule`
-- ends at the split day and a new `event` starts there; nothing links the halves.
CREATE TABLE event (
  id             TEXT PRIMARY KEY,
  kind           TEXT GENERATED ALWAYS AS ('event') VIRTUAL,
  starts         TEXT NOT NULL,
  ends           TEXT,
  timing         TEXT NOT NULL CHECK (timing IN ('zoned','floating','all-day')),
  zone           TEXT CHECK (zone IS NULL OR length(trim(zone)) > 0),
  rule           TEXT,
  rule_supported INTEGER NOT NULL DEFAULT 1 CHECK (rule_supported IN (0,1)),
  status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','tentative','cancelled')),
  busy           INTEGER NOT NULL DEFAULT 1 CHECK (busy IN (0,1)),
  location       TEXT CHECK (location IS NULL OR length(trim(location)) > 0),
  place_id       TEXT REFERENCES place(id) ON DELETE NO ACTION,
  url            TEXT,
  -- Minutes of travel the member allows before it starts.
  travel_min     INTEGER CHECK (travel_min IS NULL OR travel_min >= 0),
  description    TEXT,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  UNIQUE (id, timing),
  CHECK ((timing = 'zoned') = (zone IS NOT NULL)),
  CHECK (ends IS NULL OR ends >= starts),
  CHECK (CASE timing WHEN 'zoned' THEN strftime('%Y-%m-%dT%H:%M:%fZ', starts) IS starts WHEN 'floating' THEN strftime('%Y-%m-%dT%H:%M', starts) IS starts ELSE date(starts) IS starts END),
  CHECK (ends IS NULL OR CASE timing WHEN 'zoned' THEN strftime('%Y-%m-%dT%H:%M:%fZ', ends) IS ends WHEN 'floating' THEN strftime('%Y-%m-%dT%H:%M', ends) IS ends ELSE date(ends) IS ends END)
) STRICT;
-- Reader: a day or a week of events in start order.
CREATE INDEX event_by_start ON event(starts, id);
-- Reader: the series, in start order: the expander's read of every repeating event.
CREATE INDEX event_by_rule  ON event(starts, id) WHERE rule IS NOT NULL;
-- Reader: "events at this place"; the child side of `place_id`.
CREATE INDEX event_by_place ON event(place_id) WHERE place_id IS NOT NULL;

-- A6: who an event invited, whether or not they are in People. An address is the guest's identity on
-- the event; `person_id` is the person it resolves to (re-pointed by `person.merge`, A8, and set NULL
-- when that person is purged: the guest still exists).
CREATE TABLE event_guest (
  event_id  TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  address   TEXT NOT NULL CHECK (length(trim(address)) > 0),
  person_id TEXT REFERENCES person(id) ON DELETE SET NULL,
  name      TEXT CHECK (name IS NULL OR length(trim(name)) > 0),
  role      TEXT NOT NULL DEFAULT 'required' CHECK (role IN ('required','optional','non-participant')),
  status    TEXT NOT NULL DEFAULT 'needs-action' CHECK (status IN ('needs-action','accepted','declined','tentative')),
  organizer INTEGER NOT NULL DEFAULT 0 CHECK (organizer IN (0,1)),
  PRIMARY KEY (event_id, address)
) STRICT, WITHOUT ROWID;
-- Reader: a person's invitations ("events with Alex"), `person.merge`'s re-point; the child side of `person_id`.
CREATE INDEX event_guest_by_person ON event_guest(person_id, event_id) WHERE person_id IS NOT NULL;
-- One organizer per event.
CREATE UNIQUE INDEX event_guest_one_organizer ON event_guest(event_id) WHERE organizer = 1;

-- D2, G3, I8: THE ONE NOTIFICATION RULE. A reminder has its own id, belongs to an entity and may name a
-- dated child row of that entity: a `person_date` or a Locker `date` field. `alert` (the index file) is
-- keyed on this id. The old key (entity, offset) would collide when one person has two dates with the
-- same lead time. The composite keys make a named child belong to the entity, and the Locker one a `date`
-- field (plain, never sealed: a notification names the item and the field's label, nothing else, I8).
-- Amendment 3: a reminder goes only where there is a time to fire at. It carries its entity's kind
-- (a key into `entity(id, kind)`) and `via_child` (whether it names a child row), and `reminder_target`
-- says which pairs exist: an event or a task names no child, a person or a Locker item must name one.
CREATE TABLE reminder (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  date_id     TEXT,
  field_id    TEXT,
  offset_min  INTEGER NOT NULL CHECK (offset_min >= 0),
  via_child   INTEGER GENERATED ALWAYS AS (date_id IS NOT NULL OR field_id IS NOT NULL) VIRTUAL,
  dated_field INTEGER GENERATED ALWAYS AS (CASE WHEN field_id IS NOT NULL THEN 1 END) VIRTUAL,
  CHECK (date_id IS NULL OR field_id IS NULL),
  FOREIGN KEY (entity_id, entity_kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (entity_kind, via_child) REFERENCES reminder_target(kind, via_child) ON DELETE NO ACTION,
  FOREIGN KEY (date_id, entity_id)  REFERENCES person_date(id, person_id)    ON DELETE CASCADE,
  FOREIGN KEY (field_id, entity_id) REFERENCES locker_item_field(id, item_id) ON DELETE CASCADE,
  FOREIGN KEY (field_id, dated_field) REFERENCES locker_item_field(id, dated) ON DELETE CASCADE
) STRICT;
-- A lead time once per target. Reader: an item's reminders; the child side of `entity_id`.
CREATE UNIQUE INDEX reminder_key ON reminder(entity_id, ifnull(date_id, ''), ifnull(field_id, ''), offset_min);
-- Reader: the alert refresh of one kind of item (every event's, every task's); the child side of `entity_kind`.
CREATE INDEX reminder_by_kind ON reminder(entity_kind, entity_id);
-- Child sides of `date_id` and `field_id`; readers: a date's or a field's reminders.
CREATE INDEX reminder_by_date  ON reminder(date_id)  WHERE date_id  IS NOT NULL;
CREATE INDEX reminder_by_field ON reminder(field_id) WHERE field_id IS NOT NULL;

-- One-day overrides of a series (L4: "this and following" splits the series, so there is no scope
-- and no future override). `series_timing` is the series' own, held by a key so `original_start` can
-- be checked exactly (A2). `timing` NULL is the series' timing; a zoned day of another timing names
-- its zone.
CREATE TABLE occurrence (
  series_id      TEXT NOT NULL,
  series_timing  TEXT NOT NULL,
  original_start TEXT NOT NULL,
  cancelled      INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
  starts         TEXT,
  ends           TEXT,
  timing         TEXT CHECK (timing IS NULL OR timing IN ('zoned','floating','all-day')),
  zone           TEXT CHECK (zone IS NULL OR length(trim(zone)) > 0),
  title          TEXT,
  description    TEXT,
  -- This day's own link, place and location; NULL is the series'. Guests and reminders stay the series'.
  url            TEXT,
  location       TEXT CHECK (location IS NULL OR length(trim(location)) > 0),
  place_id       TEXT REFERENCES place(id) ON DELETE NO ACTION,
  PRIMARY KEY (series_id, original_start),
  FOREIGN KEY (series_id, series_timing) REFERENCES event(id, timing) ON DELETE CASCADE,
  CHECK ((timing IS 'zoned') = (zone IS NOT NULL)),
  CHECK (CASE series_timing WHEN 'zoned' THEN strftime('%Y-%m-%dT%H:%M:%fZ', original_start) IS original_start WHEN 'floating' THEN strftime('%Y-%m-%dT%H:%M', original_start) IS original_start ELSE date(original_start) IS original_start END),
  CHECK (starts IS NULL OR CASE ifnull(timing, series_timing) WHEN 'zoned' THEN strftime('%Y-%m-%dT%H:%M:%fZ', starts) IS starts WHEN 'floating' THEN strftime('%Y-%m-%dT%H:%M', starts) IS starts ELSE date(starts) IS starts END),
  CHECK (ends   IS NULL OR CASE ifnull(timing, series_timing) WHEN 'zoned' THEN strftime('%Y-%m-%dT%H:%M:%fZ', ends) IS ends   WHEN 'floating' THEN strftime('%Y-%m-%dT%H:%M', ends) IS ends   ELSE date(ends) IS ends   END)
) STRICT;
-- Reader: "this day's place"; the child side of `place_id`.
CREATE INDEX occurrence_by_place ON occurrence(place_id) WHERE place_id IS NOT NULL;

-- D1, D2, D3, D4, C1. A task's home (`entity.parent_id`) is a project, a section or its parent task.
-- `due` is nullable, so its timing is too: `due_timing` is set exactly when `due` is and `zone`
-- exactly when it is zoned; `scheduled_on` (the day the member plans it) is a bare date. Alerts are
-- `reminder` rows (`remind_before_min` is gone).
CREATE TABLE task (
  id            TEXT PRIMARY KEY,
  kind          TEXT GENERATED ALWAYS AS ('task') VIRTUAL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  priority      INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 9),
  due           TEXT,
  due_timing    TEXT CHECK (due_timing IS NULL OR due_timing IN ('zoned','floating','all-day')),
  zone          TEXT CHECK (zone IS NULL OR length(trim(zone)) > 0),
  scheduled_on  TEXT CHECK (date(scheduled_on) IS scheduled_on),
  done_at       TEXT CHECK ((status = 'done') = (done_at IS NOT NULL) AND strftime('%Y-%m-%dT%H:%M:%fZ', done_at) IS done_at),
  rule          TEXT,
  anchor        TEXT NOT NULL DEFAULT 'scheduled' CHECK (anchor IN ('scheduled','completion')),
  -- D4: a stable id the members of a repeating series share, minted when the series begins and
  -- pointing at no row, so purging the first task no longer cuts the series.
  series_id     TEXT CHECK (series_id IS NULL OR (length(series_id) = 36 AND series_id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-7[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
  -- A SNOOZE MOVES THE ALERT, NOT THE DUE (#1188, NA5): the instant the member asked to be reminded
  -- again. While set it is the task's one alert; an edit of the due, a lead or the rule clears it, and so does finishing.
  snoozed_until TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', snoozed_until) IS snoozed_until AND (snoozed_until IS NULL OR status = 'open')),
  url           TEXT CHECK (url IS NULL OR length(trim(url)) > 0),
  effort_min    INTEGER CHECK (effort_min IS NULL OR effort_min > 0),
  description   TEXT,
  position      REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  CHECK ((due IS NULL) = (due_timing IS NULL)),
  CHECK ((due_timing IS 'zoned') = (zone IS NOT NULL)),
  CHECK (due IS NULL OR CASE due_timing WHEN 'zoned' THEN strftime('%Y-%m-%dT%H:%M:%fZ', due) IS due WHEN 'floating' THEN strftime('%Y-%m-%dT%H:%M', due) IS due ELSE date(due) IS due END),
  CHECK (rule IS NULL OR due IS NOT NULL)
) STRICT;
-- Readers: Today/Upcoming (open tasks by due), the Done shelf, the planned day, a repeating series.
CREATE INDEX task_by_due       ON task(status, due, id);
CREATE INDEX task_by_done      ON task(status, done_at, id);
CREATE INDEX task_by_scheduled ON task(scheduled_on, id) WHERE scheduled_on IS NOT NULL;
CREATE INDEX task_by_series    ON task(series_id, due, id) WHERE series_id IS NOT NULL;

-- L1: a workout is its own kind (no longer an `activity` with a `type_kind`): its figures and its
-- notes. L6: a followed workout can be edited field by field (the follower's three-way merge keeps
-- the member's figure and shows "Phone says X"); nothing here refuses it.
CREATE TABLE workout (
  id          TEXT PRIMARY KEY,
  kind        TEXT GENERATED ALWAYS AS ('workout') VIRTUAL,
  type_id     TEXT NOT NULL,
  type_kind   TEXT GENERATED ALWAYS AS ('workout_kind') VIRTUAL,
  starts      TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', starts) IS starts),
  ends        TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', ends) IS ends AND (ends IS NULL OR ends >= starts)),
  place_id    TEXT REFERENCES place(id) ON DELETE NO ACTION,
  recorded_by TEXT,
  moving_s    INTEGER CHECK (moving_s IS NULL OR moving_s > 0),
  distance_m  REAL CHECK (distance_m IS NULL OR distance_m >= 0),
  energy_kcal REAL CHECK (energy_kcal IS NULL OR energy_kcal >= 0),
  heart_bpm   INTEGER CHECK (heart_bpm IS NULL OR heart_bpm > 0),
  climb_m     REAL CHECK (climb_m IS NULL OR climb_m >= 0),
  notes       TEXT,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (type_id, type_kind) REFERENCES entity(id, kind) ON DELETE NO ACTION
) STRICT;
-- Readers: Health's list and "what happened on this day" (one read over workouts and touches).
CREATE INDEX workout_by_start ON workout(starts, id);
CREATE INDEX workout_by_type  ON workout(type_id);
CREATE INDEX workout_by_place ON workout(place_id) WHERE place_id IS NOT NULL;

-- L1: People's "log a touch" (a call, a message, a meet-up) is its own kind, linked `with` the people
-- in it, and its words are its own `notes` (no spawned note `about` the person). Its kind
-- is a touch_kind concept; the seeded `note` kind is gone.
CREATE TABLE touch (
  id        TEXT PRIMARY KEY,
  kind      TEXT GENERATED ALWAYS AS ('touch') VIRTUAL,
  type_id   TEXT NOT NULL,
  type_kind TEXT GENERATED ALWAYS AS ('touch_kind') VIRTUAL,
  starts    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', starts) IS starts),
  ends      TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', ends) IS ends AND (ends IS NULL OR ends >= starts)),
  place_id  TEXT REFERENCES place(id) ON DELETE NO ACTION,
  notes     TEXT,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (type_id, type_kind) REFERENCES entity(id, kind) ON DELETE NO ACTION
) STRICT;
-- Readers: "last contacted" (computed at read from the touches), the day view.
CREATE INDEX touch_by_start ON touch(starts, id);
CREATE INDEX touch_by_type  ON touch(type_id);
CREATE INDEX touch_by_place ON touch(place_id) WHERE place_id IS NOT NULL;

-- A12, F1: one figure per person, day and metric (steps, sleep, energy, resting/lowest/highest heart
-- rate). A day's total is not an item: no trash, no title, a correction overwrites it. `origin_id`
-- says which health store it came from (NULL: typed by hand). A continuous series is never stored
-- row by row; it arrives as that day's totals.
CREATE TABLE measurement (
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  day       TEXT NOT NULL CHECK (date(day) IS day),
  metric    TEXT NOT NULL,
  cadence   TEXT GENERATED ALWAYS AS ('total') VIRTUAL,
  value     REAL NOT NULL CHECK (value >= 0),
  -- Plain foreign key (amendment 7): that it is a health store is the writer's, not named here.
  origin_id TEXT REFERENCES origin(id) ON DELETE NO ACTION,
  PRIMARY KEY (person_id, day, metric),
  FOREIGN KEY (metric, cadence) REFERENCES health_metric(code, cadence) ON DELETE NO ACTION
) STRICT, WITHOUT ROWID;
-- Reader: one metric across days (a trend); the child side of `metric`.
CREATE INDEX measurement_by_metric ON measurement(metric, person_id, day);
-- Child side of `origin_id` (what a health store wrote).
CREATE INDEX measurement_by_origin ON measurement(origin_id) WHERE origin_id IS NOT NULL;

-- F1, A12, L6: a reading is one measurement taken at a moment (weight, blood pressure, glucose,
-- temperature): an ENTITY kind, so it has trash, restore, Delete forever and earlier versions, and a
-- followed one follows its phone store through `source` (the `health` system yields it). Guards, so
-- thousands of readings do not flood the vault: its `entity.title` is empty (the kind's
-- `may_be_named` is 0, so the key refuses a title) and the screen formats the figure in the
-- member's units; it is not a link end (`entity_kind.linkable`), not a `[[...]]` target, not in search
-- (the writer never queues it); `value` has no `>= 0` check (a difference can be negative).
CREATE TABLE reading (
  id         TEXT PRIMARY KEY,
  kind       TEXT GENERATED ALWAYS AS ('reading') VIRTUAL,
  person_id  TEXT NOT NULL REFERENCES person(id) ON DELETE NO ACTION,
  metric     TEXT NOT NULL,
  cadence    TEXT GENERATED ALWAYS AS ('reading') VIRTUAL,
  at         TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', at) IS at),
  value      REAL NOT NULL,
  value2     REAL,
  has_value2 INTEGER GENERATED ALWAYS AS (value2 IS NOT NULL) VIRTUAL,
  -- fasting, after a meal, sitting: free words of the member's.
  context    TEXT CHECK (context IS NULL OR length(trim(context)) > 0),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (metric, cadence, has_value2) REFERENCES health_metric(code, cadence, has_value2) ON DELETE NO ACTION
) STRICT;
-- Reader: a person's readings of a metric over time; the child side of `person_id`.
CREATE INDEX reading_by_person ON reading(person_id, metric, at, id);
-- Reader: Health's summary (the latest reading of each metric); the child side of `metric`.
CREATE INDEX reading_by_metric ON reading(metric, person_id, at, id);

-- L2: a journal entry is a note with a date: `journal_on` (NULL: an ordinary note) replaces "a note
-- `about` the owner". Linking a note about yourself no longer moves it to Journal, and an entry can be
-- backdated. The notebook is the note's HOME (`entity.parent_id`).
CREATE TABLE note (
  id         TEXT PRIMARY KEY,
  kind       TEXT GENERATED ALWAYS AS ('note') VIRTUAL,
  -- K11: the size budget of the words (64 KiB today) is the command's on purpose: a budget the
  -- product may tune is not an integrity rule, and a CHECK would freeze it behind a rebuild of `note`.
  body       TEXT NOT NULL DEFAULT '',
  format     TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown','plain')),
  journal_on TEXT CHECK (date(journal_on) IS journal_on),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;
-- Reader: Journal, a day at a time and newest first.
CREATE INDEX note_by_journal ON note(journal_on, id) WHERE journal_on IS NOT NULL;

-- H2: an image or file placed inside a note's body is a CHILD of the note, not an item: in no list,
-- search result or trash, cascading with the note, its earlier versions kept through `revision_blob`
-- (slot `asset:<id>`). Mirrors `message_attachment`. A file the member wants as an item in its own
-- right is still a document `attached` to the note.
CREATE TABLE note_asset (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  blob       TEXT NOT NULL REFERENCES blob(hash) ON DELETE NO ACTION,
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  media_type TEXT NOT NULL CHECK (length(trim(media_type)) > 0),
  position   REAL NOT NULL DEFAULT 0
) STRICT;
-- Reader: a note's assets in order; the child side of `note_id`.
CREATE INDEX note_asset_by_note ON note_asset(note_id, position, id);
-- Reader: the blob collector and the backup (a note asset is a rented blob).
CREATE INDEX note_asset_by_blob ON note_asset(blob);

-- C2: a document sits in exactly one folder or at the top level (`entity.parent_id`); a folder can
-- sit in a folder; trashing a folder takes its contents with it (`trashed_by`). A document that
-- belongs in two places gets a tag. Sibling folders may repeat a name.
CREATE TABLE document (
  id         TEXT PRIMARY KEY,
  kind       TEXT GENERATED ALWAYS AS ('document') VIRTUAL,
  blob       TEXT NOT NULL REFERENCES blob(hash) ON DELETE NO ACTION,
  media_type TEXT NOT NULL CHECK (length(trim(media_type)) > 0),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;
-- Reader: the blob collector; also "is this document already here" on an upload.
CREATE INDEX document_by_blob ON document(blob);

-- A11, H1, H3: a photo. `blob` is no longer UNIQUE (identity is never taken from a value; "a
-- re-offered photograph commits once" is the command's, by the blob's hash read through the index
-- below). A camera roll is a followed store with tombstones, so a trashed photo stays trashed after a
-- rescan. `lat`/`lon` are where it was taken; `place_id` is a NAMED place only and a photo no longer
-- creates a place titled with a coordinate. `motion_blob` is a Live/Motion Photo's clip.
CREATE TABLE photo (
  id          TEXT PRIMARY KEY,
  kind        TEXT GENERATED ALWAYS AS ('photo') VIRTUAL,
  blob        TEXT NOT NULL REFERENCES blob(hash) ON DELETE NO ACTION,
  media_type  TEXT NOT NULL CHECK (length(trim(media_type)) > 0),
  form        TEXT NOT NULL REFERENCES photo_form(code) ON DELETE NO ACTION,   -- A1
  taken_at    TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', taken_at) IS taken_at),
  offset_min  INTEGER CHECK (offset_min IS NULL OR offset_min BETWEEN -1080 AND 1080),
  width       INTEGER CHECK (width IS NULL OR width > 0),
  height      INTEGER CHECK (height IS NULL OR height > 0),
  duration_s  REAL CHECK (duration_s IS NULL OR duration_s >= 0),
  lat         REAL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
  lon         REAL CHECK (lon IS NULL OR lon BETWEEN -180 AND 180),
  motion_blob TEXT REFERENCES blob(hash) ON DELETE NO ACTION,
  motion_duration_s REAL CHECK (motion_duration_s IS NULL OR motion_duration_s >= 0),
  -- A copy of the capture's metadata, versioned by its origin system (A3: no "v").
  exif        TEXT CHECK (exif IS NULL OR json_valid(exif)),
  burst       TEXT,
  edited_from TEXT REFERENCES photo(id) ON DELETE NO ACTION,
  place_id    TEXT REFERENCES place(id) ON DELETE NO ACTION,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  CHECK ((lat IS NULL) = (lon IS NULL)),
  CHECK (motion_duration_s IS NULL OR motion_blob IS NOT NULL),
  CHECK (edited_from IS NULL OR edited_from <> id)
) STRICT;
-- Reader: the timeline; "is this photograph already here"; the child side of `blob`; the collector.
CREATE INDEX photo_by_taken       ON photo(taken_at, id);
CREATE INDEX photo_by_blob        ON photo(blob);
-- Reader: Photos' Videos and Scans shelves; the child side of `form`.
CREATE INDEX photo_by_form        ON photo(form, taken_at, id);
-- Reader: the blob collector and the backup (a motion clip is a rented blob).
CREATE INDEX photo_by_motion      ON photo(motion_blob) WHERE motion_blob IS NOT NULL;
CREATE INDEX photo_by_place       ON photo(place_id) WHERE place_id IS NOT NULL;
CREATE INDEX photo_by_edited_from ON photo(edited_from) WHERE edited_from IS NOT NULL;
CREATE INDEX photo_by_burst       ON photo(burst) WHERE burst IS NOT NULL;

-- E4, E5: an account; `type` is a lookup. `currency` is fixed once the account has lines (below).
CREATE TABLE account (
  id            TEXT PRIMARY KEY,
  kind          TEXT GENERATED ALWAYS AS ('account') VIRTUAL,
  type          TEXT NOT NULL REFERENCES account_type(code) ON DELETE NO ACTION,   -- A1
  currency      TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  -- Where the account stood on `opening_on`, SIGNED (a card owes: negative). The balance on any day is
  -- this plus the posted lines AFTER `opening_on`, derived at read time.
  opening_minor INTEGER NOT NULL DEFAULT 0,
  opening_on    TEXT CHECK (date(opening_on) IS opening_on),
  on_budget     INTEGER NOT NULL DEFAULT 1 CHECK (on_budget IN (0,1)),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;
-- Reader: Money's accounts grouped by type; the child side of `type`.
CREATE INDEX account_by_type ON account(type, id);
CREATE TRIGGER account_currency_is_fixed BEFORE UPDATE OF currency ON account
  WHEN new.currency <> old.currency AND EXISTS (SELECT 1 FROM txn WHERE account_id = old.id)
  BEGIN SELECT RAISE(ABORT, 'an account''s currency is fixed once it has lines'); END;

-- E1-E4: a line of an account's ledger. There is no `void` (E1) and no `currency` (read from the
-- account, E4). A line is `entered` from a 'statement' or by 'hand' on ANY account (E2); a
-- statement line is never edited, a hand line is. A statement that seems to match a hand line only
-- PROPOSES the match (the command); on Confirm the statement's amount and date win and the hand
-- line's category and memo carry over, and the line becomes a statement line (the one allowed change
-- of `entered`). A foreign-currency purchase keeps what was charged in `original_*`. The line's
-- categories are `txn_split` (E3), never a column here.
CREATE TABLE txn (
  id            TEXT PRIMARY KEY,
  kind          TEXT GENERATED ALWAYS AS ('txn') VIRTUAL,
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE NO ACTION,
  posted_on     TEXT NOT NULL CHECK (date(posted_on) IS posted_on),
  amount_minor  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending','posted')),
  entered       TEXT NOT NULL DEFAULT 'statement' CHECK (entered IN ('statement','hand')),
  memo          TEXT,
  original_amount_minor INTEGER,
  original_currency     TEXT CHECK (original_currency IS NULL OR (length(original_currency) = 3 AND original_currency GLOB '[A-Z][A-Z][A-Z]')),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  CHECK ((original_amount_minor IS NULL) = (original_currency IS NULL))
) STRICT;
-- Readers: an account's lines by day; a month's statement across accounts, newest first.
CREATE INDEX txn_by_account_day ON txn(account_id, posted_on, id);
CREATE INDEX txn_by_day         ON txn(posted_on, id);
CREATE TRIGGER txn_statement_line_is_fixed
  BEFORE UPDATE OF account_id, posted_on, amount_minor, original_amount_minor, original_currency ON txn
  WHEN old.entered = 'statement'
  BEGIN SELECT RAISE(ABORT, 'a statement line is never edited'); END;
CREATE TRIGGER txn_entered_only_becomes_a_statement BEFORE UPDATE OF entered ON txn
  WHEN new.entered <> old.entered AND NOT (old.entered = 'hand' AND new.entered = 'statement')
  BEGIN SELECT RAISE(ABORT, 'a line''s origin never changes but a hand line confirmed as a statement line'); END;

-- E3: a line's categories live HERE and nowhere else. An ordinary line has one row, a split several,
-- an uncategorised line none. The parts sum to the line's amount: a rule over several rows that
-- cannot be a row-level constraint, so it is the command's and a commitment test's (a trigger would
-- fail mid-commit while the rows are written one at a time).
CREATE TABLE txn_split (
  txn_id        TEXT NOT NULL REFERENCES txn(id) ON DELETE CASCADE,
  position      REAL NOT NULL,
  category_id   TEXT NOT NULL,
  category_kind TEXT GENERATED ALWAYS AS ('category') VIRTUAL,
  amount_minor  INTEGER NOT NULL,
  memo          TEXT,
  PRIMARY KEY (txn_id, position),
  FOREIGN KEY (category_id, category_kind) REFERENCES entity(id, kind) ON DELETE NO ACTION
) STRICT;
-- Reader: spending by category (every report); the child side of `category_id`.
CREATE INDEX txn_split_by_category ON txn_split(category_id, txn_id);

-- Two lines that are the two halves of one movement of the member's own money, across currencies
-- too (E4). The lower id is `a`, so a pair is one row; a line is in at most one pair. The money in
-- the pair is the command's to check; the pair goes with either line.
CREATE TABLE transfer (
  a TEXT PRIMARY KEY REFERENCES txn(id) ON DELETE CASCADE,
  b TEXT NOT NULL UNIQUE REFERENCES txn(id) ON DELETE CASCADE,
  CHECK (a < b)
) STRICT;
CREATE TRIGGER transfer_halves_are_in_one_pair BEFORE INSERT ON transfer
  WHEN EXISTS (SELECT 1 FROM transfer WHERE b = new.a OR a = new.b)
  BEGIN SELECT RAISE(ABORT, 'a line is in at most one transfer'); END;
CREATE TRIGGER transfer_halves_are_in_one_pair_on_update BEFORE UPDATE OF a, b ON transfer
  WHEN EXISTS (SELECT 1 FROM transfer WHERE rowid <> old.rowid AND (b = new.a OR a = new.b))
  BEGIN SELECT RAISE(ABORT, 'a line is in at most one transfer'); END;

-- B1: a budget and a rule belong to their category but are not part of its snapshot (setting a budget
-- writes no copy of the category's other budgets or rules). A budget is in the vault's currency
-- (`vault.currency`; E4 took the currency off a line too), so it carries none.
CREATE TABLE budget (
  category_id   TEXT NOT NULL,
  category_kind TEXT GENERATED ALWAYS AS ('category') VIRTUAL,
  month         TEXT NOT NULL CHECK (date(month || '-01') IS month || '-01'),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
  carry         INTEGER NOT NULL DEFAULT 0 CHECK (carry IN (0,1)),
  PRIMARY KEY (category_id, month),
  FOREIGN KEY (category_id, category_kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
-- Reader: one month across every category (the month's budget screen).
CREATE INDEX budget_by_month ON budget(month, category_id);

CREATE TABLE checkpoint (
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  day           TEXT NOT NULL CHECK (date(day) IS day),
  balance_minor INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
) STRICT, WITHOUT ROWID;

CREATE TABLE rule (
  id            TEXT PRIMARY KEY,
  -- A3: a JSON object the vault defines carries "v":1.
  pattern       TEXT NOT NULL CHECK (json_valid(pattern) AND json_type(pattern) = 'object' AND json_extract(pattern, '$.v') IS 1),
  -- The name the line shows once the rule has run: the payee, not the bank's words (which stay in
  -- `source.stated`). NULL leaves the line's name alone.
  display_name  TEXT CHECK (display_name IS NULL OR length(trim(display_name)) > 0),
  category_id   TEXT NOT NULL,
  category_kind TEXT GENERATED ALWAYS AS ('category') VIRTUAL,
  position      REAL NOT NULL,
  created_at    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  FOREIGN KEY (category_id, category_kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;
-- Reader: a category's rules in order; the child side of `category_id`.
CREATE INDEX rule_by_category ON rule(category_id);

-- L5: a chat is an ordinary trashable entity: trash, restore and Delete forever are `entity`'s,
-- like every kind's. Nothing here is special.
CREATE TABLE thread (
  id    TEXT PRIMARY KEY,
  kind  TEXT GENERATED ALWAYS AS ('thread') VIRTUAL,
  scope TEXT,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

CREATE TABLE message (
  thread_id  TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL CHECK (ordinal >= 0),
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text       TEXT NOT NULL,
  -- A closed state machine: it keeps its CHECK (A1).
  outcome    TEXT NOT NULL CHECK (outcome IN (
               'sent','answered','stopped','refused',
               'proposed','applied','dismissed','stale','failed')),
  refusal    TEXT REFERENCES message_refusal(code) ON DELETE NO ACTION,   -- A1
  notice     TEXT REFERENCES message_notice(code) ON DELETE NO ACTION,    -- A1
  -- A3: a JSON object the vault defines carries "v":1. `cards` is an array: none.
  record     TEXT CHECK (record IS NULL OR (json_valid(record) AND json_type(record) = 'object' AND json_extract(record, '$.v') IS 1)),
  cards      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cards) AND json_type(cards) = 'array'),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (thread_id, ordinal),
  CHECK ((role = 'user') = (outcome = 'sent')),
  CHECK ((outcome = 'refused') = (refusal IS NOT NULL)),
  CHECK (role = 'assistant' OR (notice IS NULL AND record IS NULL))
) STRICT;
-- Readers: the assistant's failure notes by reason; the child sides of `refusal` and `notice`.
CREATE INDEX message_by_refusal ON message(refusal, thread_id) WHERE refusal IS NOT NULL;
CREATE INDEX message_by_notice  ON message(notice, thread_id)  WHERE notice  IS NOT NULL;
CREATE TRIGGER message_is_not_born_settled BEFORE INSERT ON message
  WHEN new.outcome IN ('applied','dismissed','stale','failed')
  BEGIN SELECT RAISE(ABORT, 'a message is proposed before it is settled: it is not born applied, dismissed, stale or failed'); END;
CREATE TRIGGER message_outcome_settles_once BEFORE UPDATE OF outcome ON message
  WHEN new.outcome IS NOT old.outcome
  BEGIN
    SELECT RAISE(ABORT, 'a told answer does not change: only a proposal settles, and once')
     WHERE old.outcome <> 'proposed';
    SELECT RAISE(ABORT, 'a proposal settles as applied, dismissed, stale or failed')
     WHERE new.outcome NOT IN ('applied','dismissed','stale','failed');
  END;

CREATE TABLE message_attachment (
  thread_id TEXT NOT NULL,
  ordinal   INTEGER NOT NULL,
  position  REAL NOT NULL CHECK (position >= 0),
  form      TEXT NOT NULL CHECK (form IN ('photo','document','image')),
  label     TEXT NOT NULL,
  entity_id TEXT REFERENCES entity(id) ON DELETE SET NULL,
  thumb     TEXT REFERENCES blob(hash) ON DELETE NO ACTION,
  PRIMARY KEY (thread_id, ordinal, position),
  FOREIGN KEY (thread_id, ordinal) REFERENCES message(thread_id, ordinal) ON DELETE CASCADE,
  CHECK ((form = 'image') = (thumb IS NOT NULL)),
  CHECK (form <> 'image' OR entity_id IS NULL)
) STRICT;
-- Readers: an item's chat mentions (the SET NULL on purge); the blob collector.
CREATE INDEX message_attachment_by_entity ON message_attachment(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX message_attachment_by_thumb  ON message_attachment(thumb) WHERE thumb IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Locker: an app like every other (K). Its item is an entity of its own kind with the vault's
-- title, stamps, trash, tags, links (K1), attachments (K10) and `[[title]]` (K6); the one thing that
-- differs is that sensitive field values are sealed under `K` (`lk1:` ciphertext, never indexed,
-- never in a derivative, never plaintext; K4). Exactly FOUR tables (I5): item, field, passkey, key.
-- Addresses, aliases, the memo and attachments-as-sealed-files are all fields.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE locker_item (
  id          TEXT PRIMARY KEY,
  kind        TEXT GENERATED ALWAYS AS ('locker_item') VIRTUAL,
  type        TEXT NOT NULL REFERENCES locker_type(code) ON DELETE NO ACTION,   -- A1
  compromised INTEGER NOT NULL DEFAULT 0 CHECK (compromised IN (0,1)),
  -- When the core last opened one of this item's sealed cells (#1146). A use is not an edit: stamping
  -- it does not move the entity's `updated_at` and makes no revision. (I3: `password_set_at` and
  -- `memo` are gone: a secret's age is `locker_item_field.value_set_at`, the memo is the `notes` field.)
  last_used_at TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at) IS last_used_at),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;
-- Reader: Locker's filter by type; the child side of `type`.
CREATE INDEX locker_item_by_type ON locker_item(type, id);

-- I2-I5, I7, I8. Every type's fields (built-in, template, custom) live uniformly here.
--   field_key  stable for the built-in keys of all 15 types (NULL for custom and template fields); no
--              list of keys is in the DDL (a 16th type would force a rebuild). Which key is which
--              kind is held in Rust, and the plaintext gate test covers every built-in secret key.
--   kind       SQL checks the column shape by `kind` ONLY:
--                sealed, otp   value_sealed + key_id               (an otp field is a one-time-code seed)
--                file          value_blob + value_sealed + key_id  (I7: the file's name and media type are sealed
--                              in value_sealed; the bytes are `lkf1` chunked AES-256-GCM under K in the blob store)
--                text, url, date  value_text, plain (a `date` can carry a reminder, I8)
--   single     one row per item for this key (a login's `password`); 0 lets an item hold several (urls, aliases).
--   claimed    an alias: the value is held by ONE item vault-wide (a trashed item keeps its alias until purged).
--   value_set_at  when a secret's value last changed (I3): every secret has an age, not only a password.
-- No hash is ever stored inside `value_sealed` or `value_text`; `value_blob` is the one foreign key.
CREATE TABLE locker_item_field (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES locker_item(id) ON DELETE CASCADE,
  field_key    TEXT CHECK (field_key IS NULL OR length(field_key) > 0),
  single       INTEGER NOT NULL DEFAULT 0 CHECK (single IN (0,1)),
  claimed      INTEGER NOT NULL DEFAULT 0 CHECK (claimed IN (0,1)),
  section      TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('text','sealed','url','date','otp','file')),
  value_text   TEXT,
  value_sealed TEXT,
  value_blob   TEXT REFERENCES blob(hash) ON DELETE NO ACTION,
  key_id       TEXT REFERENCES locker_key(key_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  value_set_at TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', value_set_at) IS value_set_at),
  position     REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at   TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  -- 1 for a `date` field, else NULL: the key a reminder uses to name only a date field (I8).
  dated        INTEGER GENERATED ALWAYS AS (CASE WHEN kind = 'date' THEN 1 END) VIRTUAL,
  UNIQUE (id, item_id),
  UNIQUE (id, dated),
  CHECK ((kind IN ('sealed','otp','file')) = (value_sealed IS NOT NULL)),
  CHECK ((kind IN ('sealed','otp','file')) = (key_id IS NOT NULL)),
  CHECK ((kind IN ('sealed','otp','file')) = (value_set_at IS NOT NULL)),
  CHECK ((kind = 'file') = (value_blob IS NOT NULL)),
  CHECK (kind IN ('text','url','date') OR value_text IS NULL),
  CHECK (kind <> 'date' OR date(value_text) IS value_text),
  CHECK (single = 0 OR field_key IS NOT NULL),
  CHECK (claimed = 0 OR (kind = 'text' AND value_text IS NOT NULL))
) STRICT;
-- Reader: an item's fields in order; the child side of `item_id`.
CREATE INDEX locker_item_field_by_item ON locker_item_field(item_id, position, id);
-- Single-instance keys (a login's one `password`) are one per item.
CREATE UNIQUE INDEX locker_item_field_single ON locker_item_field(item_id, field_key) WHERE single = 1;
-- I5: an alias is held by one item vault-wide. Reader: finding the item an alias belongs to.
CREATE UNIQUE INDEX locker_item_field_claimed ON locker_item_field(value_text COLLATE NOCASE) WHERE claimed = 1;
-- I4: addresses are `url` fields. Reader: matching a site or app identifier to its items (autofill).
CREATE INDEX locker_item_field_by_url ON locker_item_field(value_text COLLATE NOCASE) WHERE kind = 'url';
-- Reader: the rotation pass (what is sealed under which key); the child side of `key_id`.
CREATE INDEX locker_item_field_by_key  ON locker_item_field(key_id) WHERE key_id IS NOT NULL;
-- Reader: the blob collector and the backup's "sealed files are always sent, never freed" (I7).
CREATE INDEX locker_item_field_by_blob ON locker_item_field(value_blob) WHERE value_blob IS NOT NULL;

-- I6: an item can hold several passkeys. `private_key` is `lk1:` ciphertext (the history keeps only
-- that ciphertext, K3); `rp_id` is plain and searched (I1).
CREATE TABLE locker_item_passkey (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES locker_item(id) ON DELETE CASCADE,
  rp_id         TEXT NOT NULL CHECK (length(trim(rp_id)) > 0),
  user_handle   TEXT,
  display_name  TEXT,
  credential_id TEXT,
  algorithm     TEXT,
  private_key   TEXT,
  created_at    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  key_id        TEXT REFERENCES locker_key(key_id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CHECK ((private_key IS NULL) = (key_id IS NULL))
) STRICT;
-- Reader: an item's passkeys; the child side of `item_id`.
CREATE INDEX locker_item_passkey_by_item ON locker_item_passkey(item_id, id);
-- Reader: passkey sign-in finds the passkeys of a site.
CREATE INDEX locker_item_passkey_by_rp   ON locker_item_passkey(rp_id, item_id);
CREATE INDEX locker_item_passkey_by_key  ON locker_item_passkey(key_id) WHERE key_id IS NOT NULL;

-- The Locker's one key row: the id of the generation its sealed cells are sealed under, never
-- material. A singleton: the row is `id = 1`. (Rekeying is out of v0: lifting the CHECK later
-- rebuilds a one-row table.)
CREATE TABLE locker_key (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  key_id     TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  -- Unlocks the phone refused since the last one it allowed, and when the latest was (#1146).
  failed_unlocks   INTEGER NOT NULL DEFAULT 0 CHECK (failed_unlocks >= 0),
  failed_unlock_at TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', failed_unlock_at) IS failed_unlock_at)
) STRICT;

-- ---------------------------------------------------------------------------------------------
-- Seeds: the rows founding writes, under fixed ids `<kind>:<key>`. Lookups first.
-- ---------------------------------------------------------------------------------------------

INSERT INTO entity_kind (code, linkable, may_be_top, may_be_named, may_be_unnamed) VALUES
  ('person',1,1,1,1), ('place',1,1,1,1), ('event',1,0,1,1), ('task',1,1,1,1), ('workout',1,1,1,1),
  ('touch',1,1,1,1), ('reading',0,1,0,1), ('note',1,1,1,0), ('document',1,1,1,1), ('photo',1,1,1,1),
  ('account',1,1,1,1), ('txn',1,1,1,1), ('thread',0,1,1,1), ('locker_item',1,1,1,1),
  ('tag',0,1,1,1), ('category',0,1,1,1), ('workout_kind',0,1,1,1), ('touch_kind',0,1,1,1), ('relation',0,1,1,1),
  ('notebook',0,1,1,1), ('folder',0,1,1,1), ('album',0,1,1,1), ('list',0,1,1,1), ('project',0,1,1,1),
  ('section',0,0,1,1), ('area',0,1,1,1), ('calendar',0,1,1,1);

-- A19, C1, C2: where each kind may sit. A concept's parent is of its own kind.
INSERT INTO home_shape (kind, home_kind) VALUES
  ('folder','folder'), ('notebook','notebook'), ('section','project'), ('project','area'),
  ('document','folder'), ('note','notebook'), ('event','calendar'),
  ('task','project'), ('task','section'), ('task','task'),
  ('tag','tag'), ('category','category'), ('workout_kind','workout_kind'), ('touch_kind','touch_kind');

INSERT INTO concept_kind (code, takes_color) VALUES
  ('tag',1), ('category',0), ('workout_kind',0), ('touch_kind',0), ('relation',0);
INSERT INTO container_kind (code) VALUES
  ('notebook'), ('folder'), ('album'), ('list'), ('project'), ('section'), ('area'), ('calendar');

-- J1: the palette, with the party-wheel hues as plain keys.
INSERT INTO palette (key) VALUES
  ('blue'), ('mustard'), ('violet'), ('petrol'), ('indigo'), ('graphite'), ('raspberry'), ('orchid'),
  ('rose'), ('amber'), ('ochre'), ('forest'), ('teal'), ('slate');

INSERT INTO arrival_via (code) VALUES ('vcard'), ('csv'), ('upload'), ('picker'), ('markdown'), ('scan');

-- A10, A11: the followed stores. A camera roll is one now; the one-shot arrivals above are not.
INSERT INTO origin_system (code, fills_kind, can_retire, on_device) VALUES
  ('contacts',        NULL,       1, 1),
  ('calendar',        'calendar', 1, 1),
  ('files',           'folder',   1, 1),
  ('health',          NULL,       1, 1),
  ('camera_roll',     NULL,       1, 1),
  ('phone_reminders', 'project',  1, 1),
  ('statement',       'account',  0, 0);

-- A12: `health` yields both a workout and a reading.
INSERT INTO source_shape (system, entity_kind) VALUES
  ('contacts','person'), ('calendar','event'), ('files','document'), ('health','workout'),
  ('health','reading'), ('camera_roll','photo'), ('phone_reminders','task'), ('statement','txn');

INSERT INTO derivative_variant (code, has_out) VALUES
  ('thumb',1), ('preview',1), ('poster',1), ('text',0), ('caption',0), ('phash',0), ('thumbhash',0);

INSERT INTO contact_point_kind (code) VALUES ('phone'), ('email'), ('address'), ('url'), ('handle');
INSERT INTO photo_form (code) VALUES ('photo'), ('video'), ('scan');
INSERT INTO account_type (code) VALUES
  ('checking'), ('savings'), ('credit_card'), ('cash'), ('loan'), ('investment'), ('asset');
INSERT INTO locker_type (code) VALUES
  ('login'), ('card'), ('note'), ('identity'), ('wifi'), ('password'), ('ssh_key'), ('api_credential'),
  ('passport'), ('bank_account'), ('driving_licence'), ('software_licence'), ('crypto_wallet'),
  ('membership'), ('document');
INSERT INTO message_refusal (code) VALUES
  ('no_tool_fits'), ('query_failed'), ('unparsable'), ('model_absent'), ('model_failed'),
  ('vision_absent'), ('attachment_unsupported'), ('attachment_unreadable'), ('attachment_too_large');
INSERT INTO message_notice (code) VALUES ('doc_truncated');
INSERT INTO person_form (code) VALUES ('person'), ('org'), ('group'), ('pet');
INSERT INTO person_date_kind (code, single) VALUES ('birthday', 1), ('anniversary', 0), ('other', 0);
INSERT INTO reminder_target (kind, via_child) VALUES ('event', 0), ('task', 0), ('person', 1), ('locker_item', 1);

-- F1: daily totals (`measurement`) and readings (`reading`). Weight moved from a daily figure to a reading.
INSERT INTO health_metric (code, cadence, has_value2, unit) VALUES
  ('steps',              'total',   0, 'count'),
  ('active_energy_kcal', 'total',   0, 'kcal'),
  ('exercise_min',       'total',   0, 'min'),
  ('sleep_min',          'total',   0, 'min'),
  ('resting_hr_bpm',     'total',   0, 'bpm'),
  ('lowest_hr_bpm',      'total',   0, 'bpm'),
  ('highest_hr_bpm',     'total',   0, 'bpm'),
  ('weight_kg',          'reading', 0, 'kg'),
  ('blood_pressure',     'reading', 1, 'mmHg'),
  ('glucose_mmol',       'reading', 0, 'mmol/L'),
  ('body_temp_c',        'reading', 0, 'degC');

-- A7, A14, G3, K1: the pruned relation vocabulary. Gone: `links` (A4), `attendee` (A6), the flag
-- tag (A14), `about event *` (G3, anniversaries were its only use), the per-kind Locker rows (a Locker
-- item is `about` anything like a note or a task, and `with` a person like a workout or a txn).
INSERT INTO edge_shape (rel, from_kind, to_kind, label_kind, ordered, anchored) VALUES
  ('contains', 'album',       'photo',    NULL,       1, 0),
  ('contains', 'list',        'person',   NULL,       1, 0),
  ('tagged',   '*',           'tag',      NULL,       0, 0),
  ('about',    'note',        '*',        NULL,       0, 1),
  ('about',    'task',        '*',        NULL,       0, 0),
  ('about',    'document',    'person',   NULL,       0, 0),
  ('about',    'locker_item', '*',        NULL,       0, 0),
  ('attached', '*',           'document', NULL,       0, 0),
  ('attached', '*',           'photo',    NULL,       0, 0),
  ('with',     'workout',     'person',   NULL,       0, 0),
  ('with',     'touch',       'person',   NULL,       0, 0),
  ('with',     'txn',         'person',   NULL,       0, 0),
  ('with',     'locker_item', 'person',   NULL,       0, 0),
  ('related',  'person',      'person',   'relation', 0, 0),
  ('depicts',  'photo',       'person',   NULL,       0, 0);

-- The seeded entities, parents first within one statement (a foreign key is checked when the
-- statement ends). A seed with a parent is of its parent's kind.
INSERT INTO entity (id, kind, title, parent_id, parent_kind, created_at, updated_at)
  SELECT column1, column2, column3, column4, CASE WHEN column4 IS NULL THEN NULL ELSE column2 END,
         '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'
    FROM (VALUES
      ('category:income',            'category', 'Income',                  NULL),
      ('category:housing',           'category', 'Housing',                 NULL),
      ('category:utilities',         'category', 'Utilities',               NULL),
      ('category:food',              'category', 'Food',                    NULL),
      ('category:transport',         'category', 'Transport',               NULL),
      ('category:shopping',          'category', 'Shopping',                NULL),
      ('category:health',            'category', 'Health',                  NULL),
      ('category:fun',               'category', 'Fun and travel',          NULL),
      ('category:fees',              'category', 'Fees and taxes',          NULL),
      ('category:income.pay',        'category', 'Pay',                     'category:income'),
      ('category:income.other',      'category', 'Other income',            'category:income'),
      ('category:housing.rent',      'category', 'Rent or mortgage',        'category:housing'),
      ('category:housing.home',      'category', 'Home and repairs',        'category:housing'),
      ('category:utilities.bills',   'category', 'Power, gas and water',    'category:utilities'),
      ('category:utilities.phone',   'category', 'Phone and internet',      'category:utilities'),
      ('category:food.groceries',    'category', 'Groceries',               'category:food'),
      ('category:food.dining',       'category', 'Dining out',              'category:food'),
      ('category:transport.fuel',    'category', 'Fuel',                    'category:transport'),
      ('category:transport.transit', 'category', 'Transit and rideshare',   'category:transport'),
      ('category:shopping.general',  'category', 'Clothes and household',   'category:shopping'),
      ('category:health.care',       'category', 'Health care',             'category:health'),
      ('category:fun.subscriptions', 'category', 'Subscriptions',           'category:fun'),
      ('category:fun.entertainment', 'category', 'Entertainment and travel','category:fun'),
      ('workout_kind:run',           'workout_kind', 'Run',                 NULL),
      ('workout_kind:walk',          'workout_kind', 'Walk',                NULL),
      ('workout_kind:cycle',         'workout_kind', 'Cycle',               NULL),
      ('workout_kind:strength',      'workout_kind', 'Strength',            NULL),
      ('workout_kind:swim',          'workout_kind', 'Swim',                NULL),
      ('workout_kind:hike',          'workout_kind', 'Hike',                NULL),
      ('workout_kind:yoga',          'workout_kind', 'Yoga',                NULL),
      ('workout_kind:other',         'workout_kind', 'Other',               NULL),
      ('touch_kind:message',         'touch_kind', 'Message',               NULL),
      ('touch_kind:call',            'touch_kind', 'Call',                  NULL),
      ('touch_kind:met-up',          'touch_kind', 'Met up',                NULL),
      ('relation:related',           'relation', 'Related',                 NULL),
      ('calendar:default',           'calendar', 'Calendar',                NULL));

-- A concept's key is its id's suffix, as the baseline seeds it.
INSERT INTO concept (id, kind, key, color)
  SELECT id, kind, substr(id, instr(id, ':') + 1), NULL FROM entity
   WHERE kind IN ('category','workout_kind','touch_kind','relation');
INSERT INTO container (id, kind) VALUES ('calendar:default', 'calendar');
