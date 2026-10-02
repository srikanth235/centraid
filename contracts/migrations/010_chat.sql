-- THE ON-DEVICE CHAT KEEPS ITS HISTORY IN THE VAULT — RUNG TEN.
--
-- **ON THE LADDER.** `LADDER` in `crates/vault/src/migrations.rs` ends here.
-- The file is both the migration and its fixture (D-1020-D1-13).
--
-- **NEVER EDITED FROM HERE ON.** A file in the field has already run this text;
-- an edit changes what a fresh file gets and nothing else, which is two schemas
-- with one number. A correction is rung eleven.
--
-- ## What this is for
--
-- A member's conversations with the on-device assistant are THEIR data: backed
-- up with the rest of the vault, deletable, and per vault (R-CHAT-1). This
-- supersedes the #1029 W19 drop of the `conversation ⊃ turn ⊃ item` ledger —
-- that band was the assistant plane's own transcript; this is the member-facing
-- history, a different thing under a smaller shape.
--
-- ## The shape
--
-- - `chat_thread` is an ENTITY (a `core_entity` member, so an id names one
--   thing). Its title is the first question, trimmed; its scope is the app the
--   chat was opened from, or NULL for every app.
-- - `chat_message` is a PROJECTION of its thread, keyed by it: one row per
--   thing said, the member's question and the assistant's answer in turn
--   order. Deleting the thread deletes every message with it.
-- - `chat_message_card` and `chat_message_attachment` are PROJECTIONS of a
--   message, keyed by it.
--
-- ## A CARD IS A SNAPSHOT, WITH NO FOREIGN KEY (R-CHAT-3)
--
-- An answer's card names a row in another app (`tasks` / `task` / an id) and
-- carries the title, subtitle and meta the member read. It deliberately holds
-- NO reference to that row: the card is what the answer SAID, the row may be
-- renamed, trashed or purged, and a foreign key would turn a member's own
-- deletion of a task into either a refusal or a hole in their history. #916's
-- polymorphic-reference lesson is that a pointer the engine cannot see is a
-- pointer nobody sweeps, so the pair is named `app` + `entity` + `row_id` and
-- stated here as a snapshot; the shell asks the vault whether the row is still
-- there at the moment of the tap, and says "This item is gone." when it is not.
-- Locker is not an app a card can name: the CHECK lists the seven apps the
-- assistant reads and nothing else.
--
-- ## AN ATTACHMENT IS A REFERENCE (R-CHAT-4)
--
-- A photograph or a document the member attached is stored as the typed
-- reference it was: `asset_id` into `media_asset`, `document_id` into
-- `core_document`, each `ON DELETE SET NULL` so deleting the photograph leaves
-- the question and its label and loses the pointer. A camera-roll image has no
-- vault row to point at, so what is kept is a small thumbnail (at most 256
-- pixels, JPEG) minted as a `core_content_item` in the byte plane and named by
-- `thumb_content_id`; the bytes are rented, so the column is listed in the
-- registry's `contentReferences` and a content item no chat rents is
-- reclaimable. The original image is never kept.
--
-- ## WHY THE COLUMN NAMES
--
-- `chat_message.record_json` is the assistant's own routing record for a
-- turn (the read it made and the headline it was handed), which is what lets
-- a reopened thread's follow-up question be routed the way it would have been
-- had the app never closed. The model still sees only the last two turns.
--
-- The seven app ids appear in two CHECKs (`scope_app`, `app`) because a rung
-- that adds an app to the assistant rebuilds both: v0 states the list where
-- the rows are rather than in a table the rows would have to reference.

INSERT OR IGNORE INTO core_entity_kind (kind) VALUES ('chat.thread');

CREATE TABLE chat_thread (
  thread_id   TEXT PRIMARY KEY,
  title       TEXT NOT NULL CHECK (length(trim(title)) > 0),
  scope_app   TEXT CHECK (scope_app IS NULL
                          OR scope_app IN ('agenda','docs','notes','people','photos','tally','tasks')),
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
  outcome     TEXT NOT NULL CHECK (outcome IN ('sent','answered','stopped','refused')),
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
                  CHECK (app IN ('agenda','docs','notes','people','photos','tally','tasks')),
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

CREATE INDEX chat_thread_recent_idx ON chat_thread(updated_at DESC, thread_id DESC);

CREATE INDEX idx_chat_attachment_asset
  ON chat_message_attachment(asset_id) WHERE asset_id IS NOT NULL;

CREATE INDEX idx_chat_attachment_document
  ON chat_message_attachment(document_id) WHERE document_id IS NOT NULL;

CREATE INDEX idx_chat_attachment_thumb
  ON chat_message_attachment(thumb_content_id) WHERE thumb_content_id IS NOT NULL;

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
