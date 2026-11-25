-- GENERATED — do not edit. THE SCHEMA A NEW VAULT GETS: the `sqlite_master` of
-- a file founded at the ladder head, one statement per block.
--
--   cargo run -p centraid-vault --bin export-ladder-ddl \
--     > contracts/schema/vault-ddl.sql
--
-- Ordered by type then name, for READING; the runnable ordering is
-- `contracts/migrations/001_baseline.sql`.
--
-- Source: sqlite_master (type, name, tbl_name, sql) where sql is not null.
-- `sqlite_stat*` is excluded: it is the planner's own statistics, so it says
-- how much data a file holds and nothing about its shape.
-- `crates/vault/tests/ladder_ddl.rs` founds a vault and diffs this file
-- against its live schema on every run.

-- index account_by_type on account
CREATE INDEX account_by_type ON account(type, id);

-- index action_key_by_at on action_key
CREATE INDEX action_key_by_at ON action_key(at);

-- index budget_by_month on budget
CREATE INDEX budget_by_month ON budget(month, category_id);

-- index concept_by_color on concept
CREATE INDEX concept_by_color ON concept(color) WHERE color IS NOT NULL;

-- index contact_point_by_value on contact_point
CREATE INDEX contact_point_by_value ON contact_point(kind, normalized, person_id);

-- index contact_point_preferred on contact_point
CREATE UNIQUE INDEX contact_point_preferred ON contact_point(person_id, kind) WHERE preferred = 1;

-- index container_by_color on container
CREATE INDEX container_by_color ON container(color) WHERE color IS NOT NULL;

-- index container_by_cover on container
CREATE INDEX container_by_cover ON container(cover) WHERE cover IS NOT NULL;

-- index container_by_kind on container
CREATE INDEX container_by_kind  ON container(kind, id);

-- index derivative_by_out on derivative
CREATE INDEX derivative_by_out ON derivative(out) WHERE out IS NOT NULL;

-- index derivative_by_variant on derivative
CREATE INDEX derivative_by_variant ON derivative(variant, blob);

-- index document_by_blob on document
CREATE INDEX document_by_blob ON document(blob);

-- index edge_key on edge
CREATE UNIQUE INDEX edge_key ON edge(from_id, rel, to_id, ifnull(label_id, ''));

-- index edge_label on edge
CREATE INDEX edge_label ON edge(label_id) WHERE label_id IS NOT NULL;

-- index edge_order on edge
CREATE INDEX edge_order ON edge(from_id, rel, position) WHERE position IS NOT NULL;

-- index edge_to on edge
CREATE INDEX edge_to    ON edge(to_id, rel, from_id);

-- index entity_archived on entity
CREATE INDEX entity_archived   ON entity(kind, archived_at, id) WHERE archived_at IS NOT NULL;

-- index entity_by_arrival on entity
CREATE INDEX entity_by_arrival ON entity(arrived_via, n) WHERE arrived_via IS NOT NULL;

-- index entity_by_created on entity
CREATE INDEX entity_by_created ON entity(kind, created_at, id);

-- index entity_by_home on entity
CREATE INDEX entity_by_home    ON entity(parent_id, kind, updated_at, id) WHERE parent_id IS NOT NULL;

-- index entity_by_title on entity
CREATE INDEX entity_by_title   ON entity(kind, deleted_at, title, id);

-- index entity_by_title_nocase on entity
CREATE INDEX entity_by_title_nocase ON entity(kind, title COLLATE NOCASE, created_at, id) WHERE deleted_at IS NULL;

-- index entity_by_trashed_by on entity
CREATE INDEX entity_by_trashed_by ON entity(trashed_by) WHERE trashed_by IS NOT NULL;

-- index entity_by_updated on entity
CREATE INDEX entity_by_updated ON entity(kind, deleted_at, updated_at, id);

-- index entity_pinned on entity
CREATE INDEX entity_pinned     ON entity(kind, pinned_at, id)   WHERE pinned_at IS NOT NULL;

-- index entity_purge on entity
CREATE INDEX entity_purge      ON entity(purge_at) WHERE purge_at IS NOT NULL;

-- index entity_starred on entity
CREATE INDEX entity_starred    ON entity(kind, starred_at, id)  WHERE starred_at IS NOT NULL;

-- index entity_trashed on entity
CREATE INDEX entity_trashed    ON entity(deleted_at, n) WHERE deleted_at IS NOT NULL;

-- index event_by_place on event
CREATE INDEX event_by_place ON event(place_id) WHERE place_id IS NOT NULL;

-- index event_by_rule on event
CREATE INDEX event_by_rule  ON event(starts, id) WHERE rule IS NOT NULL;

-- index event_by_start on event
CREATE INDEX event_by_start ON event(starts, id);

-- index event_guest_by_person on event_guest
CREATE INDEX event_guest_by_person ON event_guest(person_id, event_id) WHERE person_id IS NOT NULL;

-- index event_guest_one_organizer on event_guest
CREATE UNIQUE INDEX event_guest_one_organizer ON event_guest(event_id) WHERE organizer = 1;

-- index home_shape_by_home on home_shape
CREATE INDEX home_shape_by_home ON home_shape(home_kind, kind);

-- index link_by_b on link
CREATE INDEX link_by_b ON link(b, a);

-- index locker_item_by_type on locker_item
CREATE INDEX locker_item_by_type ON locker_item(type, id);

-- index locker_item_field_by_blob on locker_item_field
CREATE INDEX locker_item_field_by_blob ON locker_item_field(value_blob) WHERE value_blob IS NOT NULL;

-- index locker_item_field_by_item on locker_item_field
CREATE INDEX locker_item_field_by_item ON locker_item_field(item_id, position, id);

-- index locker_item_field_by_key on locker_item_field
CREATE INDEX locker_item_field_by_key  ON locker_item_field(key_id) WHERE key_id IS NOT NULL;

-- index locker_item_field_by_url on locker_item_field
CREATE INDEX locker_item_field_by_url ON locker_item_field(value_text COLLATE NOCASE) WHERE kind = 'url';

-- index locker_item_field_claimed on locker_item_field
CREATE UNIQUE INDEX locker_item_field_claimed ON locker_item_field(value_text COLLATE NOCASE) WHERE claimed = 1;

-- index locker_item_field_single on locker_item_field
CREATE UNIQUE INDEX locker_item_field_single ON locker_item_field(item_id, field_key) WHERE single = 1;

-- index locker_item_passkey_by_item on locker_item_passkey
CREATE INDEX locker_item_passkey_by_item ON locker_item_passkey(item_id, id);

-- index locker_item_passkey_by_key on locker_item_passkey
CREATE INDEX locker_item_passkey_by_key  ON locker_item_passkey(key_id) WHERE key_id IS NOT NULL;

-- index locker_item_passkey_by_rp on locker_item_passkey
CREATE INDEX locker_item_passkey_by_rp   ON locker_item_passkey(rp_id, item_id);

-- index measurement_by_metric on measurement
CREATE INDEX measurement_by_metric ON measurement(metric, person_id, day);

-- index measurement_by_origin on measurement
CREATE INDEX measurement_by_origin ON measurement(origin_id) WHERE origin_id IS NOT NULL;

-- index mention_by_target on mention
CREATE INDEX mention_by_target ON mention(to_id, note_id) WHERE to_id IS NOT NULL;

-- index mention_by_words on mention
CREATE INDEX mention_by_words  ON mention(wikilink COLLATE NOCASE) WHERE to_id IS NULL;

-- index message_attachment_by_entity on message_attachment
CREATE INDEX message_attachment_by_entity ON message_attachment(entity_id) WHERE entity_id IS NOT NULL;

-- index message_attachment_by_thumb on message_attachment
CREATE INDEX message_attachment_by_thumb  ON message_attachment(thumb) WHERE thumb IS NOT NULL;

-- index message_by_notice on message
CREATE INDEX message_by_notice  ON message(notice, thread_id)  WHERE notice  IS NOT NULL;

-- index message_by_refusal on message
CREATE INDEX message_by_refusal ON message(refusal, thread_id) WHERE refusal IS NOT NULL;

-- index note_asset_by_blob on note_asset
CREATE INDEX note_asset_by_blob ON note_asset(blob);

-- index note_asset_by_note on note_asset
CREATE INDEX note_asset_by_note ON note_asset(note_id, position, id);

-- index note_by_journal on note
CREATE INDEX note_by_journal ON note(journal_on, id) WHERE journal_on IS NOT NULL;

-- index occurrence_by_place on occurrence
CREATE INDEX occurrence_by_place ON occurrence(place_id) WHERE place_id IS NOT NULL;

-- index origin_one_per_home on origin
CREATE UNIQUE INDEX origin_one_per_home ON origin(fills) WHERE fills IS NOT NULL;

-- index origin_system_by_fills on origin_system
CREATE INDEX origin_system_by_fills ON origin_system(fills_kind) WHERE fills_kind IS NOT NULL;

-- index person_by_avatar on person
CREATE INDEX person_by_avatar ON person(avatar) WHERE avatar IS NOT NULL;

-- index person_by_form on person
CREATE INDEX person_by_form ON person(form, id);

-- index person_date_by_day on person_date
CREATE INDEX person_date_by_day ON person_date(substr(date, -5), person_id);

-- index person_date_by_kind on person_date
CREATE INDEX person_date_by_kind ON person_date(kind, person_id);

-- index person_date_by_person on person_date
CREATE INDEX person_date_by_person ON person_date(person_id, position, id);

-- index person_date_one_of_a_single_kind on person_date
CREATE UNIQUE INDEX person_date_one_of_a_single_kind ON person_date(person_id, kind) WHERE single = 1;

-- index photo_by_blob on photo
CREATE INDEX photo_by_blob        ON photo(blob);

-- index photo_by_burst on photo
CREATE INDEX photo_by_burst       ON photo(burst) WHERE burst IS NOT NULL;

-- index photo_by_edited_from on photo
CREATE INDEX photo_by_edited_from ON photo(edited_from) WHERE edited_from IS NOT NULL;

-- index photo_by_form on photo
CREATE INDEX photo_by_form        ON photo(form, taken_at, id);

-- index photo_by_motion on photo
CREATE INDEX photo_by_motion      ON photo(motion_blob) WHERE motion_blob IS NOT NULL;

-- index photo_by_place on photo
CREATE INDEX photo_by_place       ON photo(place_id) WHERE place_id IS NOT NULL;

-- index photo_by_taken on photo
CREATE INDEX photo_by_taken       ON photo(taken_at, id);

-- index reading_by_metric on reading
CREATE INDEX reading_by_metric ON reading(metric, person_id, at, id);

-- index reading_by_person on reading
CREATE INDEX reading_by_person ON reading(person_id, metric, at, id);

-- index reminder_by_date on reminder
CREATE INDEX reminder_by_date  ON reminder(date_id)  WHERE date_id  IS NOT NULL;

-- index reminder_by_field on reminder
CREATE INDEX reminder_by_field ON reminder(field_id) WHERE field_id IS NOT NULL;

-- index reminder_by_kind on reminder
CREATE INDEX reminder_by_kind ON reminder(entity_kind, entity_id);

-- index reminder_key on reminder
CREATE UNIQUE INDEX reminder_key ON reminder(entity_id, ifnull(date_id, ''), ifnull(field_id, ''), offset_min);

-- index revision_blob_by_blob on revision_blob
CREATE INDEX revision_blob_by_blob ON revision_blob(blob);

-- index revision_by_origin on revision
CREATE INDEX revision_by_origin ON revision(origin_id) WHERE origin_id IS NOT NULL;

-- index rule_by_category on rule
CREATE INDEX rule_by_category ON rule(category_id);

-- index source_by_entity on source
CREATE INDEX source_by_entity ON source(entity_id) WHERE entity_id IS NOT NULL;

-- index source_by_seen on source
CREATE INDEX source_by_seen ON source(system, seen_at, id);

-- index source_key on source
CREATE UNIQUE INDEX source_key    ON source(origin_id, external_id, ifnull(device_id, ''));

-- index source_shape_by_kind on source_shape
CREATE INDEX source_shape_by_kind ON source_shape(entity_kind, system);

-- index task_by_done on task
CREATE INDEX task_by_done      ON task(status, done_at, id);

-- index task_by_due on task
CREATE INDEX task_by_due       ON task(status, due, id);

-- index task_by_scheduled on task
CREATE INDEX task_by_scheduled ON task(scheduled_on, id) WHERE scheduled_on IS NOT NULL;

-- index task_by_series on task
CREATE INDEX task_by_series    ON task(series_id, due, id) WHERE series_id IS NOT NULL;

-- index touch_by_place on touch
CREATE INDEX touch_by_place ON touch(place_id) WHERE place_id IS NOT NULL;

-- index touch_by_start on touch
CREATE INDEX touch_by_start ON touch(starts, id);

-- index touch_by_type on touch
CREATE INDEX touch_by_type  ON touch(type_id);

-- index txn_by_account_day on txn
CREATE INDEX txn_by_account_day ON txn(account_id, posted_on, id);

-- index txn_by_day on txn
CREATE INDEX txn_by_day         ON txn(posted_on, id);

-- index txn_split_by_category on txn_split
CREATE INDEX txn_split_by_category ON txn_split(category_id, txn_id);

-- index workout_by_place on workout
CREATE INDEX workout_by_place ON workout(place_id) WHERE place_id IS NOT NULL;

-- index workout_by_start on workout
CREATE INDEX workout_by_start ON workout(starts, id);

-- index workout_by_type on workout
CREATE INDEX workout_by_type  ON workout(type_id);

-- table account on account
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

-- table account_type on account_type
CREATE TABLE account_type (         -- A1, E5
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*')
) STRICT, WITHOUT ROWID;

-- table action_key on action_key
CREATE TABLE action_key (
  key   TEXT PRIMARY KEY,
  asked TEXT NOT NULL,
  at    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', at) IS at)
) STRICT, WITHOUT ROWID;

-- table arrival_via on arrival_via
CREATE TABLE arrival_via (
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*')
) STRICT, WITHOUT ROWID;

-- table blob on blob
CREATE TABLE blob (
  seq  INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK (size >= 0)
) STRICT;

-- table budget on budget
CREATE TABLE budget (
  category_id   TEXT NOT NULL,
  category_kind TEXT GENERATED ALWAYS AS ('category') VIRTUAL,
  month         TEXT NOT NULL CHECK (date(month || '-01') IS month || '-01'),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
  carry         INTEGER NOT NULL DEFAULT 0 CHECK (carry IN (0,1)),
  PRIMARY KEY (category_id, month),
  FOREIGN KEY (category_id, category_kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- table checkpoint on checkpoint
CREATE TABLE checkpoint (
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  day           TEXT NOT NULL CHECK (date(day) IS day),
  balance_minor INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
) STRICT, WITHOUT ROWID;

-- table concept on concept
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

-- table concept_kind on concept_kind
CREATE TABLE concept_kind (
  code        TEXT PRIMARY KEY REFERENCES entity_kind(code) ON DELETE NO ACTION,
  takes_color INTEGER NOT NULL CHECK (takes_color IN (0,1)),
  UNIQUE (code, takes_color)
) STRICT, WITHOUT ROWID;

-- table contact_point on contact_point
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

-- table contact_point_kind on contact_point_kind
CREATE TABLE contact_point_kind (   -- A1
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*')
) STRICT, WITHOUT ROWID;

-- table container on container
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

-- table container_kind on container_kind
CREATE TABLE container_kind (
  code TEXT PRIMARY KEY REFERENCES entity_kind(code) ON DELETE NO ACTION
) STRICT, WITHOUT ROWID;

-- table derivative on derivative
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

-- table derivative_variant on derivative_variant
CREATE TABLE derivative_variant (
  code    TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*'),
  has_out INTEGER NOT NULL CHECK (has_out IN (0,1)),
  UNIQUE (code, has_out)
) STRICT, WITHOUT ROWID;

-- table document on document
CREATE TABLE document (
  id         TEXT PRIMARY KEY,
  kind       TEXT GENERATED ALWAYS AS ('document') VIRTUAL,
  blob       TEXT NOT NULL REFERENCES blob(hash) ON DELETE NO ACTION,
  media_type TEXT NOT NULL CHECK (length(trim(media_type)) > 0),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

-- table edge on edge
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

-- table edge_shape on edge_shape
CREATE TABLE edge_shape (
  rel        TEXT NOT NULL CHECK (rel GLOB '[a-z]*' AND rel NOT GLOB '*[^a-z_]*'),
  from_kind  TEXT NOT NULL,
  to_kind    TEXT NOT NULL,
  label_kind TEXT,
  ordered    INTEGER NOT NULL DEFAULT 0 CHECK (ordered IN (0,1)),
  anchored   INTEGER NOT NULL DEFAULT 0 CHECK (anchored IN (0,1)),
  PRIMARY KEY (rel, from_kind, to_kind)
) STRICT, WITHOUT ROWID;

-- table entity on entity
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
  FOREIGN KEY (kind, named) REFERENCES entity_kind(code, may_be_named) ON DELETE NO ACTION
) STRICT;

-- table entity_kind on entity_kind
CREATE TABLE entity_kind (
  code         TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*'),
  linkable     INTEGER NOT NULL CHECK (linkable IN (0,1)),
  may_be_top   INTEGER NOT NULL CHECK (may_be_top IN (0,1)),
  may_be_named INTEGER NOT NULL CHECK (may_be_named IN (0,1)),
  UNIQUE (code, may_be_top),
  UNIQUE (code, may_be_named)
) STRICT, WITHOUT ROWID;

-- table event on event
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

-- table event_guest on event_guest
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

-- table health_metric on health_metric
CREATE TABLE health_metric (
  code       TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_0-9]*'),
  cadence    TEXT NOT NULL CHECK (cadence IN ('total','reading')),
  has_value2 INTEGER NOT NULL CHECK (has_value2 IN (0,1)),
  unit       TEXT NOT NULL CHECK (length(trim(unit)) > 0),
  CHECK (cadence = 'reading' OR has_value2 = 0),
  UNIQUE (code, cadence),
  UNIQUE (code, cadence, has_value2)
) STRICT, WITHOUT ROWID;

-- table home_shape on home_shape
CREATE TABLE home_shape (
  kind      TEXT NOT NULL REFERENCES entity_kind(code) ON DELETE NO ACTION,
  home_kind TEXT NOT NULL REFERENCES entity_kind(code) ON DELETE NO ACTION,
  PRIMARY KEY (kind, home_kind)
) STRICT, WITHOUT ROWID;

-- table link on link
CREATE TABLE link (
  a          TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  b          TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  PRIMARY KEY (a, b),
  CHECK (a < b)
) STRICT, WITHOUT ROWID;

-- table locker_item on locker_item
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

-- table locker_item_field on locker_item_field
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

-- table locker_item_passkey on locker_item_passkey
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

-- table locker_key on locker_key
CREATE TABLE locker_key (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  key_id     TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  -- Unlocks the phone refused since the last one it allowed, and when the latest was (#1146).
  failed_unlocks   INTEGER NOT NULL DEFAULT 0 CHECK (failed_unlocks >= 0),
  failed_unlock_at TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', failed_unlock_at) IS failed_unlock_at)
) STRICT;

-- table locker_type on locker_type
CREATE TABLE locker_type (          -- A1: the 15 types; a 16th is a row, not a rebuild (I2)
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*')
) STRICT, WITHOUT ROWID;

-- table measurement on measurement
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

-- table mention on mention
CREATE TABLE mention (
  note_id  TEXT NOT NULL,
  ordinal  INTEGER NOT NULL CHECK (ordinal >= 0),
  wikilink TEXT NOT NULL CHECK (length(trim(wikilink)) > 0),
  to_id    TEXT REFERENCES entity(id) ON DELETE SET NULL,
  PRIMARY KEY (note_id, ordinal),
  FOREIGN KEY (note_id) REFERENCES note(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- table message on message
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

-- table message_attachment on message_attachment
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

-- table message_notice on message_notice
CREATE TABLE message_notice (       -- A1
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*')
) STRICT, WITHOUT ROWID;

-- table message_refusal on message_refusal
CREATE TABLE message_refusal (      -- A1
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*')
) STRICT, WITHOUT ROWID;

-- table note on note
CREATE TABLE note (
  id         TEXT PRIMARY KEY,
  kind       TEXT GENERATED ALWAYS AS ('note') VIRTUAL,
  body       TEXT NOT NULL DEFAULT '',
  format     TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown','plain')),
  journal_on TEXT CHECK (date(journal_on) IS journal_on),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

-- table note_asset on note_asset
CREATE TABLE note_asset (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  blob       TEXT NOT NULL REFERENCES blob(hash) ON DELETE NO ACTION,
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  media_type TEXT NOT NULL CHECK (length(trim(media_type)) > 0),
  position   REAL NOT NULL DEFAULT 0
) STRICT;

-- table occurrence on occurrence
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

-- table origin on origin
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
  FOREIGN KEY (system, fills_kind) REFERENCES origin_system(code, fills_kind) ON DELETE NO ACTION,
  FOREIGN KEY (system, retired)    REFERENCES origin_system(code, can_retire) ON DELETE NO ACTION,
  FOREIGN KEY (system, bound)      REFERENCES origin_system(code, on_device)  ON DELETE NO ACTION,
  FOREIGN KEY (fills, fills_kind)  REFERENCES entity(id, kind) ON DELETE NO ACTION
) STRICT;

-- table origin_system on origin_system
CREATE TABLE origin_system (
  code       TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z_]*'),
  fills_kind TEXT REFERENCES entity_kind(code) ON DELETE NO ACTION,
  can_retire INTEGER NOT NULL CHECK (can_retire IN (0,1)),
  on_device  INTEGER NOT NULL CHECK (on_device IN (0,1)),
  UNIQUE (code, fills_kind),
  UNIQUE (code, can_retire),
  UNIQUE (code, on_device)
) STRICT, WITHOUT ROWID;

-- table palette on palette
CREATE TABLE palette (
  key TEXT PRIMARY KEY CHECK (key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z]*')
) STRICT, WITHOUT ROWID;

-- table person on person
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

-- table person_date on person_date
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

-- table person_date_kind on person_date_kind
CREATE TABLE person_date_kind (
  code   TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*'),
  single INTEGER NOT NULL CHECK (single IN (0,1)),
  UNIQUE (code, single)
) STRICT, WITHOUT ROWID;

-- table person_form on person_form
CREATE TABLE person_form (
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*')
) STRICT, WITHOUT ROWID;

-- table photo on photo
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

-- table photo_form on photo_form
CREATE TABLE photo_form (           -- A1
  code TEXT PRIMARY KEY CHECK (code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z]*')
) STRICT, WITHOUT ROWID;

-- table place on place
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

-- table reading on reading
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

-- table reminder on reminder
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

-- table reminder_target on reminder_target
CREATE TABLE reminder_target (
  kind      TEXT NOT NULL REFERENCES entity_kind(code) ON DELETE NO ACTION,
  via_child INTEGER NOT NULL CHECK (via_child IN (0,1)),
  PRIMARY KEY (kind, via_child)
) STRICT, WITHOUT ROWID;

-- table revision on revision
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

-- table revision_blob on revision_blob
CREATE TABLE revision_blob (
  entity_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  slot       TEXT NOT NULL CHECK (length(trim(slot)) > 0),
  blob       TEXT NOT NULL REFERENCES blob(hash) ON DELETE NO ACTION,
  media_type TEXT CHECK (media_type IS NULL OR length(trim(media_type)) > 0),
  PRIMARY KEY (entity_id, seq, slot),
  FOREIGN KEY (entity_id, seq) REFERENCES revision(entity_id, seq) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- table rule on rule
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

-- table search_owed on search_owed
CREATE TABLE search_owed (
  n     INTEGER PRIMARY KEY,
  after TEXT
) STRICT;

-- table source on source
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

-- table source_shape on source_shape
CREATE TABLE source_shape (
  system      TEXT NOT NULL REFERENCES origin_system(code) ON DELETE NO ACTION,
  entity_kind TEXT NOT NULL REFERENCES entity_kind(code) ON DELETE NO ACTION,
  PRIMARY KEY (system, entity_kind)
) STRICT, WITHOUT ROWID;

-- table sqlite_sequence on sqlite_sequence
CREATE TABLE sqlite_sequence(name,seq);

-- table task on task
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

-- table thread on thread
CREATE TABLE thread (
  id    TEXT PRIMARY KEY,
  kind  TEXT GENERATED ALWAYS AS ('thread') VIRTUAL,
  scope TEXT,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

-- table touch on touch
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

-- table transfer on transfer
CREATE TABLE transfer (
  a TEXT PRIMARY KEY REFERENCES txn(id) ON DELETE CASCADE,
  b TEXT NOT NULL UNIQUE REFERENCES txn(id) ON DELETE CASCADE,
  CHECK (a < b)
) STRICT;

-- table txn on txn
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

-- table txn_split on txn_split
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

-- table vault on vault
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

-- table workout on workout
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

-- trigger account_currency_is_fixed on account
CREATE TRIGGER account_currency_is_fixed BEFORE UPDATE OF currency ON account
  WHEN new.currency <> old.currency AND EXISTS (SELECT 1 FROM txn WHERE account_id = old.id)
  BEGIN SELECT RAISE(ABORT, 'an account''s currency is fixed once it has lines'); END;

-- trigger edge_anchor_needs_an_anchored_shape on edge
CREATE TRIGGER edge_anchor_needs_an_anchored_shape BEFORE UPDATE OF anchor ON edge
  WHEN new.anchor IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM edge_shape s
      JOIN entity f ON f.id = new.from_id JOIN entity_kind fk ON fk.code = f.kind
      JOIN entity t ON t.id = new.to_id   JOIN entity_kind tk ON tk.code = t.kind
     WHERE s.rel = new.rel AND s.anchored = 1
       AND (s.from_kind = f.kind OR (s.from_kind = '*' AND fk.linkable = 1))
       AND (s.to_kind   = t.kind OR (s.to_kind   = '*' AND tk.linkable = 1)))
  BEGIN SELECT RAISE(ABORT, 'this edge cannot carry an anchor'); END;

-- trigger edge_ends_are_fixed on edge
CREATE TRIGGER edge_ends_are_fixed BEFORE UPDATE OF from_id, rel, to_id, label_id ON edge
  BEGIN SELECT RAISE(ABORT, 'an edge''s ends never change; remove it and add another'); END;

-- trigger edge_has_a_shape on edge
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

-- trigger entity_home_is_acyclic on entity
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

-- trigger entity_kind_is_fixed on entity
CREATE TRIGGER entity_kind_is_fixed BEFORE UPDATE OF id, kind ON entity
  BEGIN SELECT RAISE(ABORT, 'an entity''s id and kind never change'); END;

-- trigger link_ends_are_fixed on link
CREATE TRIGGER link_ends_are_fixed BEFORE UPDATE OF a, b ON link
  BEGIN SELECT RAISE(ABORT, 'a link''s ends never change; remove it and add another'); END;

-- trigger link_ends_are_linkable on link
CREATE TRIGGER link_ends_are_linkable BEFORE INSERT ON link
  WHEN EXISTS (SELECT 1 FROM entity e JOIN entity_kind k ON k.code = e.kind
                WHERE e.id IN (new.a, new.b) AND k.linkable = 0)
  BEGIN SELECT RAISE(ABORT, 'this kind of item cannot be linked'); END;

-- trigger mention_target_is_linkable on mention
CREATE TRIGGER mention_target_is_linkable BEFORE INSERT ON mention
  WHEN new.to_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM entity e JOIN entity_kind k ON k.code = e.kind WHERE e.id = new.to_id AND k.linkable = 0)
  BEGIN SELECT RAISE(ABORT, 'a note cannot mention this kind of item'); END;

-- trigger mention_target_is_linkable_on_resolve on mention
CREATE TRIGGER mention_target_is_linkable_on_resolve BEFORE UPDATE OF to_id ON mention
  WHEN new.to_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM entity e JOIN entity_kind k ON k.code = e.kind WHERE e.id = new.to_id AND k.linkable = 0)
  BEGIN SELECT RAISE(ABORT, 'a note cannot mention this kind of item'); END;

-- trigger message_is_not_born_settled on message
CREATE TRIGGER message_is_not_born_settled BEFORE INSERT ON message
  WHEN new.outcome IN ('applied','dismissed','stale','failed')
  BEGIN SELECT RAISE(ABORT, 'a message is proposed before it is settled: it is not born applied, dismissed, stale or failed'); END;

-- trigger message_outcome_settles_once on message
CREATE TRIGGER message_outcome_settles_once BEFORE UPDATE OF outcome ON message
  WHEN new.outcome IS NOT old.outcome
  BEGIN
    SELECT RAISE(ABORT, 'a told answer does not change: only a proposal settles, and once')
     WHERE old.outcome <> 'proposed';
    SELECT RAISE(ABORT, 'a proposal settles as applied, dismissed, stale or failed')
     WHERE new.outcome NOT IN ('applied','dismissed','stale','failed');
  END;

-- trigger revision_blob_is_history on revision_blob
CREATE TRIGGER revision_blob_is_history BEFORE UPDATE ON revision_blob
  BEGIN SELECT RAISE(ABORT, 'a revision is history'); END;

-- trigger revision_is_history on revision
CREATE TRIGGER revision_is_history
  BEFORE UPDATE OF entity_id, seq, at, actor, origin_id, cause, shape, state, body, autosave ON revision
  BEGIN SELECT RAISE(ABORT, 'a revision is history'); END;

-- trigger source_tombstone_is_final on source
CREATE TRIGGER source_tombstone_is_final BEFORE UPDATE OF entity_id ON source
  WHEN old.entity_id IS NULL AND new.entity_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a purged row''s source never takes a row again'); END;

-- trigger transfer_halves_are_in_one_pair on transfer
CREATE TRIGGER transfer_halves_are_in_one_pair BEFORE INSERT ON transfer
  WHEN EXISTS (SELECT 1 FROM transfer WHERE b = new.a OR a = new.b)
  BEGIN SELECT RAISE(ABORT, 'a line is in at most one transfer'); END;

-- trigger transfer_halves_are_in_one_pair_on_update on transfer
CREATE TRIGGER transfer_halves_are_in_one_pair_on_update BEFORE UPDATE OF a, b ON transfer
  WHEN EXISTS (SELECT 1 FROM transfer WHERE rowid <> old.rowid AND (b = new.a OR a = new.b))
  BEGIN SELECT RAISE(ABORT, 'a line is in at most one transfer'); END;

-- trigger txn_entered_only_becomes_a_statement on txn
CREATE TRIGGER txn_entered_only_becomes_a_statement BEFORE UPDATE OF entered ON txn
  WHEN new.entered <> old.entered AND NOT (old.entered = 'hand' AND new.entered = 'statement')
  BEGIN SELECT RAISE(ABORT, 'a line''s origin never changes but a hand line confirmed as a statement line'); END;

-- trigger txn_statement_line_is_fixed on txn
CREATE TRIGGER txn_statement_line_is_fixed
  BEFORE UPDATE OF account_id, posted_on, amount_minor, original_amount_minor, original_currency ON txn
  WHEN old.entered = 'statement'
  BEGIN SELECT RAISE(ABORT, 'a statement line is never edited'); END;
