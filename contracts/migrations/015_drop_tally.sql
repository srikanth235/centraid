-- TALLY LEAVES THE VAULT — RUNG FIFTEEN (#1099, R-1099-19, R-1099-20, R-1099-22, R-1099-35, R-1099-37).
--
-- **ON THE LADDER.** `LADDER` in `crates/vault/src/migrations.rs` ends here.
-- The file is both the migration and its fixture (D-1020-D1-13).
--
-- **NEVER EDITED FROM HERE ON.** A file in the field has already run this text;
-- an edit changes what a fresh file gets and nothing else, which is two schemas
-- with one number. A correction is rung sixteen.
--
-- ## What this is for
--
-- The owner deleted Tally from v0 (#1099, R-1099-19). The app, its commands, its
-- screens and its assistant vocabulary are gone from the tree; this rung removes
-- what they stored. Twelve `tally_*` tables had no producer and no consumer left
-- (ONT-dormant, R-1099-20), and so did the indexes and triggers that rode on
-- them. The spine they wrote through (`core_party`, `core_account`,
-- `core_transaction`, `core_link`) is shared and stays: Money (rung fourteen) is
-- its next reader.
--
-- ## What goes, in the order it goes
--
-- 1. **The rows Tally wrote** (a sweep, before any object leaves, because a
--    foreign key from the spine into a table that is gone could not be deleted
--    through):
--    - every `core_entity` of a `tally.*` kind. Deleting the entity cascades to
--      its `tally_*` row and to everything keyed on the entity's
--      `(entity_type, entity_id)`: links, attachments, notes (`knowledge_annotation`
--      rows with `target_type = 'tally.expense'`), revisions, and the
--      `schedule_recurrence_exception` rows that named a `tally.recurring_expense`
--      (R-1099-37; the baseline's CHECK keeps the vestigial value, because the
--      baseline is never edited, and `vault-ddl.sql` says so in the drift register);
--    - the circles Tally groups stood on, with their members (a group was a
--      `social_circle`; People has no circles screen, so nothing else reads one);
--    - the "Tally settlements" `core_account` and the `core_transaction`s
--      `tally.settle_up` wrote into it (`external_id` `tally:settlement:<id>`, in
--      that account: the same words on a row in any other account are not Tally's
--      to delete).
--      They are Tally-written rows that exist only to mirror a Tally settlement,
--      and the settlement they mirror is gone with the rest. A bank statement line
--      a member bound to an expense (`tally.bind_txn`) is NOT touched: it was the
--      bank's row and Tally only pointed at it;
--    - the `core_entity_kind` rows of the `tally.*` kinds, and any
--      `access_seed_row` Tally left.
--    Kept: every `core_party` (a friend was a person first), and the documents
--    and photos that were once a receipt (the attachment leaves, the file does not).
--    What is lost is counted in `crates/vault/tests/drop_tally.rs`, table by table.
-- 2. **The objects.** The index over expenses and its vocabulary; the two
--    indexes' re-indexing triggers that sit on tables other than Tally's own
--    (`knowledge_annotation`, `social_circle`); then the twelve tables, children
--    before parents. A table's own indexes and triggers leave with it.
-- 3. **The circle index (R-1099-35).** `fts_social_circle` was kept in rung
--    thirteen for exactly one reader, the search door's circle container, which
--    found a circle only while a live `tally_group` stood on it. Its two writers
--    on `social_circle` name `tally_group` in their guard, so with the table gone
--    they would fail every circle insert. Nothing else reads the index, so it
--    leaves with its vocabulary and its six triggers, rather than being given a
--    guard that is always false.
-- 4. **The chat's two app lists (R-1099-22).** `chat_thread.scope_app` and
--    `chat_message_card.app` named 'tally'; the assistant's seventh app is now
--    Money, so the one rebuild that has to happen anyway moves the word. Tally's
--    chat rows are decided here, not left to fail the CHECK:
--    - a thread scoped to Tally KEEPS its messages and becomes unscoped
--      (`scope_app` NULL): what the member said and was told is theirs, and the
--      thread opens like any other;
--    - a card that pointed at a Tally row is DELETED, because it is a snapshot of
--      a row that no longer exists (a card has no foreign key to its row) and
--      tapping it could open nothing. Its message keeps its text.
--    The rebuild carries the four chat tables in the way rung twelve does, and
--    additionally their rowids and the guards and search triggers that sit on
--    them: `fts_chat_thread` is keyed by the THREAD'S rowid, so a thread that came
--    back under another rowid would answer a search with another thread.
--
-- ## Idempotent over its own result
--
-- The suites wind a founded file back by pragma and climb again, and a file
-- founded at this rung has no `tally_group` to read the circles from. The one
-- statement that reads a table this rung drops therefore creates it empty first
-- if it is absent (`CREATE TABLE IF NOT EXISTS`), which on a real rung-fourteen
-- file does nothing, and the table is dropped again with the rest.
--
-- ## What a Tally vault keeps of Tally
--
-- Nothing but the spine rows named above. A member who wants a record of what
-- they owed keeps the backup they took before the climb: the pre-migration
-- snapshot every climb takes first is that record.

-- ---------------------------------------------------------------------------
-- 1. The rows Tally wrote.
-- ---------------------------------------------------------------------------

DELETE FROM schedule_recurrence_exception WHERE target_type = 'tally.recurring_expense';

CREATE TABLE IF NOT EXISTS tally_group (circle_id TEXT);

CREATE TEMP TABLE tally_circle_carry AS SELECT circle_id FROM tally_group;

DELETE FROM core_entity WHERE entity_type LIKE 'tally.%';

DELETE FROM social_circle_member WHERE circle_id IN (SELECT circle_id FROM temp.tally_circle_carry);
DELETE FROM social_circle WHERE circle_id IN (SELECT circle_id FROM temp.tally_circle_carry);

DROP TABLE temp.tally_circle_carry;

DELETE FROM core_transaction
 WHERE external_id LIKE 'tally:settlement:%'
   AND account_id IN (SELECT account_id FROM core_account WHERE name = 'Tally settlements');

DELETE FROM core_account
 WHERE name = 'Tally settlements'
   AND NOT EXISTS (SELECT 1 FROM core_transaction t WHERE t.account_id = core_account.account_id)
   AND NOT EXISTS (SELECT 1 FROM money_account m WHERE m.account_id = core_account.account_id);

DELETE FROM access_seed_row WHERE app_id = 'tally' OR target_type LIKE 'tally.%';

DELETE FROM core_entity_kind WHERE kind LIKE 'tally.%';

-- ---------------------------------------------------------------------------
-- 2. The objects: the expense index and its writers on other tables.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS fts_tally_expense_from_knowledge_annotation_ad;
DROP TRIGGER IF EXISTS fts_tally_expense_from_knowledge_annotation_ai;
DROP TRIGGER IF EXISTS fts_tally_expense_from_knowledge_annotation_au;
DROP TRIGGER IF EXISTS fts_tally_expense_from_social_circle_au;
DROP TRIGGER IF EXISTS fts_tally_expense_from_tally_expense_line_item_ad;
DROP TRIGGER IF EXISTS fts_tally_expense_from_tally_expense_line_item_ai;
DROP TRIGGER IF EXISTS fts_tally_expense_from_tally_expense_line_item_au;
DROP TRIGGER IF EXISTS fts_tally_expense_from_tally_group_au;
DROP TRIGGER IF EXISTS fts_tally_expense_ad;
DROP TRIGGER IF EXISTS fts_tally_expense_ai;
DROP TRIGGER IF EXISTS fts_tally_expense_au;
DROP TABLE IF EXISTS fts_tally_expense_vocab;
DROP TABLE IF EXISTS fts_tally_expense;

-- ---------------------------------------------------------------------------
-- 3. The circle index (R-1099-35).
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS fts_social_circle_from_tally_group_ad;
DROP TRIGGER IF EXISTS fts_social_circle_from_tally_group_ai;
DROP TRIGGER IF EXISTS fts_social_circle_from_tally_group_au;
DROP TRIGGER IF EXISTS fts_social_circle_ad;
DROP TRIGGER IF EXISTS fts_social_circle_ai;
DROP TRIGGER IF EXISTS fts_social_circle_au;
DROP TABLE IF EXISTS fts_social_circle_vocab;
DROP TABLE IF EXISTS fts_social_circle;

-- ---------------------------------------------------------------------------
-- 2 (continued). The twelve tables, children before parents.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS tally_expense_line_allocation;
DROP TABLE IF EXISTS tally_expense_line_item;
DROP TABLE IF EXISTS tally_expense_payer;
DROP TABLE IF EXISTS tally_expense_split;
DROP TABLE IF EXISTS tally_expense;
DROP TABLE IF EXISTS tally_recurring_expense_split;
DROP TABLE IF EXISTS tally_recurring_expense;
DROP TABLE IF EXISTS tally_settlement;
DROP TABLE IF EXISTS tally_obligation;
DROP TABLE IF EXISTS tally_nudge;
DROP TABLE IF EXISTS tally_friend;
DROP TABLE IF EXISTS tally_group;

-- ---------------------------------------------------------------------------
-- 4. The chat's two app lists: 'tally' becomes 'money'.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE chat_thread_carry AS
SELECT rowid AS carried_rowid, thread_id, title,
       CASE WHEN scope_app = 'tally' THEN NULL ELSE scope_app END AS scope_app,
       created_at, updated_at, row_version
  FROM chat_thread;

CREATE TEMP TABLE chat_message_carry AS
SELECT thread_id, ordinal, role, text, outcome, refusal, notice, record_json, created_at
  FROM chat_message;

CREATE TEMP TABLE chat_message_card_carry AS
SELECT thread_id, message_ordinal, position, app, entity, row_id,
       qualifier, title, subtitle, meta
  FROM chat_message_card
 WHERE app <> 'tally';

CREATE TEMP TABLE chat_message_attachment_carry AS
SELECT thread_id, message_ordinal, position, kind, label,
       asset_id, document_id, thumb_content_id
  FROM chat_message_attachment;

DROP TABLE chat_message_attachment;
DROP TABLE chat_message_card;
DROP TABLE chat_message;
DROP TABLE chat_thread;

CREATE TABLE chat_thread (
  thread_id   TEXT PRIMARY KEY,
  title       TEXT NOT NULL CHECK (length(trim(title)) > 0),
  scope_app   TEXT CHECK (scope_app IS NULL
                          OR scope_app IN ('agenda','docs','money','notes','people','photos','tasks')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (thread_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

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

-- The thread comes back under the rowid it had: `fts_chat_thread` is keyed by it.
INSERT INTO chat_thread
  (rowid, thread_id, title, scope_app, created_at, updated_at, row_version)
SELECT carried_rowid, thread_id, title, scope_app, created_at, updated_at, row_version
  FROM temp.chat_thread_carry
 ORDER BY carried_rowid;

INSERT INTO chat_message
  (thread_id, ordinal, role, text, outcome, refusal, notice, record_json, created_at)
SELECT thread_id, ordinal, role, text, outcome, refusal, notice, record_json, created_at
  FROM temp.chat_message_carry
 ORDER BY thread_id, ordinal;

INSERT INTO chat_message_card
  (thread_id, message_ordinal, position, app, entity, row_id,
   qualifier, title, subtitle, meta)
SELECT thread_id, message_ordinal, position, app, entity, row_id,
       qualifier, title, subtitle, meta
  FROM temp.chat_message_card_carry
 ORDER BY thread_id, message_ordinal, position;

INSERT INTO chat_message_attachment
  (thread_id, message_ordinal, position, kind, label,
   asset_id, document_id, thumb_content_id)
SELECT thread_id, message_ordinal, position, kind, label,
       asset_id, document_id, thumb_content_id
  FROM temp.chat_message_attachment_carry
 ORDER BY thread_id, message_ordinal, position;

DROP TABLE temp.chat_message_attachment_carry;
DROP TABLE temp.chat_message_card_carry;
DROP TABLE temp.chat_message_carry;
DROP TABLE temp.chat_thread_carry;

-- The indexes, guards and search triggers that went with the four tables, in
-- the text rungs eleven, twelve and thirteen gave them.

CREATE INDEX chat_thread_recent_idx ON chat_thread(updated_at DESC, thread_id DESC);

CREATE INDEX idx_chat_attachment_asset
  ON chat_message_attachment(asset_id) WHERE asset_id IS NOT NULL;

CREATE INDEX idx_chat_attachment_document
  ON chat_message_attachment(document_id) WHERE document_id IS NOT NULL;

CREATE INDEX idx_chat_attachment_thumb
  ON chat_message_attachment(thumb_content_id) WHERE thumb_content_id IS NOT NULL;

CREATE TRIGGER chat_message_is_not_born_settled
BEFORE INSERT ON chat_message
WHEN NEW.outcome IN ('applied','dismissed','stale','failed')
BEGIN
  SELECT RAISE(ABORT, 'a message is proposed before it is settled: it is not born applied, dismissed, stale or failed');
END;

CREATE TRIGGER chat_message_outcome_settles_once
BEFORE UPDATE OF outcome ON chat_message
WHEN NEW.outcome IS NOT OLD.outcome
BEGIN
  SELECT RAISE(ABORT, 'a told answer does not change: only a proposal settles, and once')
   WHERE OLD.outcome <> 'proposed';
  SELECT RAISE(ABORT, 'a proposal settles as applied, dismissed, stale or failed')
   WHERE NEW.outcome NOT IN ('applied','dismissed','stale','failed');
END;

CREATE TRIGGER chat_thread_entity_delete
AFTER DELETE ON chat_thread
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.thread_id;
END;

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

CREATE TRIGGER fts_chat_thread_ad
  AFTER DELETE ON chat_thread
BEGIN
  DELETE FROM fts_chat_thread WHERE rowid = old.rowid;
END;

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
