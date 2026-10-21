-- THE CHAT SCOPE FOLDS INTO AGENDA (#1128, R-1128-F2, R-1128-F3; the owner's ruling of
-- 2026-10-21 on Q-1128-3).
--
-- **ON THE LADDER**, appended to `LADDER` in `crates/vault/src/migrations.rs`. The file is both
-- the migration and its fixture (D-1020-D1-13), and NEVER EDITED once released: a file in the
-- field has already run this text, so a correction is the rung after it.
--
-- ## What this is for
--
-- The Tasks app folded into Agenda (#1128): a member opens dated work in Agenda's days and the
-- rest in its To-do, and never opens "Tasks". A chat opened from Agenda is scoped to `agenda`
-- and covers task rows as well as events, so the thread scope that named the task domain on its
-- own is retired: `chat_thread.scope_app` no longer admits it, and a thread saved under it is
-- scoped to Agenda instead, keeping everything it holds.
--
-- A CARD KEEPS ITS DOMAIN. `chat_message_card.app` still admits the task domain: a card names
-- the vault domain of the row it points at (`chat_card_row_exists`), and the shell routes it to
-- the app it opens in. Only the THREAD's scope moves.
--
-- ## Why four tables are rebuilt to change one CHECK
--
-- SQLite cannot alter a CHECK, so `chat_thread` is rebuilt. `Vault::open` runs the ladder with
-- `foreign_keys = ON` and each rung inside its own transaction, where the pragma cannot change;
-- with enforcement on, `DROP TABLE` is an implicit `DELETE FROM` that runs the children's
-- `ON DELETE CASCADE`, so dropping `chat_thread` under its messages would delete every message,
-- card and attachment the member has. The rebuild therefore carries all four chat tables, drops
-- the children before their parents (a table with no children left cascades into nothing), and
-- founds them again — the way the retired rungs twelve and fifteen did (R-1099-22).
--
-- EVERY ROW COMES BACK UNDER THE ROWID IT HAD: `fts_chat_thread` is keyed by the thread's
-- rowid, so a thread that came back under another one would answer a search with another
-- thread. NO ROW IS TOUCHED IN PLACE: the scope is moved in the carry, so no update trigger
-- fires, and a moved thread keeps its `updated_at` and `row_version` — the history list, newest
-- activity first, keeps its order. The implicit deletes of `DROP TABLE` fire no trigger, so
-- neither the search index nor `core_entity` loses a row, and the rows are written back BEFORE
-- the guards and search triggers are founded again, so none of them fires over a carried row.
--
-- Every table, index and trigger is founded in the text rung one gives it, but for the one
-- CHECK. Nothing here depends on the rung's number, so it can be renumbered before release by
-- renaming the file and its `LADDER` entry alone.

-- ---------------------------------------------------------------------------
-- 1. Carry the four tables, with their rowids, and move the scope in the carry.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE chat_thread_carry AS
SELECT rowid AS carried_rowid, thread_id, title, scope_app, created_at, updated_at, row_version
  FROM chat_thread;

UPDATE temp.chat_thread_carry SET scope_app = 'agenda' WHERE scope_app = 'tasks';

CREATE TEMP TABLE chat_message_carry AS
SELECT rowid AS carried_rowid, thread_id, ordinal, role, text, outcome, refusal, notice,
       record_json, created_at
  FROM chat_message;

CREATE TEMP TABLE chat_message_card_carry AS
SELECT rowid AS carried_rowid, thread_id, message_ordinal, position, app, entity, row_id,
       qualifier, title, subtitle, meta
  FROM chat_message_card;

CREATE TEMP TABLE chat_message_attachment_carry AS
SELECT rowid AS carried_rowid, thread_id, message_ordinal, position, kind, label,
       asset_id, document_id, thumb_content_id
  FROM chat_message_attachment;

-- ---------------------------------------------------------------------------
-- 2. Children before parents, so no drop cascades into a row.
-- ---------------------------------------------------------------------------

DROP TABLE chat_message_attachment;
DROP TABLE chat_message_card;
DROP TABLE chat_message;
DROP TABLE chat_thread;

-- ---------------------------------------------------------------------------
-- 3. The four tables again: rung one's text, and the thread scope without the task domain.
-- ---------------------------------------------------------------------------

-- table chat_thread
CREATE TABLE chat_thread (
  thread_id   TEXT PRIMARY KEY,
  title       TEXT NOT NULL CHECK (length(trim(title)) > 0),
  scope_app   TEXT CHECK (scope_app IS NULL
                          OR scope_app IN ('agenda','docs','money','notes','people','photos')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (thread_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- table chat_message
CREATE TABLE chat_message (
  thread_id   TEXT NOT NULL REFERENCES chat_thread(thread_id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL CHECK (ordinal >= 0),
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text        TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN (
                'sent','answered','stopped','refused',
                'proposed','applied','dismissed','stale','failed')),
  refusal     TEXT CHECK (refusal IS NULL OR refusal IN (
                'no_tool_fits','query_failed','unparsable','model_absent','model_failed',
                'vision_absent','attachment_unsupported','attachment_unreadable',
                'attachment_too_large')),
  notice      TEXT CHECK (notice IS NULL OR notice IN ('doc_truncated')),
  record_json TEXT CHECK (record_json IS NULL OR json_valid(record_json)),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (thread_id, ordinal),
  CHECK ((role = 'user') = (outcome = 'sent')),
  CHECK ((outcome = 'refused') = (refusal IS NOT NULL)),
  CHECK (role = 'assistant' OR (notice IS NULL AND record_json IS NULL))
) STRICT;

-- table chat_message_card
CREATE TABLE chat_message_card (
  thread_id       TEXT NOT NULL,
  message_ordinal INTEGER NOT NULL,
  position        INTEGER NOT NULL CHECK (position >= 0),
  app             TEXT NOT NULL
                  CHECK (app IN ('agenda','docs','money','notes','people','photos','tasks')),
  entity          TEXT NOT NULL CHECK (length(entity) > 0),
  row_id          TEXT NOT NULL CHECK (length(row_id) > 0),
  qualifier       TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL,
  subtitle        TEXT NOT NULL DEFAULT '',
  meta            TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (thread_id, message_ordinal, position),
  FOREIGN KEY (thread_id, message_ordinal)
    REFERENCES chat_message(thread_id, ordinal) ON DELETE CASCADE
) STRICT;

-- table chat_message_attachment
CREATE TABLE chat_message_attachment (
  thread_id        TEXT NOT NULL,
  message_ordinal  INTEGER NOT NULL,
  position         INTEGER NOT NULL CHECK (position >= 0),
  kind             TEXT NOT NULL CHECK (kind IN ('photo','document','image')),
  label            TEXT NOT NULL,
  asset_id         TEXT REFERENCES media_asset(asset_id) ON DELETE SET NULL,
  document_id      TEXT REFERENCES core_document(document_id) ON DELETE SET NULL,
  thumb_content_id TEXT REFERENCES core_content_item(content_id) ON DELETE SET NULL,
  PRIMARY KEY (thread_id, message_ordinal, position),
  FOREIGN KEY (thread_id, message_ordinal)
    REFERENCES chat_message(thread_id, ordinal) ON DELETE CASCADE,
  CHECK ((kind = 'photo' OR asset_id IS NULL)
     AND (kind = 'document' OR document_id IS NULL)
     AND (kind = 'image' OR thumb_content_id IS NULL))
) STRICT;

-- ---------------------------------------------------------------------------
-- 4. The rows, each under its own rowid, parents before children.
-- ---------------------------------------------------------------------------

INSERT INTO chat_thread
  (rowid, thread_id, title, scope_app, created_at, updated_at, row_version)
SELECT carried_rowid, thread_id, title, scope_app, created_at, updated_at, row_version
  FROM temp.chat_thread_carry
 ORDER BY carried_rowid;

INSERT INTO chat_message
  (rowid, thread_id, ordinal, role, text, outcome, refusal, notice, record_json, created_at)
SELECT carried_rowid, thread_id, ordinal, role, text, outcome, refusal, notice, record_json,
       created_at
  FROM temp.chat_message_carry
 ORDER BY carried_rowid;

INSERT INTO chat_message_card
  (rowid, thread_id, message_ordinal, position, app, entity, row_id, qualifier, title,
   subtitle, meta)
SELECT carried_rowid, thread_id, message_ordinal, position, app, entity, row_id, qualifier,
       title, subtitle, meta
  FROM temp.chat_message_card_carry
 ORDER BY carried_rowid;

INSERT INTO chat_message_attachment
  (rowid, thread_id, message_ordinal, position, kind, label, asset_id, document_id,
   thumb_content_id)
SELECT carried_rowid, thread_id, message_ordinal, position, kind, label, asset_id, document_id,
       thumb_content_id
  FROM temp.chat_message_attachment_carry
 ORDER BY carried_rowid;

DROP TABLE temp.chat_message_attachment_carry;
DROP TABLE temp.chat_message_card_carry;
DROP TABLE temp.chat_message_carry;
DROP TABLE temp.chat_thread_carry;

-- ---------------------------------------------------------------------------
-- 5. The indexes, guards and search triggers that went with the four tables, in rung one's
--    text, founded after the rows so none of them fires over a carried one.
-- ---------------------------------------------------------------------------

-- index chat_thread_recent_idx
CREATE INDEX chat_thread_recent_idx ON chat_thread(updated_at DESC, thread_id DESC);

-- index idx_chat_attachment_asset
CREATE INDEX idx_chat_attachment_asset
  ON chat_message_attachment(asset_id) WHERE asset_id IS NOT NULL;

-- index idx_chat_attachment_document
CREATE INDEX idx_chat_attachment_document
  ON chat_message_attachment(document_id) WHERE document_id IS NOT NULL;

-- index idx_chat_attachment_thumb
CREATE INDEX idx_chat_attachment_thumb
  ON chat_message_attachment(thumb_content_id) WHERE thumb_content_id IS NOT NULL;

-- trigger chat_message_is_not_born_settled
CREATE TRIGGER chat_message_is_not_born_settled
BEFORE INSERT ON chat_message
WHEN NEW.outcome IN ('applied','dismissed','stale','failed')
BEGIN
  SELECT RAISE(ABORT, 'a message is proposed before it is settled: it is not born applied, dismissed, stale or failed');
END;

-- trigger chat_message_outcome_settles_once
CREATE TRIGGER chat_message_outcome_settles_once
BEFORE UPDATE OF outcome ON chat_message
WHEN NEW.outcome IS NOT OLD.outcome
BEGIN
  SELECT RAISE(ABORT, 'a told answer does not change: only a proposal settles, and once')
   WHERE OLD.outcome <> 'proposed';
  SELECT RAISE(ABORT, 'a proposal settles as applied, dismissed, stale or failed')
   WHERE NEW.outcome NOT IN ('applied','dismissed','stale','failed');
END;

-- trigger chat_thread_entity_delete
CREATE TRIGGER chat_thread_entity_delete
AFTER DELETE ON chat_thread
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.thread_id;
END;

-- trigger chat_thread_entity_insert
CREATE TRIGGER chat_thread_entity_insert
BEFORE INSERT ON chat_thread
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: chat_thread (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.thread_id AND entity_type <> 'chat.thread');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.thread_id, 'chat.thread', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger chat_thread_touch_updated_at
CREATE TRIGGER chat_thread_touch_updated_at
AFTER UPDATE ON chat_thread
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE chat_thread
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE thread_id = NEW.thread_id;
END;

-- trigger fts_chat_thread_ad
CREATE TRIGGER fts_chat_thread_ad
  AFTER DELETE ON chat_thread
BEGIN
  DELETE FROM fts_chat_thread WHERE rowid = old.rowid;
END;

-- trigger fts_chat_thread_ai
CREATE TRIGGER fts_chat_thread_ai
  AFTER INSERT ON chat_thread
BEGIN
  INSERT INTO fts_chat_thread(rowid, thread_id, title, said)
    SELECT p.rowid, p.thread_id, p.title,
           CASE WHEN s.said IS NULL THEN NULL
                WHEN length(s.said) > 262144
                THEN substr(s.said, 1, 262144) || ' ...(truncated for search index)'
                ELSE s.said END
      FROM chat_thread p,
           (SELECT group_concat(u.text, ' ') AS said
              FROM (SELECT m.text FROM chat_message m
                     WHERE m.thread_id = new.thread_id AND m.role = 'user'
                     ORDER BY m.ordinal) u) s
     WHERE p.thread_id = new.thread_id;
END;

-- trigger fts_chat_thread_au
CREATE TRIGGER fts_chat_thread_au
  AFTER UPDATE OF thread_id, title ON chat_thread
BEGIN
  DELETE FROM fts_chat_thread WHERE rowid = old.rowid;
  INSERT INTO fts_chat_thread(rowid, thread_id, title, said)
    SELECT p.rowid, p.thread_id, p.title,
           CASE WHEN s.said IS NULL THEN NULL
                WHEN length(s.said) > 262144
                THEN substr(s.said, 1, 262144) || ' ...(truncated for search index)'
                ELSE s.said END
      FROM chat_thread p,
           (SELECT group_concat(u.text, ' ') AS said
              FROM (SELECT m.text FROM chat_message m
                     WHERE m.thread_id = new.thread_id AND m.role = 'user'
                     ORDER BY m.ordinal) u) s
     WHERE p.thread_id = new.thread_id;
END;

-- trigger fts_chat_thread_from_chat_message_ad
CREATE TRIGGER fts_chat_thread_from_chat_message_ad
  AFTER DELETE ON chat_message
  WHEN old.role = 'user'
   AND EXISTS (SELECT 1 FROM chat_thread t WHERE t.thread_id = old.thread_id)
BEGIN
  DELETE FROM fts_chat_thread WHERE rowid IN (
    SELECT t.rowid FROM chat_thread t WHERE t.thread_id = old.thread_id);
  INSERT INTO fts_chat_thread(rowid, thread_id, title, said)
    SELECT p.rowid, p.thread_id, p.title,
           CASE WHEN s.said IS NULL THEN NULL
                WHEN length(s.said) > 262144
                THEN substr(s.said, 1, 262144) || ' ...(truncated for search index)'
                ELSE s.said END
      FROM chat_thread p,
           (SELECT group_concat(u.text, ' ') AS said
              FROM (SELECT m.text FROM chat_message m
                     WHERE m.thread_id = old.thread_id AND m.role = 'user'
                     ORDER BY m.ordinal) u) s
     WHERE p.thread_id = old.thread_id;
END;

-- trigger fts_chat_thread_from_chat_message_ai
CREATE TRIGGER fts_chat_thread_from_chat_message_ai
  AFTER INSERT ON chat_message
  WHEN new.role = 'user'
   AND EXISTS (SELECT 1 FROM chat_thread t WHERE t.thread_id = new.thread_id)
BEGIN
  DELETE FROM fts_chat_thread WHERE rowid IN (
    SELECT t.rowid FROM chat_thread t WHERE t.thread_id = new.thread_id);
  INSERT INTO fts_chat_thread(rowid, thread_id, title, said)
    SELECT p.rowid, p.thread_id, p.title,
           CASE WHEN s.said IS NULL THEN NULL
                WHEN length(s.said) > 262144
                THEN substr(s.said, 1, 262144) || ' ...(truncated for search index)'
                ELSE s.said END
      FROM chat_thread p,
           (SELECT group_concat(u.text, ' ') AS said
              FROM (SELECT m.text FROM chat_message m
                     WHERE m.thread_id = new.thread_id AND m.role = 'user'
                     ORDER BY m.ordinal) u) s
     WHERE p.thread_id = new.thread_id;
END;

-- trigger fts_chat_thread_from_chat_message_au
CREATE TRIGGER fts_chat_thread_from_chat_message_au
  AFTER UPDATE OF thread_id, ordinal, role, text ON chat_message
  WHEN old.role = 'user' OR new.role = 'user'
BEGIN
  DELETE FROM fts_chat_thread WHERE rowid IN (
    SELECT t.rowid FROM chat_thread t WHERE t.thread_id = new.thread_id);
  INSERT INTO fts_chat_thread(rowid, thread_id, title, said)
    SELECT p.rowid, p.thread_id, p.title,
           CASE WHEN s.said IS NULL THEN NULL
                WHEN length(s.said) > 262144
                THEN substr(s.said, 1, 262144) || ' ...(truncated for search index)'
                ELSE s.said END
      FROM chat_thread p,
           (SELECT group_concat(u.text, ' ') AS said
              FROM (SELECT m.text FROM chat_message m
                     WHERE m.thread_id = new.thread_id AND m.role = 'user'
                     ORDER BY m.ordinal) u) s
     WHERE p.thread_id = new.thread_id;
  DELETE FROM fts_chat_thread WHERE rowid IN (
    SELECT t.rowid FROM chat_thread t
     WHERE t.thread_id = old.thread_id AND old.thread_id IS NOT new.thread_id);
  INSERT INTO fts_chat_thread(rowid, thread_id, title, said)
    SELECT p.rowid, p.thread_id, p.title,
           CASE WHEN s.said IS NULL THEN NULL
                WHEN length(s.said) > 262144
                THEN substr(s.said, 1, 262144) || ' ...(truncated for search index)'
                ELSE s.said END
      FROM chat_thread p,
           (SELECT group_concat(u.text, ' ') AS said
              FROM (SELECT m.text FROM chat_message m
                     WHERE m.thread_id = old.thread_id AND m.role = 'user'
                     ORDER BY m.ordinal) u) s
     WHERE p.thread_id = old.thread_id
       AND old.thread_id IS NOT new.thread_id;
END;
