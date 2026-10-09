-- A PROPOSAL KEEPS ITS LIFE IN THE VAULT — RUNG TWELVE (#1088, R-1088-2, R-1088-10).
--
-- **ON THE LADDER.** `LADDER` in `crates/vault/src/migrations.rs` ends here.
-- The file is both the migration and its fixture (D-1020-D1-13).
--
-- **NEVER EDITED FROM HERE ON.** A file in the field has already run this text;
-- an edit changes what a fresh file gets and nothing else, which is two schemas
-- with one number. A correction is rung thirteen.
--
-- ## What this is for
--
-- On the phone every write the assistant makes PARKS behind a confirm card and
-- runs only on the member's tap (R-1088-2). The turn that parked is saved like
-- any other, and until now its stored line read "Proposed: …" for good: a card
-- that was applied, dismissed or overtaken left the thread saying it was still
-- waiting, and a thread reopened a week later showed a question the member had
-- answered as an open one. The pending write itself stays in memory and is inert
-- when its thread is reopened (R-1088-10) — executable state is not stored — so
-- what the vault keeps is only the OUTCOME of the proposal, and `chat_message`
-- needs four more words for it.
--
-- ## The five words, and why these
--
-- `chat_message.outcome` gains five values. They are one proposal's life,
-- because a proposal is a state with an end and the vault must be able to say
-- which end it had:
--
-- - `proposed` — the turn ended in a write that waits for a tap. It is the
--   answer's outcome when the turn is saved, in place of `answered`.
-- - `applied`   — the member tapped and every step ran.
-- - `dismissed` — nothing ran: the member dismissed the card, or sent another
--   message, which dismisses it (the runtime's own word for both).
-- - `stale`     — nothing ran: a row the steps address had changed since the
--   turn planned them, so the card was refused rather than made.
-- - `failed`    — the vault refused a step. A batch is not atomic across
--   commands, so the steps before the refused one DID run; `stale` and
--   `dismissed` promise that nothing did, and this word does not.
--
-- Not listed: a proposal that no session holds any more (the app closed with
-- the card on screen). It stays `proposed` — which is true: it was proposed,
-- and nothing has answered it — until the next turn saved into the thread
-- dismisses it, as a new message does in a live session. A reader that finds a
-- `proposed` message in a thread it just opened knows no card is waiting on it.
--
-- ## A proposal settles once
--
-- Two triggers state the rule where every writer meets it, because a CHECK
-- sees only the row it is given and this rule is about two rows in a row's
-- life. `chat_message_is_not_born_settled`: a message is inserted as `sent`,
-- `answered`, `stopped`, `refused` or `proposed`, and never as one of the four
-- ends. `chat_message_outcome_settles_once`: only a `proposed` message changes
-- its outcome, and only into one of the four ends, so a told answer never
-- becomes another one and an end is final. The settled line replaces the
-- proposal's `text` in the same statement, written by `chat.settle_proposal`
-- alone; `text` has no guard of its own because nothing else rewrites it.
--
-- `chat_message` was append-only; it is now mutable in this one way, and the
-- registry's lifecycle for `chat.message` says `mutable`. It gains no
-- `updated_at` or `row_version`: the table is not replicated, and the settle
-- moves the thread's own `updated_at`.
--
-- ## Why a rebuild that carries three tables
--
-- SQLite cannot change a CHECK in place, so `chat_message` is rebuilt, as rung
-- seven rebuilt `locker_key`. What is different from rung six's rebuild is the
-- foreign keys: `chat_message_card` and `chat_message_attachment` reference
-- `chat_message` with `ON DELETE CASCADE`, and a `DROP TABLE` runs an implicit
-- `DELETE` first whose cascade `defer_foreign_keys` does NOT defer (only the
-- violation count is deferred, not the action). Dropping the parent with its
-- children standing would silently empty every card and attachment of every
-- thread. So all three tables are carried in TEMP tables, the two children are
-- dropped first and the parent last, and they come back parent first, with
-- their primary keys and the same text. The attachments' own references
-- (`media_asset`, `core_document`, `core_content_item`) sit on the child's side
-- and dropping the child touches none of them, so nothing is set NULL on the
-- way.
--
-- Nothing else references any of the three tables, no view names them, and no
-- trigger was ever on them: `chat_thread`'s three triggers and its index are
-- untouched. The three attachment indexes go with their table and are created
-- again below with rung eleven's own text.

CREATE TEMP TABLE chat_message_carry AS
SELECT thread_id, ordinal, role, text, outcome, refusal, notice, record_json, created_at
  FROM chat_message;

CREATE TEMP TABLE chat_message_card_carry AS
SELECT thread_id, message_ordinal, position, app, entity, row_id,
       qualifier, title, subtitle, meta
  FROM chat_message_card;

CREATE TEMP TABLE chat_message_attachment_carry AS
SELECT thread_id, message_ordinal, position, kind, label,
       asset_id, document_id, thumb_content_id
  FROM chat_message_attachment;

DROP TABLE chat_message_attachment;
DROP TABLE chat_message_card;
DROP TABLE chat_message;

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

-- Rung eleven's own indexes on the attachment table, in its own text.

CREATE INDEX idx_chat_attachment_asset
  ON chat_message_attachment(asset_id) WHERE asset_id IS NOT NULL;

CREATE INDEX idx_chat_attachment_document
  ON chat_message_attachment(document_id) WHERE document_id IS NOT NULL;

CREATE INDEX idx_chat_attachment_thumb
  ON chat_message_attachment(thumb_content_id) WHERE thumb_content_id IS NOT NULL;

-- New: a message is never born settled, and a proposal settles once, and only
-- into one of the four ends.

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
