-- THE VAULT'S BASELINE: the whole schema a new vault is founded with, and the rows that founding
-- seeds. One rung, hand-written ([#1135](https://github.com/srikanth235/centraid/issues/1135));
-- `docs/vault-ontology.md` says what each table means and why, and this file is what the
-- commitment tests in `crates/vault/tests/commitments.rs` read.
--
-- `contracts/schema/vault-ddl.sql` is the same schema ordered for READING, generated:
--
--   cargo run -p centraid-vault --bin export-ladder-ddl > contracts/schema/vault-ddl.sql
--
-- A rung is appended after this one and never edits it once released.

-- ---------------------------------------------------------------------------------------------
-- The kernel: the vault, the entity, the edge.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE vault (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  self_id    TEXT NOT NULL,
  self_kind  TEXT GENERATED ALWAYS AS ('person') VIRTUAL,
  currency   TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  zone       TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (self_id, self_kind) REFERENCES entity(id, kind) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE entity (
  n          INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN (
               'person','place','event','task','activity','note','document','photo',
               'account','txn','thread',
               'tag','flag','category','workout_kind','activity_kind','relation',
               'notebook','folder','album','list','project','section','area','calendar')),
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  deleted_at TEXT,
  purge_at   TEXT,
  CHECK ((deleted_at IS NULL) = (purge_at IS NULL)),
  UNIQUE (id, kind)
) STRICT;
CREATE INDEX entity_by_title   ON entity(kind, deleted_at, title, id);
CREATE INDEX entity_by_updated ON entity(kind, deleted_at, updated_at, id);
CREATE INDEX entity_purge      ON entity(purge_at) WHERE purge_at IS NOT NULL;
CREATE TRIGGER entity_kind_is_fixed BEFORE UPDATE OF id, kind ON entity
  BEGIN SELECT RAISE(ABORT, 'an entity''s id and kind never change'); END;

CREATE TABLE edge (
  from_id    TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  rel        TEXT NOT NULL CHECK (rel IN
               ('contains','tagged','about','links','attached','attendee','with','related')),
  to_id      TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  label_id   TEXT REFERENCES entity(id) ON DELETE CASCADE,
  position   REAL,
  state      TEXT CHECK (state IS NULL OR state IN ('needs-action','accepted','declined','tentative')),
  anchor     TEXT CHECK (anchor IS NULL OR json_valid(anchor)),
  created_at TEXT NOT NULL,
  CHECK (from_id <> to_id),
  CHECK ((label_id IS NOT NULL) = (rel = 'related')),
  CHECK (state IS NULL OR rel = 'attendee'),
  CHECK (position IS NULL OR rel = 'contains'),
  CHECK (anchor IS NULL OR rel IN ('about','links'))
) STRICT;
CREATE UNIQUE INDEX edge_key ON edge(from_id, rel, to_id, ifnull(label_id, ''));
CREATE INDEX edge_to    ON edge(to_id, rel, from_id);
CREATE INDEX edge_order ON edge(from_id, rel, position) WHERE position IS NOT NULL;
CREATE INDEX edge_label ON edge(label_id) WHERE label_id IS NOT NULL;

CREATE TABLE edge_shape (
  rel       TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  to_kind   TEXT NOT NULL,
  PRIMARY KEY (rel, from_kind, to_kind)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER edge_has_a_shape BEFORE INSERT ON edge
  WHEN NOT EXISTS (
    SELECT 1 FROM edge_shape s, entity f, entity t
     WHERE f.id = new.from_id AND t.id = new.to_id AND s.rel = new.rel
       AND s.from_kind IN (f.kind, '*') AND s.to_kind IN (t.kind, '*'))
    OR (new.label_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM entity WHERE id = new.label_id AND kind = 'relation'))
  BEGIN SELECT RAISE(ABORT, 'no edge of this relation joins these kinds'); END;
CREATE TRIGGER edge_ends_are_fixed BEFORE UPDATE OF from_id, rel, to_id, label_id ON edge
  BEGIN SELECT RAISE(ABORT, 'an edge''s ends never change; remove it and add another'); END;

CREATE TABLE concept (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('tag','flag','category','workout_kind','activity_kind','relation')),
  key       TEXT NOT NULL,
  parent_id TEXT REFERENCES concept(id),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  UNIQUE (kind, key)
) STRICT;
CREATE INDEX concept_by_parent ON concept(parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE container (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('notebook','folder','album','list','project','section','area','calendar')),
  parent_id TEXT REFERENCES container(id),
  color     TEXT,
  cover     TEXT REFERENCES blob(hash),
  position  REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;
CREATE INDEX container_by_parent ON container(parent_id) WHERE parent_id IS NOT NULL;
CREATE TRIGGER container_parent_shape BEFORE INSERT ON container
  WHEN new.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM container p WHERE p.id = new.parent_id AND
      ((new.kind IN ('folder','notebook') AND p.kind = new.kind)
    OR (new.kind = 'section' AND p.kind = 'project')
    OR (new.kind = 'project' AND p.kind = 'area')))
  BEGIN SELECT RAISE(ABORT, 'a container nests only in its own kind, a section in a project, a project in an area'); END;
CREATE TRIGGER container_parent_shape_on_move BEFORE UPDATE OF parent_id ON container
  WHEN new.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM container p WHERE p.id = new.parent_id AND
      ((new.kind IN ('folder','notebook') AND p.kind = new.kind)
    OR (new.kind = 'section' AND p.kind = 'project')
    OR (new.kind = 'project' AND p.kind = 'area')))
  BEGIN SELECT RAISE(ABORT, 'a container nests only in its own kind, a section in a project, a project in an area'); END;

-- ---------------------------------------------------------------------------------------------
-- Bytes: a blob is the vault's claim on bytes the content store names by the same hash.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE blob (
  hash TEXT PRIMARY KEY CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  size INTEGER NOT NULL CHECK (size >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE derivative (
  blob       TEXT NOT NULL REFERENCES blob(hash) ON DELETE CASCADE,
  variant    TEXT NOT NULL CHECK (variant IN ('thumb','preview','poster','text','caption','phash','thumbhash')),
  out        TEXT REFERENCES blob(hash),
  media_type TEXT,
  text       TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blob, variant),
  CHECK ((variant IN ('thumb','preview','poster')) = (out IS NOT NULL)),
  CHECK ((out IS NULL) = (media_type IS NULL)),
  CHECK ((out IS NULL) = (text IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE INDEX derivative_by_out ON derivative(out) WHERE out IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Following: where a row came from.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE origin (
  id         TEXT PRIMARY KEY,
  system     TEXT NOT NULL CHECK (system IN ('contacts','calendar','files','health','statement')),
  ref        TEXT NOT NULL CHECK (length(trim(ref)) > 0),
  label      TEXT NOT NULL CHECK (length(trim(label)) > 0),
  device_id  TEXT,
  fills      TEXT REFERENCES entity(id),
  config     TEXT CHECK (config IS NULL OR json_valid(config)),
  created_at TEXT NOT NULL,
  UNIQUE (system, ref),
  UNIQUE (id, system)
) STRICT;

CREATE TABLE source (
  id          TEXT PRIMARY KEY,
  origin_id   TEXT NOT NULL,
  system      TEXT NOT NULL,
  external_id TEXT NOT NULL CHECK (length(trim(external_id)) > 0),
  device_id   TEXT,
  entity_id   TEXT,
  entity_kind TEXT,
  stated      TEXT NOT NULL CHECK (json_valid(stated)),
  seen_at     TEXT NOT NULL,
  FOREIGN KEY (origin_id, system) REFERENCES origin(id, system),
  FOREIGN KEY (entity_id, entity_kind) REFERENCES entity(id, kind) ON DELETE SET NULL,
  CHECK ((entity_id IS NULL) = (entity_kind IS NULL)),
  CHECK (entity_kind IS NULL OR system || '/' || entity_kind IN
    ('contacts/person','calendar/event','files/document','health/activity','statement/txn'))
) STRICT;
CREATE UNIQUE INDEX source_key    ON source(origin_id, external_id, ifnull(device_id, ''));
CREATE UNIQUE INDEX source_entity ON source(entity_id) WHERE entity_id IS NOT NULL;
CREATE TRIGGER source_tombstone_is_final BEFORE UPDATE OF entity_id ON source
  WHEN old.entity_id IS NULL AND new.entity_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a purged row''s source never takes a row again'); END;

-- ---------------------------------------------------------------------------------------------
-- History and evidence.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE revision (
  entity_id  TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL CHECK (seq >= 1),
  at         TEXT NOT NULL,
  body       TEXT,
  blob       TEXT REFERENCES blob(hash),
  media_type TEXT,
  CHECK ((body IS NULL) <> (blob IS NULL)),
  CHECK ((blob IS NULL) = (media_type IS NULL)),
  PRIMARY KEY (entity_id, seq)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER revision_is_history BEFORE UPDATE ON revision
  BEGIN SELECT RAISE(ABORT, 'a revision is history'); END;

CREATE TABLE journal (
  seq     INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  command TEXT NOT NULL,
  input   TEXT NOT NULL CHECK (json_valid(input)),
  outcome TEXT NOT NULL CHECK (outcome IN ('executed','refused','failed')),
  detail  TEXT
) STRICT;
CREATE TRIGGER journal_is_evidence BEFORE UPDATE ON journal
  BEGIN SELECT RAISE(ABORT, 'the journal is evidence'); END;

-- ---------------------------------------------------------------------------------------------
-- Search: one index, kept by the writer. The FTS rowid is entity.n.
-- ---------------------------------------------------------------------------------------------

CREATE VIRTUAL TABLE search USING fts5(
  title, body, content = '', contentless_delete = 1,
  tokenize = "unicode61 remove_diacritics 2");
CREATE VIRTUAL TABLE search_vocab USING fts5vocab(search, row);

-- ---------------------------------------------------------------------------------------------
-- The kinds. Every kind row is its entity's own: kind is a generated constant, and the
-- composite foreign key is what keeps a person row from naming a note.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE person (
  id           TEXT PRIMARY KEY,
  kind         TEXT GENERATED ALWAYS AS ('person') VIRTUAL,
  form         TEXT NOT NULL DEFAULT 'person' CHECK (form IN ('person','org','group','pet')),
  sort_name    TEXT,
  nickname     TEXT,
  role         TEXT,
  met          TEXT,
  birthday     TEXT CHECK (birthday IS NULL
                 OR (length(birthday) = 5  AND date('2000-' || birthday) = '2000-' || birthday)
                 OR (length(birthday) = 10 AND date(birthday) = birthday)),
  avatar       TEXT REFERENCES blob(hash),
  cadence_days INTEGER CHECK (cadence_days IS NULL OR cadence_days > 0),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

CREATE TABLE contact_point (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('phone','email','address','url','handle')),
  value      TEXT NOT NULL CHECK (length(trim(value)) > 0),
  normalized TEXT NOT NULL,
  label      TEXT,
  preferred  INTEGER NOT NULL DEFAULT 0 CHECK (preferred IN (0,1)),
  position   REAL NOT NULL,
  UNIQUE (person_id, kind, normalized)
) STRICT;
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

CREATE TABLE event (
  id             TEXT PRIMARY KEY,
  kind           TEXT GENERATED ALWAYS AS ('event') VIRTUAL,
  starts         TEXT NOT NULL,
  ends           TEXT CHECK (ends IS NULL OR ends >= starts),
  timing         TEXT NOT NULL CHECK (timing IN ('zoned','floating','all-day')),
  zone           TEXT,
  rule           TEXT,
  rule_supported INTEGER NOT NULL DEFAULT 1 CHECK (rule_supported IN (0,1)),
  status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','tentative','cancelled')),
  busy           INTEGER NOT NULL DEFAULT 1 CHECK (busy IN (0,1)),
  calendar_id    TEXT NOT NULL,
  calendar_kind  TEXT GENERATED ALWAYS AS ('calendar') VIRTUAL,
  place_id       TEXT REFERENCES place(id),
  url            TEXT,
  reminders      TEXT CHECK (reminders IS NULL OR json_valid(reminders)),
  description    TEXT,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (calendar_id, calendar_kind) REFERENCES entity(id, kind),
  CHECK (timing <> 'zoned' OR (zone IS NOT NULL AND substr(starts, -1) = 'Z'))
) STRICT;
CREATE INDEX event_by_start    ON event(starts, id);
CREATE INDEX event_by_calendar ON event(calendar_id);
CREATE INDEX event_by_place    ON event(place_id) WHERE place_id IS NOT NULL;

CREATE TABLE occurrence (
  series_id      TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  original_start TEXT NOT NULL,
  cancelled      INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
  starts         TEXT,
  ends           TEXT,
  title          TEXT,
  description    TEXT,
  PRIMARY KEY (series_id, original_start)
) STRICT, WITHOUT ROWID;

CREATE TABLE task (
  id                TEXT PRIMARY KEY,
  kind              TEXT GENERATED ALWAYS AS ('task') VIRTUAL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  priority          INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 9),
  due               TEXT CHECK (due IS NULL OR (datetime(due) IS NOT NULL AND date(substr(due, 1, 10)) = substr(due, 1, 10))),
  done_at           TEXT CHECK ((status = 'done') = (done_at IS NOT NULL)),
  rule              TEXT,
  anchor            TEXT NOT NULL DEFAULT 'scheduled' CHECK (anchor IN ('scheduled','completion')),
  zone              TEXT,
  series_id         TEXT REFERENCES task(id),
  remind_before_min INTEGER CHECK (remind_before_min IS NULL OR remind_before_min >= 0),
  effort_min        INTEGER CHECK (effort_min IS NULL OR effort_min > 0),
  parent_id         TEXT REFERENCES task(id) CHECK (parent_id IS NULL OR parent_id <> id),
  project_id        TEXT,
  project_kind      TEXT GENERATED ALWAYS AS ('project') VIRTUAL,
  section_id        TEXT,
  section_kind      TEXT GENERATED ALWAYS AS ('section') VIRTUAL,
  description       TEXT,
  position          REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (project_id, project_kind) REFERENCES entity(id, kind),
  FOREIGN KEY (section_id, section_kind) REFERENCES entity(id, kind),
  CHECK (rule IS NULL OR due IS NOT NULL),
  CHECK (remind_before_min IS NULL OR due IS NOT NULL)
) STRICT;
CREATE INDEX task_by_due     ON task(status, due, id);
CREATE INDEX task_by_project ON task(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX task_by_section ON task(section_id) WHERE section_id IS NOT NULL;
CREATE INDEX task_by_parent  ON task(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX task_by_series  ON task(series_id) WHERE series_id IS NOT NULL;
CREATE TRIGGER task_hierarchy_is_acyclic BEFORE UPDATE OF parent_id ON task
  WHEN new.parent_id IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'that parent is already below this task: a task hierarchy has no loops')
     WHERE EXISTS (
       WITH RECURSIVE ancestors(id) AS (
         SELECT new.parent_id
         UNION
         SELECT t.parent_id FROM task t JOIN ancestors a ON t.id = a.id WHERE t.parent_id IS NOT NULL)
       SELECT 1 FROM ancestors WHERE id = new.id);
  END;
CREATE TRIGGER task_section_is_in_its_project_on_insert BEFORE INSERT ON task
  WHEN new.section_id IS NOT NULL
   AND (SELECT parent_id FROM container WHERE id = new.section_id) IS NOT new.project_id
  BEGIN SELECT RAISE(ABORT, 'that section belongs to a different project'); END;
CREATE TRIGGER task_section_is_in_its_project_on_update BEFORE UPDATE ON task
  WHEN new.section_id IS NOT NULL
   AND (SELECT parent_id FROM container WHERE id = new.section_id) IS NOT new.project_id
  BEGIN SELECT RAISE(ABORT, 'that section belongs to a different project'); END;

CREATE TABLE activity (
  id        TEXT PRIMARY KEY,
  kind      TEXT GENERATED ALWAYS AS ('activity') VIRTUAL,
  type_id   TEXT NOT NULL,
  type_kind TEXT NOT NULL CHECK (type_kind IN ('activity_kind','workout_kind')),
  starts    TEXT NOT NULL,
  ends      TEXT CHECK (ends IS NULL OR ends >= starts),
  place_id  TEXT REFERENCES place(id),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (type_id, type_kind) REFERENCES entity(id, kind)
) STRICT;
CREATE INDEX activity_by_start ON activity(starts, id);
CREATE INDEX activity_by_type  ON activity(type_id);
CREATE INDEX activity_by_place ON activity(place_id) WHERE place_id IS NOT NULL;

CREATE TABLE workout (
  id          TEXT PRIMARY KEY REFERENCES activity(id) ON DELETE CASCADE,
  recorded_by TEXT,
  moving_s    INTEGER CHECK (moving_s IS NULL OR moving_s > 0),
  distance_m  REAL CHECK (distance_m IS NULL OR distance_m >= 0),
  energy_kcal REAL CHECK (energy_kcal IS NULL OR energy_kcal >= 0),
  heart_bpm   INTEGER CHECK (heart_bpm IS NULL OR heart_bpm > 0),
  climb_m     REAL CHECK (climb_m IS NULL OR climb_m >= 0)
) STRICT;

CREATE TABLE measurement (
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  day       TEXT NOT NULL CHECK (date(day) = day),
  metric    TEXT NOT NULL CHECK (metric IN ('steps','active_energy_kcal','exercise_min','sleep_min','resting_hr_bpm','weight_kg')),
  value     REAL NOT NULL CHECK (value >= 0),
  PRIMARY KEY (person_id, day, metric)
) STRICT, WITHOUT ROWID;

CREATE TABLE note (
  id            TEXT PRIMARY KEY,
  kind          TEXT GENERATED ALWAYS AS ('note') VIRTUAL,
  body          TEXT NOT NULL DEFAULT '',
  format        TEXT NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown','plain')),
  notebook_id   TEXT,
  notebook_kind TEXT GENERATED ALWAYS AS ('notebook') VIRTUAL,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (notebook_id, notebook_kind) REFERENCES entity(id, kind)
) STRICT;
CREATE INDEX note_by_notebook ON note(notebook_id) WHERE notebook_id IS NOT NULL;

CREATE TABLE document (
  id          TEXT PRIMARY KEY,
  kind        TEXT GENERATED ALWAYS AS ('document') VIRTUAL,
  blob        TEXT NOT NULL REFERENCES blob(hash),
  media_type  TEXT NOT NULL,
  folder_id   TEXT,
  folder_kind TEXT GENERATED ALWAYS AS ('folder') VIRTUAL,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (folder_id, folder_kind) REFERENCES entity(id, kind)
) STRICT;
CREATE INDEX document_by_folder ON document(folder_id) WHERE folder_id IS NOT NULL;
CREATE INDEX document_by_blob   ON document(blob);

CREATE TABLE photo (
  id          TEXT PRIMARY KEY,
  kind        TEXT GENERATED ALWAYS AS ('photo') VIRTUAL,
  blob        TEXT NOT NULL UNIQUE REFERENCES blob(hash),
  media_type  TEXT NOT NULL,
  form        TEXT NOT NULL CHECK (form IN ('photo','video','scan')),
  taken_at    TEXT,
  offset_min  INTEGER CHECK (offset_min IS NULL OR offset_min BETWEEN -1080 AND 1080),
  width       INTEGER CHECK (width IS NULL OR width > 0),
  height      INTEGER CHECK (height IS NULL OR height > 0),
  duration_s  REAL CHECK (duration_s IS NULL OR duration_s >= 0),
  exif        TEXT CHECK (exif IS NULL OR json_valid(exif)),
  burst       TEXT,
  edited_from TEXT REFERENCES photo(id) CHECK (edited_from IS NULL OR edited_from <> id),
  place_id    TEXT REFERENCES place(id),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;
CREATE INDEX photo_by_taken       ON photo(taken_at, id);
CREATE INDEX photo_by_place       ON photo(place_id) WHERE place_id IS NOT NULL;
CREATE INDEX photo_by_edited_from ON photo(edited_from) WHERE edited_from IS NOT NULL;

CREATE TABLE account (
  id            TEXT PRIMARY KEY,
  kind          TEXT GENERATED ALWAYS AS ('account') VIRTUAL,
  type          TEXT NOT NULL CHECK (type IN ('checking','savings','credit_card','cash')),
  currency      TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  opening_minor INTEGER NOT NULL DEFAULT 0,
  on_budget     INTEGER NOT NULL DEFAULT 1 CHECK (on_budget IN (0,1)),
  UNIQUE (id, currency),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

CREATE TABLE txn (
  id            TEXT PRIMARY KEY,
  kind          TEXT GENERATED ALWAYS AS ('txn') VIRTUAL,
  account_id    TEXT NOT NULL,
  currency      TEXT NOT NULL,
  posted_on     TEXT NOT NULL CHECK (date(posted_on) = posted_on),
  amount_minor  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending','posted','void')),
  category_id   TEXT,
  category_kind TEXT GENERATED ALWAYS AS ('category') VIRTUAL,
  transfer_id   TEXT REFERENCES txn(id),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (account_id, currency) REFERENCES account(id, currency),
  FOREIGN KEY (category_id, category_kind) REFERENCES entity(id, kind)
) STRICT;
CREATE INDEX txn_by_account_day ON txn(account_id, posted_on, id);
CREATE INDEX txn_by_category    ON txn(category_id) WHERE category_id IS NOT NULL;
CREATE INDEX txn_by_transfer    ON txn(transfer_id) WHERE transfer_id IS NOT NULL;
CREATE TRIGGER txn_line_is_fixed BEFORE UPDATE OF account_id, currency, posted_on, amount_minor ON txn
  BEGIN SELECT RAISE(ABORT, 'a statement line is never edited'); END;
CREATE TRIGGER txn_void_is_final BEFORE UPDATE OF status ON txn WHEN old.status = 'void'
  BEGIN SELECT RAISE(ABORT, 'a voided line stays void'); END;

CREATE TABLE budget (
  category_id   TEXT NOT NULL,
  category_kind TEXT GENERATED ALWAYS AS ('category') VIRTUAL,
  month         TEXT NOT NULL CHECK (date(month || '-01') = month || '-01'),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency      TEXT NOT NULL CHECK (length(currency) = 3),
  carry         INTEGER NOT NULL DEFAULT 0 CHECK (carry IN (0,1)),
  PRIMARY KEY (category_id, month),
  FOREIGN KEY (category_id, category_kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE TABLE checkpoint (
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  day           TEXT NOT NULL CHECK (date(day) = day),
  balance_minor INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
) STRICT, WITHOUT ROWID;

CREATE TABLE rule (
  id            TEXT PRIMARY KEY,
  pattern       TEXT NOT NULL CHECK (json_valid(pattern)),
  category_id   TEXT NOT NULL,
  category_kind TEXT GENERATED ALWAYS AS ('category') VIRTUAL,
  position      REAL NOT NULL,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (category_id, category_kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

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
  outcome    TEXT NOT NULL CHECK (outcome IN (
               'sent','answered','stopped','refused',
               'proposed','applied','dismissed','stale','failed')),
  refusal    TEXT CHECK (refusal IS NULL OR refusal IN (
               'no_tool_fits','query_failed','unparsable','model_absent','model_failed',
               'vision_absent','attachment_unsupported','attachment_unreadable',
               'attachment_too_large')),
  notice     TEXT CHECK (notice IS NULL OR notice IN ('doc_truncated')),
  record     TEXT CHECK (record IS NULL OR json_valid(record)),
  cards      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(cards)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, ordinal),
  CHECK ((role = 'user') = (outcome = 'sent')),
  CHECK ((outcome = 'refused') = (refusal IS NOT NULL)),
  CHECK (role = 'assistant' OR (notice IS NULL AND record IS NULL))
) STRICT;
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
  position  INTEGER NOT NULL CHECK (position >= 0),
  form      TEXT NOT NULL CHECK (form IN ('photo','document','image')),
  label     TEXT NOT NULL,
  entity_id TEXT REFERENCES entity(id) ON DELETE SET NULL,
  thumb     TEXT REFERENCES blob(hash),
  PRIMARY KEY (thread_id, ordinal, position),
  FOREIGN KEY (thread_id, ordinal) REFERENCES message(thread_id, ordinal) ON DELETE CASCADE,
  CHECK ((form = 'image') = (thumb IS NOT NULL)),
  CHECK (form <> 'image' OR entity_id IS NULL)
) STRICT;
CREATE INDEX message_attachment_by_entity ON message_attachment(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX message_attachment_by_thumb  ON message_attachment(thumb) WHERE thumb IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Locker: its own tables, its own sealed cells, and nothing above. A Locker item is not an
-- entity: it is not searched, not tagged through `edge`, not attached to, not followed.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE locker_item (
  item_id      TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN (
    'login','card','note','identity','wifi','password',
    'ssh_key','api_credential','passport','bank_account','driving_licence',
    'software_licence','crypto_wallet','membership','document')),
  title        TEXT NOT NULL,
  username     TEXT,
  password     TEXT,
  url          TEXT,
  otp_seed     TEXT,
  notes        TEXT,
  cardholder   TEXT,
  card_number  TEXT,
  expiry       TEXT,
  cvv          TEXT,
  brand        TEXT,
  content      TEXT,
  fullname     TEXT,
  email        TEXT,
  phone        TEXT,
  address      TEXT,
  network      TEXT,
  compromised  INTEGER NOT NULL DEFAULT 0 CHECK (compromised IN (0,1)),
  password_set_at TEXT,
  starred      INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0,1)),
  memo         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  archived_at  TEXT,
  deleted_at   TEXT,
  purge_at     TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL), key_id TEXT,
  CHECK (archived_at IS NULL OR deleted_at IS NULL)
) STRICT;
CREATE INDEX locker_item_archived_idx ON locker_item(archived_at);
CREATE INDEX locker_item_purge_idx ON locker_item(purge_at) WHERE purge_at IS NOT NULL;
CREATE INDEX locker_item_type_idx ON locker_item(type);
CREATE INDEX locker_item_type_updated_page_idx ON locker_item(type, deleted_at, updated_at, item_id);
CREATE INDEX locker_item_updated_page_idx ON locker_item(updated_at, item_id);
CREATE TRIGGER locker_item_touch_updated_at
AFTER UPDATE ON locker_item
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE locker_item
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE item_id = NEW.item_id;
END;

CREATE TABLE locker_tag (
  item_id TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  label   TEXT NOT NULL CHECK (length(trim(label)) > 0),
  PRIMARY KEY (item_id, label)
) STRICT, WITHOUT ROWID;
CREATE INDEX locker_tag_by_label ON locker_tag(label, item_id);

CREATE TABLE locker_item_address (
  address_id   TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
) STRICT;
CREATE INDEX locker_item_address_item_idx ON locker_item_address(item_id, position);

CREATE TABLE locker_item_alias (
  alias      TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX locker_item_alias_item_idx ON locker_item_alias(item_id);

CREATE TABLE locker_item_field (
  field_id     TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES locker_item(item_id) ON DELETE CASCADE,
  section      TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('text','sealed','url','date','otp')),
  value_text   TEXT,
  value_sealed TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1), key_id TEXT,
  CHECK (kind = 'sealed' OR value_sealed IS NULL),
  CHECK (kind <> 'sealed' OR value_text IS NULL)
) STRICT;
CREATE INDEX locker_item_field_item_idx ON locker_item_field(item_id, section, position);
CREATE TRIGGER locker_item_field_touch_updated_at
AFTER UPDATE ON locker_item_field
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE locker_item_field
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE field_id = NEW.field_id;
END;

CREATE TABLE locker_item_passkey (
  item_id       TEXT PRIMARY KEY REFERENCES locker_item(item_id) ON DELETE CASCADE,
  rp_id         TEXT NOT NULL,
  user_handle   TEXT,
  display_name  TEXT,
  credential_id TEXT,
  algorithm     TEXT,
  private_key   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1), key_id TEXT
) STRICT;
CREATE INDEX locker_item_passkey_rp_idx ON locker_item_passkey(rp_id);
CREATE TRIGGER locker_item_passkey_touch_updated_at
AFTER UPDATE ON locker_item_passkey
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE locker_item_passkey
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE item_id = NEW.item_id;
END;

CREATE TABLE locker_key (
  key_id     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX locker_key_one_generation ON locker_key((1));

CREATE TABLE receipt (
  seq         INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  item_id     TEXT,
  act         TEXT NOT NULL,
  journal_seq INTEGER NOT NULL
) STRICT;
CREATE INDEX receipt_by_item ON receipt(item_id, seq) WHERE item_id IS NOT NULL;
CREATE TRIGGER receipt_is_evidence BEFORE UPDATE ON receipt
  BEGIN SELECT RAISE(ABORT, 'a receipt is evidence'); END;

-- ---------------------------------------------------------------------------------------------
-- Seeds: the rows founding writes, under fixed ids `<kind>:<key>`.
-- ---------------------------------------------------------------------------------------------

INSERT INTO edge_shape (rel, from_kind, to_kind) VALUES
  ('contains', 'album', 'photo'),
  ('contains', 'list', 'person'),
  ('tagged', '*', 'tag'),
  ('tagged', '*', 'flag'),
  ('about', 'note', '*'),
  ('about', 'task', '*'),
  ('about', 'event', '*'),
  ('links', 'note', '*'),
  ('attached', '*', 'document'),
  ('attached', '*', 'photo'),
  ('attendee', 'event', 'person'),
  ('with', 'activity', 'person'),
  ('related', 'person', 'person');

INSERT INTO entity (id, kind, title, created_at, updated_at) VALUES
  ('flag:starred', 'flag', 'Starred', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('flag:pinned', 'flag', 'Pinned', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('flag:archived', 'flag', 'Archived', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:income', 'category', 'Income', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:housing', 'category', 'Housing', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:utilities', 'category', 'Utilities', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:food', 'category', 'Food', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:transport', 'category', 'Transport', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:shopping', 'category', 'Shopping', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:health', 'category', 'Health', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:fun', 'category', 'Fun and travel', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:fees', 'category', 'Fees and taxes', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:income.pay', 'category', 'Pay', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:income.other', 'category', 'Other income', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:housing.rent', 'category', 'Rent or mortgage', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:housing.home', 'category', 'Home and repairs', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:utilities.bills', 'category', 'Power, gas and water', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:utilities.phone', 'category', 'Phone and internet', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:food.groceries', 'category', 'Groceries', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:food.dining', 'category', 'Dining out', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:transport.fuel', 'category', 'Fuel', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:transport.transit', 'category', 'Transit and rideshare', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:shopping.general', 'category', 'Clothes and household', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:health.care', 'category', 'Health care', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:fun.subscriptions', 'category', 'Subscriptions', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('category:fun.entertainment', 'category', 'Entertainment and travel', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('workout_kind:run', 'workout_kind', 'Run', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('workout_kind:walk', 'workout_kind', 'Walk', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('workout_kind:cycle', 'workout_kind', 'Cycle', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('workout_kind:strength', 'workout_kind', 'Strength', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('workout_kind:swim', 'workout_kind', 'Swim', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('workout_kind:hike', 'workout_kind', 'Hike', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('workout_kind:yoga', 'workout_kind', 'Yoga', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('workout_kind:other', 'workout_kind', 'Other', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('activity_kind:message', 'activity_kind', 'Message', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('activity_kind:call', 'activity_kind', 'Call', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('activity_kind:met-up', 'activity_kind', 'Met up', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('activity_kind:note', 'activity_kind', 'Note', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('relation:related', 'relation', 'Related', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'),
  ('calendar:default', 'calendar', 'Calendar', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');

INSERT INTO concept (id, kind, key, parent_id) VALUES
  ('flag:starred', 'flag', 'starred', NULL),
  ('flag:pinned', 'flag', 'pinned', NULL),
  ('flag:archived', 'flag', 'archived', NULL),
  ('category:income', 'category', 'income', NULL),
  ('category:housing', 'category', 'housing', NULL),
  ('category:utilities', 'category', 'utilities', NULL),
  ('category:food', 'category', 'food', NULL),
  ('category:transport', 'category', 'transport', NULL),
  ('category:shopping', 'category', 'shopping', NULL),
  ('category:health', 'category', 'health', NULL),
  ('category:fun', 'category', 'fun', NULL),
  ('category:fees', 'category', 'fees', NULL),
  ('category:income.pay', 'category', 'income.pay', 'category:income'),
  ('category:income.other', 'category', 'income.other', 'category:income'),
  ('category:housing.rent', 'category', 'housing.rent', 'category:housing'),
  ('category:housing.home', 'category', 'housing.home', 'category:housing'),
  ('category:utilities.bills', 'category', 'utilities.bills', 'category:utilities'),
  ('category:utilities.phone', 'category', 'utilities.phone', 'category:utilities'),
  ('category:food.groceries', 'category', 'food.groceries', 'category:food'),
  ('category:food.dining', 'category', 'food.dining', 'category:food'),
  ('category:transport.fuel', 'category', 'transport.fuel', 'category:transport'),
  ('category:transport.transit', 'category', 'transport.transit', 'category:transport'),
  ('category:shopping.general', 'category', 'shopping.general', 'category:shopping'),
  ('category:health.care', 'category', 'health.care', 'category:health'),
  ('category:fun.subscriptions', 'category', 'fun.subscriptions', 'category:fun'),
  ('category:fun.entertainment', 'category', 'fun.entertainment', 'category:fun'),
  ('workout_kind:run', 'workout_kind', 'run', NULL),
  ('workout_kind:walk', 'workout_kind', 'walk', NULL),
  ('workout_kind:cycle', 'workout_kind', 'cycle', NULL),
  ('workout_kind:strength', 'workout_kind', 'strength', NULL),
  ('workout_kind:swim', 'workout_kind', 'swim', NULL),
  ('workout_kind:hike', 'workout_kind', 'hike', NULL),
  ('workout_kind:yoga', 'workout_kind', 'yoga', NULL),
  ('workout_kind:other', 'workout_kind', 'other', NULL),
  ('activity_kind:message', 'activity_kind', 'message', NULL),
  ('activity_kind:call', 'activity_kind', 'call', NULL),
  ('activity_kind:met-up', 'activity_kind', 'met-up', NULL),
  ('activity_kind:note', 'activity_kind', 'note', NULL),
  ('relation:related', 'relation', 'related', NULL);

INSERT INTO container (id, kind) VALUES ('calendar:default', 'calendar');
