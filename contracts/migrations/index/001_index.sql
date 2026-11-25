-- ==== <stem>.index.db (its own ladder, application_id 0x43454958 'CEIX') ====
-- A15: DERIVED DATA, in an attached `<stem>.index.db` founded from its own ladder (registered in
-- `crates/xtask/src/ddl_rules.rs` with its own `application_id` and `user_version`). Nothing a member
-- made: a rebuild rewrites every table here from `vault.db`, a restore rebuilds it, and it is never
-- in a snapshot, in staging or in the dirty-range record. `search_owed` (above, in `vault.db`) is
-- the queue of what this file owes. There are no foreign keys across the two files: rows here name
-- vault rows by `entity.n` (never reused, A18) or by a reminder's id. `derivative` stays in
-- `vault.db` (re-running OCR over every document after a restore is hours of work).
-- Everything below is loaded into a SEPARATE database from the vault part above.

-- The FTS rowid is `entity.n`. `prefix = '2 3'` keeps an index of every two- and three-letter start
-- of a word, so the first keystrokes of a query read one short list instead of every term that begins
-- that way. `search_vocab` lists the words only, never these entries.
CREATE VIRTUAL TABLE search USING fts5(
  title, body, content = '', contentless_delete = 1, prefix = '2 3',
  tokenize = "unicode61 remove_diacritics 2");
CREATE VIRTUAL TABLE search_vocab USING fts5vocab(search, row);

-- What a live item said in an EARLIER VERSION (#1185), keyed `entity.n << 24 | revision.seq`. K3:
-- a Locker item's earlier versions are searched like any app's, by their PLAIN text only; ciphertext
-- is never tokenised here or into `search_word`. A trashed entity has no row here.
CREATE VIRTUAL TABLE search_past USING fts5(
  title, body, content = '', contentless_delete = 1, prefix = '2 3',
  tokenize = "unicode61 remove_diacritics 2");
CREATE VIRTUAL TABLE search_past_vocab USING fts5vocab(search_past, row);

-- The words the index holds, in the order they first arrived: a list a correction reads whole.
CREATE TABLE search_word (
  n    INTEGER PRIMARY KEY,
  word TEXT NOT NULL UNIQUE
) STRICT;

-- ALERTS (#1188, A5): the index of "what fires next". One row per reminder (D2): the writer keeps
-- `fire_key`, the moment of its next firing, at every commit that touches the item, so the
-- notification service reads "the next 48" off `alert_by_fire` whatever the vault's size. `timing`
-- says how `fire_key` reads: 'fixed' is a UTC instant, 'floating' a wall clock. A repeating item holds
-- its NEXT firing and the launch and idle passes move it on. A snoozed task's one alert is its snooze.
CREATE TABLE alert (
  reminder_id TEXT NOT NULL PRIMARY KEY,
  timing      TEXT NOT NULL CHECK (timing IN ('fixed','floating')),
  fire_key    TEXT NOT NULL CHECK (CASE timing WHEN 'fixed' THEN strftime('%Y-%m-%dT%H:%M:%fZ', fire_key) IS fire_key ELSE strftime('%Y-%m-%dT%H:%M', fire_key) IS fire_key END),
  repeats     INTEGER NOT NULL DEFAULT 0 CHECK (repeats IN (0,1))
) STRICT, WITHOUT ROWID;
-- Reader: the notification service's "next firings".
CREATE INDEX alert_by_fire ON alert(timing, fire_key, reminder_id);

-- A16, H3: the spatial index over PHOTOS and PLACES: one point each, `n` is the entity's `n`. The map
-- reads a viewport as one R-tree query and joins `entity` for the kind.
CREATE VIRTUAL TABLE geo USING rtree(n, min_lon, max_lon, min_lat, max_lat);

-- What this file is a copy of, as one row of typed columns (a singleton, not a table of names and values).
--   self_id    the vault's owner person: a file that belongs to another vault is rebuilt, not trusted.
--   tokenizer  the version of `text::index_words`: a tokenizer change rebuilds the file.
--   built_at   when the last full rebuild finished, on the vault's clock.
CREATE TABLE index_state (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  self_id   TEXT NOT NULL CHECK (length(trim(self_id)) > 0),
  tokenizer INTEGER NOT NULL CHECK (tokenizer >= 1),
  built_at  TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', built_at) IS built_at)
) STRICT;
