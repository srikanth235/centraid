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

-- index action_key_by_at on action_key
CREATE INDEX action_key_by_at ON action_key(at);

-- index activity_by_place on activity
CREATE INDEX activity_by_place ON activity(place_id) WHERE place_id IS NOT NULL;

-- index activity_by_start on activity
CREATE INDEX activity_by_start ON activity(starts, id);

-- index activity_by_type on activity
CREATE INDEX activity_by_type  ON activity(type_id);

-- index alert_by_fire on alert
CREATE INDEX alert_by_fire ON alert(timing, fire_key, entity_id);

-- index budget_by_month on budget
CREATE INDEX budget_by_month ON budget(month, category_id);

-- index concept_by_parent on concept
CREATE INDEX concept_by_parent ON concept(parent_id) WHERE parent_id IS NOT NULL;

-- index contact_point_by_value on contact_point
CREATE INDEX contact_point_by_value ON contact_point(kind, normalized, person_id);

-- index contact_point_preferred on contact_point
CREATE UNIQUE INDEX contact_point_preferred ON contact_point(person_id, kind) WHERE preferred = 1;

-- index container_by_cover on container
CREATE INDEX container_by_cover  ON container(cover) WHERE cover IS NOT NULL;

-- index container_by_parent on container
CREATE INDEX container_by_parent ON container(parent_id) WHERE parent_id IS NOT NULL;

-- index derivative_by_out on derivative
CREATE INDEX derivative_by_out ON derivative(out) WHERE out IS NOT NULL;

-- index document_by_blob on document
CREATE INDEX document_by_blob   ON document(blob);

-- index document_by_folder on document
CREATE INDEX document_by_folder ON document(folder_id) WHERE folder_id IS NOT NULL;

-- index edge_key on edge
CREATE UNIQUE INDEX edge_key ON edge(from_id, rel, to_id, ifnull(label_id, ''));

-- index edge_label on edge
CREATE INDEX edge_label ON edge(label_id) WHERE label_id IS NOT NULL;

-- index edge_order on edge
CREATE INDEX edge_order ON edge(from_id, rel, position) WHERE position IS NOT NULL;

-- index edge_to on edge
CREATE INDEX edge_to    ON edge(to_id, rel, from_id);

-- index entity_by_created on entity
CREATE INDEX entity_by_created ON entity(kind, created_at, id);

-- index entity_by_title on entity
CREATE INDEX entity_by_title   ON entity(kind, deleted_at, title, id);

-- index entity_by_title_nocase on entity
CREATE INDEX entity_by_title_nocase ON entity(kind, title COLLATE NOCASE, created_at, id) WHERE deleted_at IS NULL;

-- index entity_by_updated on entity
CREATE INDEX entity_by_updated ON entity(kind, deleted_at, updated_at, id);

-- index entity_purge on entity
CREATE INDEX entity_purge      ON entity(purge_at) WHERE purge_at IS NOT NULL;

-- index entity_trashed on entity
CREATE INDEX entity_trashed    ON entity(deleted_at, n) WHERE deleted_at IS NOT NULL;

-- index event_by_calendar on event
CREATE INDEX event_by_calendar ON event(calendar_id);

-- index event_by_place on event
CREATE INDEX event_by_place    ON event(place_id) WHERE place_id IS NOT NULL;

-- index event_by_rule on event
CREATE INDEX event_by_rule ON event(starts, id) WHERE rule IS NOT NULL;

-- index event_by_start on event
CREATE INDEX event_by_start    ON event(starts, id);

-- index locker_item_address_by_item on locker_item_address
CREATE INDEX locker_item_address_by_item ON locker_item_address(item_id, position);

-- index locker_item_alias_by_item on locker_item_alias
CREATE INDEX locker_item_alias_by_item ON locker_item_alias(item_id);

-- index locker_item_by_key on locker_item
CREATE INDEX locker_item_by_key ON locker_item(key_id) WHERE key_id IS NOT NULL;

-- index locker_item_field_by_item on locker_item_field
CREATE INDEX locker_item_field_by_item ON locker_item_field(item_id, section, position);

-- index locker_item_field_by_key on locker_item_field
CREATE INDEX locker_item_field_by_key ON locker_item_field(key_id) WHERE key_id IS NOT NULL;

-- index locker_item_passkey_by_key on locker_item_passkey
CREATE INDEX locker_item_passkey_by_key ON locker_item_passkey(key_id) WHERE key_id IS NOT NULL;

-- index message_attachment_by_entity on message_attachment
CREATE INDEX message_attachment_by_entity ON message_attachment(entity_id) WHERE entity_id IS NOT NULL;

-- index message_attachment_by_thumb on message_attachment
CREATE INDEX message_attachment_by_thumb  ON message_attachment(thumb) WHERE thumb IS NOT NULL;

-- index note_by_notebook on note
CREATE INDEX note_by_notebook ON note(notebook_id, id) WHERE notebook_id IS NOT NULL;

-- index occurrence_by_place on occurrence
CREATE INDEX occurrence_by_place ON occurrence(place_id) WHERE place_id IS NOT NULL;

-- index origin_one_statement_per_account on origin
CREATE UNIQUE INDEX origin_one_statement_per_account ON origin(fills) WHERE system = 'statement';

-- index person_by_avatar on person
CREATE INDEX person_by_avatar ON person(avatar) WHERE avatar IS NOT NULL;

-- index photo_by_burst on photo
CREATE INDEX photo_by_burst       ON photo(burst) WHERE burst IS NOT NULL;

-- index photo_by_edited_from on photo
CREATE INDEX photo_by_edited_from ON photo(edited_from) WHERE edited_from IS NOT NULL;

-- index photo_by_place on photo
CREATE INDEX photo_by_place       ON photo(place_id) WHERE place_id IS NOT NULL;

-- index photo_by_taken on photo
CREATE INDEX photo_by_taken       ON photo(taken_at, id);

-- index revision_by_blob on revision
CREATE INDEX revision_by_blob ON revision(blob) WHERE blob IS NOT NULL;

-- index rule_by_category on rule
CREATE INDEX rule_by_category ON rule(category_id);

-- index source_by_seen on source
CREATE INDEX source_by_seen ON source(system, seen_at, id);

-- index source_entity on source
CREATE UNIQUE INDEX source_entity ON source(entity_id) WHERE entity_id IS NOT NULL;

-- index source_key on source
CREATE UNIQUE INDEX source_key    ON source(origin_id, external_id, ifnull(device_id, ''));

-- index task_by_done on task
CREATE INDEX task_by_done    ON task(status, done_at, id);

-- index task_by_due on task
CREATE INDEX task_by_due     ON task(status, due, id);

-- index task_by_parent on task
CREATE INDEX task_by_parent  ON task(parent_id) WHERE parent_id IS NOT NULL;

-- index task_by_project on task
CREATE INDEX task_by_project ON task(project_id) WHERE project_id IS NOT NULL;

-- index task_by_section on task
CREATE INDEX task_by_section ON task(section_id) WHERE section_id IS NOT NULL;

-- index task_by_series on task
CREATE INDEX task_by_series  ON task(series_id) WHERE series_id IS NOT NULL;

-- index txn_by_account_day on txn
CREATE INDEX txn_by_account_day ON txn(account_id, posted_on, id);

-- index txn_by_category on txn
CREATE INDEX txn_by_category    ON txn(category_id) WHERE category_id IS NOT NULL;

-- index txn_by_day on txn
CREATE INDEX txn_by_day         ON txn(posted_on, id);

-- table account on account
CREATE TABLE account (
  id            TEXT PRIMARY KEY,
  kind          TEXT GENERATED ALWAYS AS ('account') VIRTUAL,
  type          TEXT NOT NULL CHECK (type IN ('checking','savings','credit_card','cash')),
  currency      TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  -- Where the account stood on `opening_on`, SIGNED (a card owes: negative). The balance on any
  -- day is this plus the posted lines AFTER `opening_on`, derived at read time; an account with no
  -- opening day counts every line. A day, so a statement imported from before it does not count
  -- twice.
  opening_minor INTEGER NOT NULL DEFAULT 0,
  opening_on    TEXT CHECK (opening_on IS NULL OR date(opening_on) = opening_on),
  on_budget     INTEGER NOT NULL DEFAULT 1 CHECK (on_budget IN (0,1)),
  UNIQUE (id, currency),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

-- table action_key on action_key
CREATE TABLE action_key (
  key   TEXT PRIMARY KEY,
  asked TEXT NOT NULL,
  at    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', at) IS at)
) STRICT, WITHOUT ROWID;

-- table activity on activity
CREATE TABLE activity (
  id        TEXT PRIMARY KEY,
  kind      TEXT GENERATED ALWAYS AS ('activity') VIRTUAL,
  type_id   TEXT NOT NULL,
  type_kind TEXT NOT NULL CHECK (type_kind IN ('activity_kind','workout_kind')),
  starts    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', starts) IS starts),
  ends      TEXT CHECK ((ends IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', ends) IS ends) AND ends >= starts),
  place_id  TEXT REFERENCES place(id),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (type_id, type_kind) REFERENCES entity(id, kind),
  UNIQUE (id, type_kind)
) STRICT;

-- table alert on alert
CREATE TABLE alert (
  entity_id  TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  offset_min INTEGER NOT NULL CHECK (offset_min >= 0),
  timing     TEXT NOT NULL CHECK (timing IN ('fixed','floating')),
  fire_key   TEXT NOT NULL CHECK (CASE timing WHEN 'fixed' THEN strftime('%Y-%m-%dT%H:%M:%fZ', fire_key) IS fire_key ELSE strftime('%Y-%m-%dT%H:%M', fire_key) IS fire_key END),
  repeats    INTEGER NOT NULL DEFAULT 0 CHECK (repeats IN (0,1)),
  PRIMARY KEY (entity_id, offset_min)
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
  month         TEXT NOT NULL CHECK (date(month || '-01') = month || '-01'),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency      TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  carry         INTEGER NOT NULL DEFAULT 0 CHECK (carry IN (0,1)),
  PRIMARY KEY (category_id, month),
  FOREIGN KEY (category_id, category_kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- table checkpoint on checkpoint
CREATE TABLE checkpoint (
  account_id    TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  day           TEXT NOT NULL CHECK (date(day) = day),
  balance_minor INTEGER NOT NULL,
  PRIMARY KEY (account_id, day)
) STRICT, WITHOUT ROWID;

-- table concept on concept
CREATE TABLE concept (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('tag','flag','category','workout_kind','activity_kind','relation')),
  key       TEXT NOT NULL,
  parent_id TEXT REFERENCES concept(id) CHECK (parent_id IS NULL OR parent_id <> id),
  -- A label's colour: one key of the design palette ([list] in design/tokens.toml). Tags only.
  color     TEXT CHECK (color IS NULL OR (kind = 'tag' AND color IN
              ('blue','mustard','violet','petrol','indigo','graphite','raspberry','orchid'))),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  UNIQUE (kind, key)
) STRICT;

-- table contact_point on contact_point
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

-- table container on container
CREATE TABLE container (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL CHECK (kind IN ('notebook','folder','album','list','project','section','area','calendar')),
  parent_id TEXT REFERENCES container(id) CHECK (parent_id IS NULL OR parent_id <> id),
  -- A list's or a project's colour is a key of the design palette (`LIST_COLORS`); a calendar a phone
  -- paints wears a hue of the party wheel (`var(--c-<hue>)`), which the shell names from the phone's colour.
  color     TEXT CHECK (color IS NULL OR color IN
              ('blue','mustard','violet','petrol','indigo','graphite','raspberry','orchid',
               'var(--c-rose)','var(--c-amber)','var(--c-ochre)','var(--c-forest)',
               'var(--c-teal)','var(--c-slate)','var(--c-indigo)','var(--c-violet)')),
  -- A key of `design/icons.toml`; the command boundary says which keys a list or calendar may wear.
  icon      TEXT CHECK (icon IS NULL OR length(trim(icon)) > 0),
  cover     TEXT REFERENCES blob(hash),
  position  REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

-- table derivative on derivative
CREATE TABLE derivative (
  blob       TEXT NOT NULL REFERENCES blob(hash) ON DELETE CASCADE,
  variant    TEXT NOT NULL CHECK (variant IN ('thumb','preview','poster','text','caption','phash','thumbhash')),
  out        TEXT REFERENCES blob(hash),
  media_type TEXT,
  text       TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  PRIMARY KEY (blob, variant),
  CHECK ((variant IN ('thumb','preview','poster')) = (out IS NOT NULL)),
  CHECK ((out IS NULL) = (media_type IS NULL)),
  CHECK ((out IS NULL) = (text IS NOT NULL))
) STRICT;

-- table document on document
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

-- table edge on edge
CREATE TABLE edge (
  from_id    TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  rel        TEXT NOT NULL CHECK (rel IN
               ('contains','tagged','about','links','attached','attendee','with','related','depicts')),
  to_id      TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  label_id   TEXT REFERENCES entity(id) ON DELETE CASCADE,
  position   REAL,
  state      TEXT CHECK (state IS NULL OR state IN ('needs-action','accepted','declined','tentative')),
  anchor     TEXT CHECK (anchor IS NULL OR json_valid(anchor)),
  -- The `[[title]]` words of the note that compiled this link (the note owns it and recompiles it
  -- on every save); NULL for a link the member made.
  wikilink   TEXT CHECK (wikilink IS NULL OR (rel = 'links' AND length(trim(wikilink)) > 0)),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (from_id <> to_id),
  CHECK ((label_id IS NOT NULL) = (rel = 'related')),
  CHECK (state IS NULL OR rel = 'attendee'),
  CHECK (position IS NULL OR rel = 'contains'),
  CHECK (anchor IS NULL OR rel IN ('about','links'))
) STRICT;

-- table edge_shape on edge_shape
CREATE TABLE edge_shape (
  rel       TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  to_kind   TEXT NOT NULL,
  PRIMARY KEY (rel, from_kind, to_kind)
) STRICT, WITHOUT ROWID;

-- table entity on entity
CREATE TABLE entity (
  n          INTEGER PRIMARY KEY,
  id         TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL CHECK (kind IN (
               'person','place','event','task','activity','note','document','photo',
               'account','txn','thread',
               'tag','flag','category','workout_kind','activity_kind','relation',
               'notebook','folder','album','list','project','section','area','calendar',
               'locker_item')),
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  deleted_at TEXT CHECK (deleted_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) IS deleted_at),
  purge_at   TEXT CHECK (purge_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', purge_at) IS purge_at),
  CHECK ((deleted_at IS NULL) = (purge_at IS NULL)),
  UNIQUE (id, kind)
) STRICT;

-- table event on event
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
  -- Minutes of travel the member allows before it starts.
  travel_min     INTEGER CHECK (travel_min IS NULL OR travel_min >= 0),
  description    TEXT,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (calendar_id, calendar_kind) REFERENCES entity(id, kind),
  CHECK (timing <> 'zoned' OR zone IS NOT NULL),
  -- `starts` and `ends` read under `timing`: a zoned time is an instant, a floating one a wall
  -- clock, an all-day one a date.
  CHECK (CASE timing WHEN 'zoned' THEN strftime('%Y-%m-%dT%H:%M:%fZ', starts) IS starts WHEN 'floating' THEN (strftime('%Y-%m-%dT%H:%M', starts) IS starts OR strftime('%Y-%m-%dT%H:%M:%S', starts) IS starts OR strftime('%Y-%m-%dT%H:%M:%f', starts) IS starts) ELSE date(starts) IS starts END),
  CHECK (ends IS NULL OR CASE timing WHEN 'zoned' THEN strftime('%Y-%m-%dT%H:%M:%fZ', ends) IS ends WHEN 'floating' THEN (strftime('%Y-%m-%dT%H:%M', ends) IS ends OR strftime('%Y-%m-%dT%H:%M:%S', ends) IS ends OR strftime('%Y-%m-%dT%H:%M:%f', ends) IS ends) ELSE date(ends) IS ends END)
) STRICT;

-- table locker_item on locker_item
CREATE TABLE locker_item (
  id           TEXT PRIMARY KEY,
  kind         TEXT GENERATED ALWAYS AS ('locker_item') VIRTUAL,
  type         TEXT NOT NULL CHECK (type IN (
    'login','card','note','identity','wifi','password',
    'ssh_key','api_credential','passport','bank_account','driving_licence',
    'software_licence','crypto_wallet','membership','document')),
  -- A type owns the typed columns it names (`type_fields` in commands/locker.rs) and no others: the
  -- command nulls the rest on write, and the database refuses a row that keeps one.
  username     TEXT CHECK (username IS NULL OR type = 'login'),
  password     TEXT CHECK (password IS NULL OR type IN ('login','wifi','password')),
  url          TEXT CHECK (url IS NULL OR type = 'login'),
  otp_seed     TEXT CHECK (otp_seed IS NULL OR type = 'login'),
  notes        TEXT CHECK (notes IS NULL OR type NOT IN ('card','note','identity','wifi','password')),
  cardholder   TEXT CHECK (cardholder IS NULL OR type = 'card'),
  card_number  TEXT CHECK (card_number IS NULL OR type = 'card'),
  expiry       TEXT CHECK (expiry IS NULL OR type = 'card'),
  cvv          TEXT CHECK (cvv IS NULL OR type = 'card'),
  brand        TEXT CHECK (brand IS NULL OR type = 'card'),
  content      TEXT CHECK (content IS NULL OR type = 'note'),
  fullname     TEXT CHECK (fullname IS NULL OR type = 'identity'),
  email        TEXT CHECK (email IS NULL OR type = 'identity'),
  phone        TEXT CHECK (phone IS NULL OR type = 'identity'),
  address      TEXT CHECK (address IS NULL OR type = 'identity'),
  network      TEXT CHECK (network IS NULL OR type = 'wifi'),
  compromised  INTEGER NOT NULL DEFAULT 0 CHECK (compromised IN (0,1)),
  password_set_at TEXT CHECK (password_set_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', password_set_at) IS password_set_at),
  memo         TEXT,
  -- The generation of the Locker key the item's sealed cells were sealed under.
  key_id       TEXT REFERENCES locker_key(key_id) DEFERRABLE INITIALLY DEFERRED,
  -- When the core last opened one of this item's sealed cells (#1146). A use is not an edit:
  -- stamping it does not move the entity's `updated_at`, and makes no revision.
  last_used_at TEXT CHECK (last_used_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at) IS last_used_at),
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

-- table locker_item_address on locker_item_address
CREATE TABLE locker_item_address (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES locker_item(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  position     REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
) STRICT;

-- table locker_item_alias on locker_item_alias
CREATE TABLE locker_item_alias (
  id         TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES locker_item(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
) STRICT;

-- table locker_item_field on locker_item_field
CREATE TABLE locker_item_field (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES locker_item(id) ON DELETE CASCADE,
  section      TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('text','sealed','url','date','otp')),
  value_text   TEXT,
  value_sealed TEXT,
  position     REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at   TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  key_id       TEXT REFERENCES locker_key(key_id) DEFERRABLE INITIALLY DEFERRED,
  -- A one-time-code seed is a secret like a `sealed` value: `otp` keeps its kind so the page shows
  -- a rolling code, but its value lives only as `lk1:` ciphertext, never in the plain column.
  CHECK (kind IN ('sealed', 'otp') OR value_sealed IS NULL),
  CHECK (kind NOT IN ('sealed', 'otp') OR value_text IS NULL),
  CHECK (kind <> 'otp' OR value_sealed IS NOT NULL)
) STRICT;

-- table locker_item_passkey on locker_item_passkey
CREATE TABLE locker_item_passkey (
  item_id       TEXT PRIMARY KEY REFERENCES locker_item(id) ON DELETE CASCADE,
  rp_id         TEXT NOT NULL,
  user_handle   TEXT,
  display_name  TEXT,
  credential_id TEXT,
  algorithm     TEXT,
  private_key   TEXT,
  created_at    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  key_id        TEXT REFERENCES locker_key(key_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- table locker_key on locker_key
CREATE TABLE locker_key (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  key_id     TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  -- Unlocks the phone refused since the last one it allowed, and when the latest was (#1146).
  -- A successful unlock resets the count and leaves the time.
  failed_unlocks  INTEGER NOT NULL DEFAULT 0 CHECK (failed_unlocks >= 0),
  failed_unlock_at TEXT CHECK (failed_unlock_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', failed_unlock_at) IS failed_unlock_at)
) STRICT;

-- table measurement on measurement
CREATE TABLE measurement (
  person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  day       TEXT NOT NULL CHECK (date(day) = day),
  metric    TEXT NOT NULL CHECK (metric IN ('steps','active_energy_kcal','exercise_min','sleep_min','resting_hr_bpm','weight_kg')),
  value     REAL NOT NULL CHECK (value >= 0),
  PRIMARY KEY (person_id, day, metric)
) STRICT, WITHOUT ROWID;

-- table message on message
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
  thumb     TEXT REFERENCES blob(hash),
  PRIMARY KEY (thread_id, ordinal, position),
  FOREIGN KEY (thread_id, ordinal) REFERENCES message(thread_id, ordinal) ON DELETE CASCADE,
  CHECK ((form = 'image') = (thumb IS NOT NULL)),
  CHECK (form <> 'image' OR entity_id IS NULL)
) STRICT;

-- table note on note
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

-- table occurrence on occurrence
CREATE TABLE occurrence (
  series_id      TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  original_start TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'occurrence' CHECK (scope IN ('occurrence','future')),
  cancelled      INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
  starts         TEXT,
  ends           TEXT,
  -- How `starts`/`ends` of THIS day read, when they are not the series' own way (an all-day
  -- series' day moved to 15:00, a zoned series' day made all-day); NULL is the series' timing.
  -- A zoned day of another timing names its zone; one that is zoned like its series keeps the
  -- series' (#1146).
  timing         TEXT CHECK (timing IS NULL OR timing IN ('zoned','floating','all-day')),
  zone           TEXT CHECK (zone IS NULL OR timing IS 'zoned'),
  title          TEXT,
  description    TEXT,
  -- This day's own link and place; NULL is the series'. Guests and reminders stay the series' (#1146).
  url            TEXT,
  place_id       TEXT REFERENCES place(id),
  PRIMARY KEY (series_id, original_start, scope),
  CHECK ((date(original_start) IS original_start OR (strftime('%Y-%m-%dT%H:%M', original_start) IS original_start OR strftime('%Y-%m-%dT%H:%M:%S', original_start) IS original_start OR strftime('%Y-%m-%dT%H:%M:%f', original_start) IS original_start) OR strftime('%Y-%m-%dT%H:%M:%fZ', original_start) IS original_start)),
  CHECK (starts IS NULL OR CASE timing WHEN 'zoned' THEN strftime('%Y-%m-%dT%H:%M:%fZ', starts) IS starts WHEN 'floating' THEN (strftime('%Y-%m-%dT%H:%M', starts) IS starts OR strftime('%Y-%m-%dT%H:%M:%S', starts) IS starts OR strftime('%Y-%m-%dT%H:%M:%f', starts) IS starts) WHEN 'all-day' THEN date(starts) IS starts ELSE (date(starts) IS starts OR (strftime('%Y-%m-%dT%H:%M', starts) IS starts OR strftime('%Y-%m-%dT%H:%M:%S', starts) IS starts OR strftime('%Y-%m-%dT%H:%M:%f', starts) IS starts) OR strftime('%Y-%m-%dT%H:%M:%fZ', starts) IS starts) END),
  CHECK (ends IS NULL OR CASE timing WHEN 'zoned' THEN strftime('%Y-%m-%dT%H:%M:%fZ', ends) IS ends WHEN 'floating' THEN (strftime('%Y-%m-%dT%H:%M', ends) IS ends OR strftime('%Y-%m-%dT%H:%M:%S', ends) IS ends OR strftime('%Y-%m-%dT%H:%M:%f', ends) IS ends) WHEN 'all-day' THEN date(ends) IS ends ELSE (date(ends) IS ends OR (strftime('%Y-%m-%dT%H:%M', ends) IS ends OR strftime('%Y-%m-%dT%H:%M:%S', ends) IS ends OR strftime('%Y-%m-%dT%H:%M:%f', ends) IS ends) OR strftime('%Y-%m-%dT%H:%M:%fZ', ends) IS ends) END)
) STRICT;

-- table origin on origin
CREATE TABLE origin (
  id         TEXT PRIMARY KEY,
  -- Where a row came from: the five stores the engine follows, and the eight one-shot arrivals
  -- (camera_roll, picker, vcard, markdown, csv, scan, upload, phone_reminders) that name a file or a
  -- device once (crates/vault/src/commands/arrival.rs). A typed row has neither.
  system     TEXT NOT NULL CHECK (system IN ('contacts','calendar','files','health','statement',
    'camera_roll','picker','vcard','markdown','csv','scan','upload','phone_reminders')),
  ref        TEXT NOT NULL CHECK (length(trim(ref)) > 0),
  label      TEXT NOT NULL CHECK (length(trim(label)) > 0),
  device_id  TEXT,
  -- The home a follow filled, of the kind its system makes (a calendar's calendar, a folder's folder,
  -- the phone's reminders' project, a statement's account); the contacts and health stores fill none.
  fills      TEXT,
  fills_kind TEXT GENERATED ALWAYS AS (CASE
               WHEN system IN ('calendar') THEN 'calendar'
               WHEN system IN ('files') THEN 'folder'
               WHEN system IN ('phone_reminders') THEN 'project'
               WHEN system IN ('statement') THEN 'account' END) VIRTUAL,
  -- Where the last pass of a followed store stopped (its change token): what the next one resumes
  -- from. Cleared when the follow stops.
  cursor     TEXT,
  config     TEXT CHECK (config IS NULL OR json_valid(config)),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  -- Stop following RETIRES a store's origin instead of deleting it: it keeps its `fills` (the
  -- calendar, folder or project it filled) and its sources, so following the same `ref` again
  -- finds them and neither makes the home twice nor adds each record twice. A retired origin is
  -- followed by nobody: every read of what a phone follows leaves it out.
  retired_at TEXT CHECK (retired_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', retired_at) IS retired_at),
  UNIQUE (system, ref),
  UNIQUE (id, system),
  CHECK (retired_at IS NULL OR system IN ('contacts','calendar','files','health','phone_reminders')),
  -- A statement is an account's, not a phone's store (#1146).
  CHECK (system <> 'statement' OR device_id IS NULL),
  CHECK (fills IS NULL OR fills_kind IS NOT NULL),
  FOREIGN KEY (fills, fills_kind) REFERENCES entity(id, kind)
) STRICT;

-- table person on person
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
  -- A birthday is this row's column, not an event: it is shown on its day and does not notify.
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

-- table photo on photo
CREATE TABLE photo (
  id          TEXT PRIMARY KEY,
  kind        TEXT GENERATED ALWAYS AS ('photo') VIRTUAL,
  blob        TEXT NOT NULL UNIQUE REFERENCES blob(hash),
  media_type  TEXT NOT NULL,
  form        TEXT NOT NULL CHECK (form IN ('photo','video','scan')),
  taken_at    TEXT CHECK (taken_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', taken_at) IS taken_at),
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

-- table reminder on reminder
CREATE TABLE reminder (
  entity_id  TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  offset_min INTEGER NOT NULL CHECK (offset_min >= 0),
  PRIMARY KEY (entity_id, offset_min)
) STRICT;

-- table revision on revision
CREATE TABLE revision (
  entity_id  TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL CHECK (seq >= 1),
  at         TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', at) IS at),
  cause      TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state)),
  body       TEXT,
  blob       TEXT REFERENCES blob(hash),
  media_type TEXT,
  -- Whether a quiet save (an editor's autosave) made this version, and when its session last
  -- folded another in (NULL: never; the session is only its first commit, at `at`). A quiet save
  -- of the same command by the same actor within ten idle minutes, and within an hour of `at`,
  -- writes no version: this one already holds the state before the session began.
  autosave   INTEGER NOT NULL DEFAULT 0 CHECK (autosave IN (0, 1)),
  touched_at TEXT CHECK (touched_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', touched_at) IS touched_at),
  CHECK (body IS NULL OR blob IS NULL),
  CHECK ((blob IS NULL) = (media_type IS NULL)),
  PRIMARY KEY (entity_id, seq)
) STRICT;

-- table rule on rule
CREATE TABLE rule (
  id            TEXT PRIMARY KEY,
  pattern       TEXT NOT NULL CHECK (json_valid(pattern)),
  -- The name the line shows once the rule has run: the payee, not the bank's words (which stay in
  -- `source.stated`). NULL leaves the line's name alone.
  display_name  TEXT CHECK (display_name IS NULL OR length(trim(display_name)) > 0),
  category_id   TEXT NOT NULL,
  category_kind TEXT GENERATED ALWAYS AS ('category') VIRTUAL,
  position      REAL NOT NULL,
  created_at    TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  FOREIGN KEY (category_id, category_kind) REFERENCES entity(id, kind) ON DELETE CASCADE
) STRICT;

-- table search on search
CREATE VIRTUAL TABLE search USING fts5(
  title, body, content = '', contentless_delete = 1, prefix = '2 3',
  tokenize = "unicode61 remove_diacritics 2");

-- table search_config on search_config
CREATE TABLE 'search_config'(k PRIMARY KEY, v) WITHOUT ROWID;

-- table search_data on search_data
CREATE TABLE 'search_data'(id INTEGER PRIMARY KEY, block BLOB);

-- table search_docsize on search_docsize
CREATE TABLE 'search_docsize'(id INTEGER PRIMARY KEY, sz BLOB, origin INTEGER);

-- table search_idx on search_idx
CREATE TABLE 'search_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

-- table search_owed on search_owed
CREATE TABLE search_owed (
  id    TEXT PRIMARY KEY,
  after TEXT NOT NULL
) STRICT;

-- table search_past on search_past
CREATE VIRTUAL TABLE search_past USING fts5(
  title, body, content = '', contentless_delete = 1, prefix = '2 3',
  tokenize = "unicode61 remove_diacritics 2");

-- table search_past_config on search_past_config
CREATE TABLE 'search_past_config'(k PRIMARY KEY, v) WITHOUT ROWID;

-- table search_past_data on search_past_data
CREATE TABLE 'search_past_data'(id INTEGER PRIMARY KEY, block BLOB);

-- table search_past_docsize on search_past_docsize
CREATE TABLE 'search_past_docsize'(id INTEGER PRIMARY KEY, sz BLOB, origin INTEGER);

-- table search_past_idx on search_past_idx
CREATE TABLE 'search_past_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

-- table search_past_vocab on search_past_vocab
CREATE VIRTUAL TABLE search_past_vocab USING fts5vocab(search_past, row);

-- table search_vocab on search_vocab
CREATE VIRTUAL TABLE search_vocab USING fts5vocab(search, row);

-- table search_word on search_word
CREATE TABLE search_word (
  n    INTEGER PRIMARY KEY,
  word TEXT NOT NULL UNIQUE
) STRICT;

-- table source on source
CREATE TABLE source (
  id          TEXT PRIMARY KEY,
  origin_id   TEXT NOT NULL,
  system      TEXT NOT NULL,
  external_id TEXT NOT NULL CHECK (length(trim(external_id)) > 0),
  device_id   TEXT,
  entity_id   TEXT,
  entity_kind TEXT,
  stated      TEXT NOT NULL CHECK (json_valid(stated)),
  -- What the system calls the record, lifted out of `stated` for the reads that list it.
  stated_title TEXT,
  seen_at     TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', seen_at) IS seen_at),
  -- When the follower trashed the row because its record left a complete read: the trash it may
  -- undo if the record returns and the member has not touched the row since (#1146).
  gone_at     TEXT CHECK (gone_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', gone_at) IS gone_at),
  FOREIGN KEY (origin_id, system) REFERENCES origin(id, system),
  FOREIGN KEY (entity_id, entity_kind) REFERENCES entity(id, kind) ON DELETE SET NULL,
  CHECK ((entity_id IS NULL) = (entity_kind IS NULL)),
  CHECK (system <> 'statement' OR device_id IS NULL),
  CHECK (entity_kind IS NULL OR system || '/' || entity_kind IN
    ('contacts/person','calendar/event','files/document','health/activity','statement/txn',
     'camera_roll/photo','picker/photo','vcard/person','markdown/note','csv/locker_item',
     'scan/document','upload/document','phone_reminders/task'))
) STRICT;

-- table sqlite_sequence on sqlite_sequence
CREATE TABLE sqlite_sequence(name,seq);

-- table task on task
CREATE TABLE task (
  id                TEXT PRIMARY KEY,
  kind              TEXT GENERATED ALWAYS AS ('task') VIRTUAL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  priority          INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 9),
  due               TEXT CHECK (due IS NULL OR date(due) IS due OR (strftime('%Y-%m-%dT%H:%M', due) IS due OR strftime('%Y-%m-%dT%H:%M:%S', due) IS due OR strftime('%Y-%m-%dT%H:%M:%f', due) IS due) OR strftime('%Y-%m-%dT%H:%M:%fZ', due) IS due),
  done_at           TEXT CHECK ((status = 'done') = (done_at IS NOT NULL) AND (done_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', done_at) IS done_at)),
  rule              TEXT,
  anchor            TEXT NOT NULL DEFAULT 'scheduled' CHECK (anchor IN ('scheduled','completion')),
  zone              TEXT,
  series_id         TEXT REFERENCES task(id) CHECK (series_id IS NULL OR series_id <> id),
  remind_before_min INTEGER CHECK (remind_before_min IS NULL OR remind_before_min >= 0),
  -- A SNOOZE MOVES THE ALERT, NOT THE DUE (#1188, NA5): the UTC instant the member asked to be
  -- reminded again. While it is set it is the task's one alert (`alerts::refresh`); an edit of the
  -- due, the lead or the rule clears it, and so does finishing the task.
  snoozed_until     TEXT CHECK (snoozed_until IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', snoozed_until) IS snoozed_until),
  url               TEXT CHECK (url IS NULL OR length(trim(url)) > 0),
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

-- table thread on thread
CREATE TABLE thread (
  id    TEXT PRIMARY KEY,
  kind  TEXT GENERATED ALWAYS AS ('thread') VIRTUAL,
  scope TEXT,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE
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
  account_id    TEXT NOT NULL,
  currency      TEXT NOT NULL,
  posted_on     TEXT NOT NULL CHECK (date(posted_on) = posted_on),
  amount_minor  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('pending','posted','void')),
  category_id   TEXT,
  category_kind TEXT GENERATED ALWAYS AS ('category') VIRTUAL,
  FOREIGN KEY (id, kind) REFERENCES entity(id, kind) ON DELETE CASCADE,
  FOREIGN KEY (account_id, currency) REFERENCES account(id, currency),
  FOREIGN KEY (category_id, category_kind) REFERENCES entity(id, kind)
) STRICT;

-- table vault on vault
CREATE TABLE vault (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  self_id    TEXT NOT NULL,
  self_kind  TEXT GENERATED ALWAYS AS ('person') VIRTUAL,
  currency   TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  zone       TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  -- How many commits changed something a screen reads, and when the last did, on the vault's
  -- clock: a takeover compares the counter to tell which copy is ahead (#1146). Bumped by the
  -- commit guard, once per such commit; nothing else writes them.
  writes     INTEGER NOT NULL DEFAULT 0 CHECK (writes >= 0),
  written_at TEXT CHECK (written_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', written_at) IS written_at),
  FOREIGN KEY (self_id, self_kind) REFERENCES entity(id, kind) DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- table workout on workout
CREATE TABLE workout (
  id          TEXT PRIMARY KEY,
  -- A workout is the measures of an activity of a workout kind, and of no other.
  type_kind   TEXT GENERATED ALWAYS AS ('workout_kind') VIRTUAL,
  recorded_by TEXT,
  moving_s    INTEGER CHECK (moving_s IS NULL OR moving_s > 0),
  distance_m  REAL CHECK (distance_m IS NULL OR distance_m >= 0),
  energy_kcal REAL CHECK (energy_kcal IS NULL OR energy_kcal >= 0),
  heart_bpm   INTEGER CHECK (heart_bpm IS NULL OR heart_bpm > 0),
  climb_m     REAL CHECK (climb_m IS NULL OR climb_m >= 0),
  FOREIGN KEY (id, type_kind) REFERENCES activity(id, type_kind) ON DELETE CASCADE
) STRICT;

-- trigger concept_hierarchy_is_acyclic on concept
CREATE TRIGGER concept_hierarchy_is_acyclic BEFORE UPDATE OF parent_id ON concept
  WHEN new.parent_id IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'that parent is already below this concept: a hierarchy has no loops')
     WHERE EXISTS (
       WITH RECURSIVE ancestors(id) AS (
         SELECT new.parent_id
         UNION
         SELECT c.parent_id FROM concept c JOIN ancestors a ON c.id = a.id WHERE c.parent_id IS NOT NULL)
       SELECT 1 FROM ancestors WHERE id = new.id);
  END;

-- trigger concept_kind_follows_its_parent on concept
CREATE TRIGGER concept_kind_follows_its_parent BEFORE UPDATE OF kind ON concept
  WHEN (new.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM concept p WHERE p.id = new.parent_id AND p.kind = new.kind))
    OR EXISTS (SELECT 1 FROM concept c WHERE c.parent_id = new.id AND c.kind <> new.kind)
  BEGIN SELECT RAISE(ABORT, 'a concept''s parent is of its own kind'); END;

-- trigger concept_parent_shares_its_kind on concept
CREATE TRIGGER concept_parent_shares_its_kind BEFORE INSERT ON concept
  WHEN new.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM concept p WHERE p.id = new.parent_id AND p.kind = new.kind)
  BEGIN SELECT RAISE(ABORT, 'a concept''s parent is of its own kind'); END;

-- trigger concept_parent_shares_its_kind_on_move on concept
CREATE TRIGGER concept_parent_shares_its_kind_on_move BEFORE UPDATE OF parent_id ON concept
  WHEN new.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM concept p WHERE p.id = new.parent_id AND p.kind = new.kind)
  BEGIN SELECT RAISE(ABORT, 'a concept''s parent is of its own kind'); END;

-- trigger container_hierarchy_is_acyclic on container
CREATE TRIGGER container_hierarchy_is_acyclic BEFORE UPDATE OF parent_id ON container
  WHEN new.parent_id IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'that parent is already inside this container: containers do not nest in a loop')
     WHERE EXISTS (
       WITH RECURSIVE ancestors(id) AS (
         SELECT new.parent_id
         UNION
         SELECT c.parent_id FROM container c JOIN ancestors a ON c.id = a.id WHERE c.parent_id IS NOT NULL)
       SELECT 1 FROM ancestors WHERE id = new.id);
  END;

-- trigger container_parent_shape on container
CREATE TRIGGER container_parent_shape BEFORE INSERT ON container
  WHEN new.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM container p WHERE p.id = new.parent_id AND
      ((new.kind IN ('folder','notebook') AND p.kind = new.kind)
    OR (new.kind = 'section' AND p.kind = 'project')
    OR (new.kind = 'project' AND p.kind = 'area')))
  BEGIN SELECT RAISE(ABORT, 'a container nests only in its own kind, a section in a project, a project in an area'); END;

-- trigger container_parent_shape_on_move on container
CREATE TRIGGER container_parent_shape_on_move BEFORE UPDATE OF parent_id ON container
  WHEN new.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM container p WHERE p.id = new.parent_id AND
      ((new.kind IN ('folder','notebook') AND p.kind = new.kind)
    OR (new.kind = 'section' AND p.kind = 'project')
    OR (new.kind = 'project' AND p.kind = 'area')))
  BEGIN SELECT RAISE(ABORT, 'a container nests only in its own kind, a section in a project, a project in an area'); END;

-- trigger container_section_takes_its_tasks on container
CREATE TRIGGER container_section_takes_its_tasks AFTER UPDATE OF parent_id ON container
  WHEN new.kind = 'section' AND new.parent_id IS NOT old.parent_id
  BEGIN UPDATE task SET project_id = new.parent_id WHERE section_id = new.id AND project_id IS NOT new.parent_id; END;

-- trigger edge_ends_are_fixed on edge
CREATE TRIGGER edge_ends_are_fixed BEFORE UPDATE OF from_id, rel, to_id, label_id ON edge
  BEGIN SELECT RAISE(ABORT, 'an edge''s ends never change; remove it and add another'); END;

-- trigger edge_has_a_shape on edge
CREATE TRIGGER edge_has_a_shape BEFORE INSERT ON edge
  WHEN NOT EXISTS (
    SELECT 1 FROM edge_shape s, entity f, entity t
     WHERE f.id = new.from_id AND t.id = new.to_id AND s.rel = new.rel
       AND s.from_kind IN (f.kind, '*') AND s.to_kind IN (t.kind, '*'))
    OR (new.label_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM entity WHERE id = new.label_id AND kind = 'relation'))
  BEGIN SELECT RAISE(ABORT, 'no edge of this relation joins these kinds'); END;

-- trigger entity_kind_is_fixed on entity
CREATE TRIGGER entity_kind_is_fixed BEFORE UPDATE OF id, kind ON entity
  BEGIN SELECT RAISE(ABORT, 'an entity''s id and kind never change'); END;

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

-- trigger revision_is_history on revision
CREATE TRIGGER revision_is_history
  BEFORE UPDATE OF entity_id, seq, at, cause, state, body, blob, media_type, autosave ON revision
  BEGIN SELECT RAISE(ABORT, 'a revision is history'); END;

-- trigger revision_is_kept on revision
CREATE TRIGGER revision_is_kept BEFORE DELETE ON revision
  WHEN EXISTS (SELECT 1 FROM entity WHERE id = old.entity_id)
  BEGIN SELECT RAISE(ABORT, 'a revision is kept while its entity is'); END;

-- trigger source_tombstone_is_final on source
CREATE TRIGGER source_tombstone_is_final BEFORE UPDATE OF entity_id ON source
  WHEN old.entity_id IS NULL AND new.entity_id IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'a purged row''s source never takes a row again'); END;

-- trigger task_hierarchy_is_acyclic on task
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

-- trigger task_section_is_in_its_project_on_insert on task
CREATE TRIGGER task_section_is_in_its_project_on_insert BEFORE INSERT ON task
  WHEN new.section_id IS NOT NULL
   AND (SELECT parent_id FROM container WHERE id = new.section_id) IS NOT new.project_id
  BEGIN SELECT RAISE(ABORT, 'that section belongs to a different project'); END;

-- trigger task_section_is_in_its_project_on_update on task
CREATE TRIGGER task_section_is_in_its_project_on_update BEFORE UPDATE OF section_id, project_id ON task
  WHEN new.section_id IS NOT NULL
   AND (SELECT parent_id FROM container WHERE id = new.section_id) IS NOT new.project_id
  BEGIN SELECT RAISE(ABORT, 'that section belongs to a different project'); END;

-- trigger transfer_halves_are_in_one_pair on transfer
CREATE TRIGGER transfer_halves_are_in_one_pair BEFORE INSERT ON transfer
  WHEN EXISTS (SELECT 1 FROM transfer WHERE b = new.a OR a = new.b)
  BEGIN SELECT RAISE(ABORT, 'a line is in at most one transfer'); END;

-- trigger transfer_halves_are_in_one_pair_on_update on transfer
CREATE TRIGGER transfer_halves_are_in_one_pair_on_update BEFORE UPDATE OF a, b ON transfer
  WHEN EXISTS (SELECT 1 FROM transfer WHERE rowid <> old.rowid AND (b = new.a OR a = new.b))
  BEGIN SELECT RAISE(ABORT, 'a line is in at most one transfer'); END;

-- trigger txn_line_is_fixed on txn
CREATE TRIGGER txn_line_is_fixed BEFORE UPDATE OF account_id, currency, posted_on, amount_minor ON txn
  BEGIN SELECT RAISE(ABORT, 'a statement line is never edited'); END;

-- trigger txn_void_is_final on txn
CREATE TRIGGER txn_void_is_final BEFORE UPDATE OF status ON txn WHEN old.status = 'void'
  BEGIN SELECT RAISE(ABORT, 'a voided line stays void'); END;
