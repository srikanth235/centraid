-- RUNG FOUR of the vault's ladder: `chat_message` carries the version every mutable table carries
-- (#1129, F-R-1).
--
-- `chat_message` is registered `mutable`, and it is: a proposal settles in place (`chat.settle`
-- moves `outcome` and replaces `text`), and a new turn dismisses the card that was waiting. Rung
-- one founded it with neither `updated_at` nor `row_version`, so an edit to a message bumped
-- nothing a seat could compare. It gains both and the touch trigger every mutable table carries.
--
-- A new rung, not an edit to rung three: rung three is unreleased, but every phone a #1129 lane
-- ran has already climbed it, and an edit would leave those files at version three without the
-- columns, unnoticed.
--
-- HOW IT IS REBUILT, AND WHY NOT BY RENAME. SQLite cannot add a column with a non-constant
-- default, so the table is rebuilt. It cannot be renamed aside as rung three moved
-- `core_activity`: two tables reference it (`chat_message_attachment`, `chat_message_card`), a
-- rename with foreign keys ON rewrites their REFERENCES to the old name, and dropping the old table
-- would then cascade into both. Neither child has a trigger, and nothing names either one, so the
-- family is rebuilt from copies: the message table's own triggers are dropped, the three tables'
-- rows are copied to temporary tables, the children and then the message table are dropped (no
-- trigger fires, and nothing is left to cascade into), the message table is created under its own
-- name so its stored text is the text below, every row comes back with `updated_at = created_at`
-- and `row_version = 1`, the children are created, indexed and refilled byte for byte as rung one
-- wrote them, and the triggers are recreated byte for byte with the new touch trigger beside them.
-- The rows come back before the triggers do, so a settled message is not refused as born settled,
-- and the chat index is left as it was: its rows are keyed by the thread, whose rows never move.

DROP TRIGGER chat_message_is_not_born_settled;
DROP TRIGGER chat_message_outcome_settles_once;
DROP TRIGGER fts_chat_thread_from_chat_message_ad;
DROP TRIGGER fts_chat_thread_from_chat_message_ai;
DROP TRIGGER fts_chat_thread_from_chat_message_au;

CREATE TEMP TABLE chat_message_kept AS SELECT * FROM main.chat_message;
CREATE TEMP TABLE chat_message_attachment_kept AS SELECT * FROM main.chat_message_attachment;
CREATE TEMP TABLE chat_message_card_kept AS SELECT * FROM main.chat_message_card;

DROP TABLE main.chat_message_card;
DROP TABLE main.chat_message_attachment;
DROP TABLE main.chat_message;

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
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (thread_id, ordinal),
  CHECK ((role = 'user') = (outcome = 'sent')),
  CHECK ((outcome = 'refused') = (refusal IS NOT NULL)),
  CHECK (role = 'assistant' OR (notice IS NULL AND record_json IS NULL))
) STRICT;

INSERT INTO chat_message
  (thread_id, ordinal, role, text, outcome, refusal, notice, record_json, created_at,
   updated_at, row_version)
SELECT thread_id, ordinal, role, text, outcome, refusal, notice, record_json, created_at,
       created_at, 1
  FROM temp.chat_message_kept;

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

-- index idx_chat_attachment_asset
CREATE INDEX idx_chat_attachment_asset
  ON chat_message_attachment(asset_id) WHERE asset_id IS NOT NULL;

-- index idx_chat_attachment_document
CREATE INDEX idx_chat_attachment_document
  ON chat_message_attachment(document_id) WHERE document_id IS NOT NULL;

-- index idx_chat_attachment_thumb
CREATE INDEX idx_chat_attachment_thumb
  ON chat_message_attachment(thumb_content_id) WHERE thumb_content_id IS NOT NULL;

INSERT INTO chat_message_attachment
  (thread_id, message_ordinal, position, kind, label, asset_id, document_id, thumb_content_id)
SELECT thread_id, message_ordinal, position, kind, label, asset_id, document_id, thumb_content_id
  FROM temp.chat_message_attachment_kept;

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

INSERT INTO chat_message_card
  (thread_id, message_ordinal, position, app, entity, row_id, qualifier, title, subtitle, meta)
SELECT thread_id, message_ordinal, position, app, entity, row_id, qualifier, title, subtitle, meta
  FROM temp.chat_message_card_kept;

DROP TABLE temp.chat_message_card_kept;
DROP TABLE temp.chat_message_attachment_kept;
DROP TABLE temp.chat_message_kept;

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

-- The touch never names `outcome` or `text`, so neither trigger above nor the chat index's update
-- trigger fires on it.
-- trigger chat_message_touch_updated_at
CREATE TRIGGER chat_message_touch_updated_at
AFTER UPDATE ON chat_message
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE chat_message
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE thread_id = NEW.thread_id AND ordinal = NEW.ordinal;
END;
