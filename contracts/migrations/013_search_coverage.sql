-- SEARCH FINDS WHAT A MEMBER TYPED — RUNG THIRTEEN (#1097, R1, R1a, R1b, R1c, R1d, R2a, R3, R5, R6).
--
-- **ON THE LADDER.** `LADDER` in `crates/vault/src/migrations.rs` ends here.
-- The file is both the migration and its fixture (D-1020-D1-13).
--
-- **NEVER EDITED FROM HERE ON.** A file in the field has already run this text;
-- an edit changes what a fresh file gets and nothing else, which is two schemas
-- with one number. A correction is rung fourteen.
--
-- ## What this is for
--
-- The vault keeps seventeen full-text indexes, written by triggers on every
-- save, and the search door reads seven of them. A member who typed a person's
-- nickname, an email, where they met, a memo; an event's place; a task's
-- project; an expense's category, group, line item or memo, searched for it and
-- found nothing, in the app and on Home, because the text lived in a table whose
-- index nothing read. This rung moves that text into the index the door DOES
-- read, so one probe per domain still answers (the domains stay at seven), it
-- retires seven indexes nothing reads (R2a), it keeps four for the door's
-- other registry, the containers a member files things in (R5), and it adds one
-- to that registry for the chat history, found by what the member said (R6).
--
-- ## R1 — an entity's index folds in its attribute text
--
-- Each index is dropped and created again with the columns below AFTER the ones
-- it had, and filled from the live rows with the same SELECT its triggers run.
--
--   fts_core_party    + nickname, role, met   people_profile of the party, while the
--                                             profile is not trashed
--                     + channels              every social_contact_channel value and
--                                             normalized_value of the party
--                     + memo                  every knowledge_annotation on the
--                                             party (target_type 'core.party',
--                                             written by `people.add_note`), and
--                                             on every activity with a live
--                                             core_link to the party (target_type
--                                             'core.activity', written by
--                                             `people.log_interaction`)
--   fts_core_event    + location              core_place.name of location_place_id
--   fts_schedule_task + project               schedule_project.name of project_id
--   fts_tally_expense + category              the category, unless it is 'general'
--                     + group_name            the group's social_circle.name
--                     + items                 every tally_expense_line_item description
--                     + memo                  the expense's knowledge_annotation
--                                             (target_type 'tally.expense')
--
-- A child table that feeds an index has triggers that RE-INDEX THE PARENT ROW:
-- delete its index row by the parent's rowid, then insert it again from the
-- parent with the fold expressions. They are named
-- `fts_<index>_from_<child table>_<ai|au|ad>`, so the snapshot recognises them
-- by their body (`mentions_fts_table`) and keeps them like the base triggers.
-- A rename of a project, a place or a circle re-indexes every task, event or
-- expense that names it; a profile, channel, line item or memo that is
-- edited, trashed, restored, re-pointed (a merge moves them) or deleted
-- re-indexes its party or expense. A TRASHED PARENT STAYS OUT OF THE INDEX
-- exactly as before: events, tasks and expenses carry the `deleted_at` guard
-- the base triggers always had; a party never had one and still has none.
--
-- A place is never inserted with an event already pointing at it and cannot be
-- deleted while one does (`core_event.location_place_id` has no ON DELETE
-- action), and a project's delete sets its tasks' `project_id` to NULL, which
-- fires the task's own trigger; so the place and the project need only an
-- UPDATE trigger.
--
-- ## R1a, R1d — rank weights, and why the index does not store them
--
-- Every column an index had, the UNINDEXED id included, weighs 1.0 and every
-- folded column 0.5: a word in a title or a name outranks the same word in a
-- project, a nickname or a memo. THE WEIGHTS ARE NOT IN THIS RUNG. FTS5 can
-- keep them in the index's own `_config` table (`INSERT INTO <fts>(<fts>,
-- rank) VALUES('rank', 'bm25(…)')`), but that is a row of data, and
-- `contracts/schema/vault-ddl.sql` carries tables and no data: a vault built by
-- replaying it would rank differently from one that ran this rung, and a claim
-- about order would hold in one and not in the other. So the list lives in
-- `crates/search/src/domains.rs`, one weight per index column in order on each
-- domain, and the door passes it with every query (`AND <fts>.rank MATCH
-- 'bm25(…)'`). The door refuses to open over an index whose column count is not
-- the list's length.
--

-- ## R1b — what is not folded
--
-- A TRASHED PROFILE's nickname, role and met are not in the index: trashing the
-- profile hides the person from People while the party stays, and what the
-- member can no longer see must not be found. Restoring it puts them back.
-- A category of 'general' is the default every expense carries, so folding it
-- would match every expense that never chose one.
--
-- ## R1c — a Locker memo is in no index
--
-- A memo on a Locker item is a `knowledge_annotation` with target_type
-- 'locker.item', written in plaintext on purpose (`commands/locker.rs`
-- `replace_memo`). Locker is not a search domain (D-1020-N1), and
-- every fold and every trigger here selects its annotations by target_type, so
-- that memo reaches no index and no vocabulary. `fts_locker_item` is retired
-- below (R2a): Locker has an index nothing reads and a walker of its own.
--
-- ## R2a — what is retired
--
-- Nine indexes had writers and no reader (`rg -l "fts_<name>\b" --glob '!*.sql'`
-- finds nothing for any of them but one test each for two). The text of three is
-- folded above — `fts_people_profile`, `fts_core_place` and
-- `fts_knowledge_annotation`, with their nine triggers — and the owner chose
-- (Q-1097-1 (c), widened) to retire four more: `fts_core_transaction` and
-- `fts_locker_item` (no feature is proposed to read either, and Locker has its
-- own walker) and `fts_social_thread` and `fts_social_message`, which index the
-- People messaging model (`social_thread`, `social_message`) that has no screen;
-- the Chat tab is `chat_thread` and `chat_message`, which section 8 indexes by
-- what the member said (R6).
-- The door test that proved `locker.item` is no domain now plants its own table.
-- That is seven. The other two of the nine, `fts_schedule_project` and
-- `fts_social_circle`, are KEPT: the owner folded containers into #1097
-- (Q-1097-2 (b)), and a project and a Tally group are two of them (R5).
--
-- ## R3 — a vocabulary for each domain
--
-- `fts_<index>_vocab`, an `fts5vocab(<index>, 'row')` table, for the seven
-- domain indexes, for the four container indexes (R5) and for the chat index
-- (R6), and never for Locker. It lists every term with the number of
-- rows it is in (`term`, `doc`, `cnt`), which is what a correction pass reads
-- to find the word a member meant. It is a persistent table because the read
-- connection is `query_only` and a temp table needs a write. The name is not an
-- FTS5 shadow name (`_config`, `_content`, `_data`, `_docsize`, `_idx`), which
-- is what `log::guard::is_reportable` and the contract vault's `is_fts_shadow`
-- key on; a vocab table is a virtual table, so the snapshot's table census
-- leaves it out. A RUNG THAT REBUILDS A DOMAIN INDEX MUST DROP ITS `_vocab`
-- FIRST and create it again after.
--
-- ## R5 — containers are search results of their own
--
-- A notebook, an album, a Tasks project, a Tally group and a Docs folder are
-- things a member names and goes looking for by that name. They are NOT domains:
-- the Notes `[[` powerbox loops the domains, and a container is no link target.
-- `crates/search` keeps them in a second registry, `NAMED` (it was `CONTAINERS`
-- until the chat joined it, R6), and holds it to the same open-time checks.
-- Four indexes serve them; each has a persistent `_vocab` of its own, so a typo
-- in a container's name is corrected like a typo in a note's.
--
--   fts_core_collection   (collection_id, name)   notebooks AND albums. UNCHANGED:
--                                                 `core_collection.kind` is immutable
--                                                 (006) and the door already joins
--                                                 the base row, so the app a hit
--                                                 opens in is read off `kind` at
--                                                 query time and the index carries
--                                                 no column the base lacks.
--   fts_schedule_project  (project_id, name)      a project, while `archived_at` is
--                                                 NULL. Kept as the baseline made it,
--                                                 with the archive guard added to its
--                                                 triggers: an archived project
--                                                 leaves the index, restoring it puts
--                                                 it back.
--   fts_social_circle     (circle_id, name)       a circle that a LIVE `tally_group`
--                                                 stands on (`archived_at IS NULL`).
--                                                 People has no circles screen, so a
--                                                 circle with no group is no result;
--                                                 `fts_social_circle_from_tally_group_*`
--                                                 re-index the circle when a group is
--                                                 made, archived, restored or deleted.
--   fts_core_concept      (concept_id, pref_label) a FOLDER: a concept of the folders
--                                                 scheme that is not the `root`. Named
--                                                 for its table, as every index is; it
--                                                 holds a subset of it, as every index
--                                                 of a table with a guard does. Tags
--                                                 and flags are concepts of other
--                                                 schemes and are never in it.
--
-- A notebook, a circle, a folder are removed by DELETE, not by a flag, so the
-- `_ad` triggers stay; a hit is live because the index holds live rows only.
--
-- ## R6 — the chat history is found by what the member said (R-1097-22)
--
-- A conversation is a thing a member goes looking for by a word they remember
-- asking. It is no container (nothing is filed in a thread) and no domain, so it
-- is one more entry in the door's second registry, which is named for what it
-- now holds (`crates/search/src/named.rs`, R-1097-23).
--
--   fts_chat_thread       (thread_id, title, said)   ONE ROW PER THREAD. `title` is the
--                                                    thread's own; `said` is the text of
--                                                    the member's OWN messages
--                                                    (`chat_message.role = 'user'`), in
--                                                    order, joined by a space, folded and
--                                                    capped like every folded body
--                                                    (262144 characters, then the
--                                                    truncation marker).
--
-- NEVER INDEXED: the assistant's text, its cards, attachments, `record_json`,
-- `refusal`, `notice`, `outcome` and `scope_app`. The assistant's words and a
-- card's title are copies of other apps' rows that outlive the rows (R-CHAT-3),
-- so a hit on them would answer with data the member has since deleted; the
-- routing record is not text. The triggers below select `role = 'user'` and read
-- no other column of `chat_message`.
--
-- A message that is inserted, edited or deleted re-indexes its thread, exactly as
-- a line item re-indexes its expense, and the triggers are named
-- `fts_chat_thread_from_chat_message_<ai|au|ad>`. They cover `replace_last` (a
-- delete and an insert) and the foreign key's cascade from a thread's delete and
-- from `chat.clear`: SQLite fires a child's triggers for a cascaded delete, and
-- the thread's own `_ad` trigger removes the row after them. A message trigger
-- re-indexes only while its thread is still there, so deleting a long thread
-- does not rebuild the index row once per message it takes away.
--
-- ## Idempotent on purpose
--
-- Every DROP is IF EXISTS and every CREATE follows its DROP. The suites wind a
-- founded file back by pragma and climb again over objects that are already
-- this rung's; nothing in a real file ever runs it twice.

-- 1. Retire what nothing reads (R2a).

DROP TRIGGER IF EXISTS fts_people_profile_ai;
DROP TRIGGER IF EXISTS fts_people_profile_au;
DROP TRIGGER IF EXISTS fts_people_profile_ad;
DROP TABLE IF EXISTS fts_people_profile;

DROP TRIGGER IF EXISTS fts_core_place_ai;
DROP TRIGGER IF EXISTS fts_core_place_au;
DROP TRIGGER IF EXISTS fts_core_place_ad;
DROP TABLE IF EXISTS fts_core_place;

DROP TRIGGER IF EXISTS fts_knowledge_annotation_ai;
DROP TRIGGER IF EXISTS fts_knowledge_annotation_au;
DROP TRIGGER IF EXISTS fts_knowledge_annotation_ad;
DROP TABLE IF EXISTS fts_knowledge_annotation;

DROP TRIGGER IF EXISTS fts_core_transaction_ai;
DROP TRIGGER IF EXISTS fts_core_transaction_au;
DROP TRIGGER IF EXISTS fts_core_transaction_ad;
DROP TABLE IF EXISTS fts_core_transaction;

DROP TRIGGER IF EXISTS fts_locker_item_ai;
DROP TRIGGER IF EXISTS fts_locker_item_au;
DROP TRIGGER IF EXISTS fts_locker_item_ad;
DROP TABLE IF EXISTS fts_locker_item;

DROP TRIGGER IF EXISTS fts_social_message_ai;
DROP TRIGGER IF EXISTS fts_social_message_au;
DROP TRIGGER IF EXISTS fts_social_message_ad;
DROP TABLE IF EXISTS fts_social_message;

DROP TRIGGER IF EXISTS fts_social_thread_ai;
DROP TRIGGER IF EXISTS fts_social_thread_au;
DROP TRIGGER IF EXISTS fts_social_thread_ad;
DROP TABLE IF EXISTS fts_social_thread;

-- `fts_social_message` was also written by four triggers that belong to the
-- other indexes (a body's text or a representation arriving re-indexes every
-- note, document and message that owns it). Each is created again with the
-- baseline's own text MINUS its last block, the message's: a trigger that
-- inserts into a dropped table fails the statement that fired it.

DROP TRIGGER IF EXISTS trg_fts_content_text_ai;
CREATE TRIGGER trg_fts_content_text_ai AFTER INSERT ON core_content_text
BEGIN
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE current_content_id = NEW.content_id);
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) END)
    FROM core_document d
   WHERE d.current_content_id = NEW.content_id AND d."deleted_at" IS NULL;
  DELETE FROM fts_knowledge_note
   WHERE rowid IN (SELECT rowid FROM knowledge_note WHERE "body_content_id" = NEW.content_id);
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
  SELECT b.rowid, b."note_id", b."title", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM knowledge_note b
   WHERE b."body_content_id" = NEW.content_id AND b."deleted_at" IS NULL;
END;

DROP TRIGGER IF EXISTS trg_fts_content_text_au;
CREATE TRIGGER trg_fts_content_text_au AFTER UPDATE ON core_content_text
BEGIN
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE current_content_id = NEW.content_id);
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) END)
    FROM core_document d
   WHERE d.current_content_id = NEW.content_id AND d."deleted_at" IS NULL;
  DELETE FROM fts_knowledge_note
   WHERE rowid IN (SELECT rowid FROM knowledge_note WHERE "body_content_id" = NEW.content_id);
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
  SELECT b.rowid, b."note_id", b."title", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM knowledge_note b
   WHERE b."body_content_id" = NEW.content_id AND b."deleted_at" IS NULL;
END;

DROP TRIGGER IF EXISTS trg_fts_representation_ai;
CREATE TRIGGER trg_fts_representation_ai AFTER INSERT ON core_content_representation
BEGIN
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE document_id = NEW.owner_id)
     AND NEW.owner_type = 'core.document';
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) END)
    FROM core_document d
   WHERE d."document_id" = NEW.owner_id AND NEW.owner_type = 'core.document' AND d."deleted_at" IS NULL;
  DELETE FROM fts_knowledge_note
   WHERE rowid IN (SELECT rowid FROM knowledge_note WHERE "note_id" = NEW.owner_id)
     AND NEW.owner_type = 'knowledge.note';
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
  SELECT b.rowid, b."note_id", b."title", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM knowledge_note b
   WHERE b."note_id" = NEW.owner_id AND NEW.owner_type = 'knowledge.note' AND b."deleted_at" IS NULL;
END;

DROP TRIGGER IF EXISTS trg_fts_representation_au;
CREATE TRIGGER trg_fts_representation_au AFTER UPDATE ON core_content_representation
BEGIN
  DELETE FROM fts_core_document
   WHERE rowid IN (SELECT rowid FROM core_document WHERE document_id = NEW.owner_id)
     AND NEW.owner_type = 'core.document';
  INSERT INTO fts_core_document (rowid, document_id, title, body)
  SELECT d.rowid, d."document_id", d."title", (CASE WHEN COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) IS NULL THEN NULL
                 WHEN length(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id"))) > 262144
                 THEN substr(COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")), 1, 262144) || ' ...(truncated for search index)'
                 ELSE COALESCE(
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'text'),
    (SELECT dv.text_content FROM core_content_derivative dv
      WHERE dv.content_id = d."current_content_id" AND dv.variant = 'transcript'),
    (SELECT ct."body_text" FROM core_content_text ct
      WHERE ct.content_id = d."current_content_id")) END)
    FROM core_document d
   WHERE d."document_id" = NEW.owner_id AND NEW.owner_type = 'core.document' AND d."deleted_at" IS NULL;
  DELETE FROM fts_knowledge_note
   WHERE rowid IN (SELECT rowid FROM knowledge_note WHERE "note_id" = NEW.owner_id)
     AND NEW.owner_type = 'knowledge.note';
  INSERT INTO fts_knowledge_note(rowid, note_id, title, body)
  SELECT b.rowid, b."note_id", b."title", (CASE WHEN (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") IS NULL THEN NULL
                 WHEN length((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id")) > 262144
                 THEN substr((SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id"), 1, 262144) || ' ...(truncated for search index)'
                 ELSE (SELECT body_text FROM core_content_text
            WHERE content_id = b."body_content_id") END) FROM knowledge_note b
   WHERE b."note_id" = NEW.owner_id AND NEW.owner_type = 'knowledge.note' AND b."deleted_at" IS NULL;
END;

-- 2. People (R1): the party's index gains its profile, its reach and its memos.

DROP TABLE IF EXISTS fts_core_party_vocab;
DROP TRIGGER IF EXISTS fts_core_party_ai;
DROP TRIGGER IF EXISTS fts_core_party_au;
DROP TRIGGER IF EXISTS fts_core_party_ad;
DROP TABLE IF EXISTS fts_core_party;

CREATE VIRTUAL TABLE fts_core_party USING fts5(
  party_id UNINDEXED, display_name, sort_name, nickname, role, met, channels, memo,
  tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
  SELECT p.rowid,
         p.party_id,
         p.display_name,
         p.sort_name,
         pp.nickname,
         pp.role,
         pp.met,
         (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
            FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
         (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
           WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
              OR (an.target_type = 'core.activity' AND an.target_id IN (
                    SELECT l.from_id FROM core_link l
                     WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                       AND l.to_id = p.party_id AND l.valid_to IS NULL)))
    FROM core_party p
    LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL;

CREATE TRIGGER fts_core_party_ad
  AFTER DELETE ON core_party
BEGIN
  DELETE FROM fts_core_party WHERE rowid = old.rowid;
END;

CREATE TRIGGER fts_core_party_ai
  AFTER INSERT ON core_party
BEGIN
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                OR (an.target_type = 'core.activity' AND an.target_id IN (
                      SELECT l.from_id FROM core_link l
                       WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                         AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.rowid = new.rowid;
END;

CREATE TRIGGER fts_core_party_au
  AFTER UPDATE ON core_party
BEGIN
  DELETE FROM fts_core_party WHERE rowid = old.rowid;
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                OR (an.target_type = 'core.activity' AND an.target_id IN (
                      SELECT l.from_id FROM core_link l
                       WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                         AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.rowid = new.rowid;
END;

DROP TRIGGER IF EXISTS fts_core_party_from_people_profile_ad;
CREATE TRIGGER fts_core_party_from_people_profile_ad
  AFTER DELETE ON people_profile
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = old.party_id);
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                OR (an.target_type = 'core.activity' AND an.target_id IN (
                      SELECT l.from_id FROM core_link l
                       WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                         AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = old.party_id;
END;

DROP TRIGGER IF EXISTS fts_core_party_from_people_profile_ai;
CREATE TRIGGER fts_core_party_from_people_profile_ai
  AFTER INSERT ON people_profile
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = new.party_id);
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                OR (an.target_type = 'core.activity' AND an.target_id IN (
                      SELECT l.from_id FROM core_link l
                       WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                         AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = new.party_id;
END;

DROP TRIGGER IF EXISTS fts_core_party_from_people_profile_au;
CREATE TRIGGER fts_core_party_from_people_profile_au
  AFTER UPDATE OF party_id, nickname, role, met, deleted_at ON people_profile
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = new.party_id);
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                OR (an.target_type = 'core.activity' AND an.target_id IN (
                      SELECT l.from_id FROM core_link l
                       WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                         AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = new.party_id;
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = old.party_id
         AND old.party_id IS NOT new.party_id);
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                OR (an.target_type = 'core.activity' AND an.target_id IN (
                      SELECT l.from_id FROM core_link l
                       WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                         AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = old.party_id
       AND old.party_id IS NOT new.party_id;
END;

DROP TRIGGER IF EXISTS fts_core_party_from_social_contact_channel_ad;
CREATE TRIGGER fts_core_party_from_social_contact_channel_ad
  AFTER DELETE ON social_contact_channel
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = old.party_id);
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                OR (an.target_type = 'core.activity' AND an.target_id IN (
                      SELECT l.from_id FROM core_link l
                       WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                         AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = old.party_id;
END;

DROP TRIGGER IF EXISTS fts_core_party_from_social_contact_channel_ai;
CREATE TRIGGER fts_core_party_from_social_contact_channel_ai
  AFTER INSERT ON social_contact_channel
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = new.party_id);
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                OR (an.target_type = 'core.activity' AND an.target_id IN (
                      SELECT l.from_id FROM core_link l
                       WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                         AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = new.party_id;
END;

DROP TRIGGER IF EXISTS fts_core_party_from_social_contact_channel_au;
CREATE TRIGGER fts_core_party_from_social_contact_channel_au
  AFTER UPDATE OF party_id, value, normalized_value ON social_contact_channel
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = new.party_id);
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                OR (an.target_type = 'core.activity' AND an.target_id IN (
                      SELECT l.from_id FROM core_link l
                       WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                         AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = new.party_id;
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = old.party_id
         AND old.party_id IS NOT new.party_id);
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                OR (an.target_type = 'core.activity' AND an.target_id IN (
                      SELECT l.from_id FROM core_link l
                       WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                         AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = old.party_id
       AND old.party_id IS NOT new.party_id;
END;

-- A note on an INTERACTION is a `knowledge_annotation` with target_type
-- 'core.activity' (`people.log_interaction`), and the person it is about is on
-- the activity's live `core_link` to a `core.party` (the same edge the People
-- sheet draws its interactions from and `people.purge_person` follows). Its
-- text folds into that party's `memo` (Q-1097-5 (b)): a party is re-indexed by
-- an annotation on it, by an annotation on any activity linked to it, and by
-- the link itself being made, re-pointed, ended or deleted below. An activity
-- cannot be trashed (`core_activity` has no `deleted_at`); its removal
-- cascades its link and its annotation, each of which fires a trigger here.

DROP TRIGGER IF EXISTS fts_core_party_from_knowledge_annotation_ad;
CREATE TRIGGER fts_core_party_from_knowledge_annotation_ad
  AFTER DELETE ON knowledge_annotation
  WHEN old.target_type IN ('core.party', 'core.activity')
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p
     WHERE (old.target_type = 'core.party' AND p.party_id = old.target_id)
        OR (old.target_type = 'core.activity' AND p.party_id IN (
              SELECT l.to_id FROM core_link l
               WHERE l.from_type = 'core.activity' AND l.from_id = old.target_id
                 AND l.to_type = 'core.party' AND l.valid_to IS NULL)));
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
              WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                 OR (an.target_type = 'core.activity' AND an.target_id IN (
                       SELECT l.from_id FROM core_link l
                        WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                          AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE (old.target_type = 'core.party' AND p.party_id = old.target_id)
        OR (old.target_type = 'core.activity' AND p.party_id IN (
              SELECT l.to_id FROM core_link l
               WHERE l.from_type = 'core.activity' AND l.from_id = old.target_id
                 AND l.to_type = 'core.party' AND l.valid_to IS NULL));
END;

DROP TRIGGER IF EXISTS fts_core_party_from_knowledge_annotation_ai;
CREATE TRIGGER fts_core_party_from_knowledge_annotation_ai
  AFTER INSERT ON knowledge_annotation
  WHEN new.target_type IN ('core.party', 'core.activity')
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p
     WHERE (new.target_type = 'core.party' AND p.party_id = new.target_id)
        OR (new.target_type = 'core.activity' AND p.party_id IN (
              SELECT l.to_id FROM core_link l
               WHERE l.from_type = 'core.activity' AND l.from_id = new.target_id
                 AND l.to_type = 'core.party' AND l.valid_to IS NULL)));
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
              WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                 OR (an.target_type = 'core.activity' AND an.target_id IN (
                       SELECT l.from_id FROM core_link l
                        WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                          AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE (new.target_type = 'core.party' AND p.party_id = new.target_id)
        OR (new.target_type = 'core.activity' AND p.party_id IN (
              SELECT l.to_id FROM core_link l
               WHERE l.from_type = 'core.activity' AND l.from_id = new.target_id
                 AND l.to_type = 'core.party' AND l.valid_to IS NULL));
END;

DROP TRIGGER IF EXISTS fts_core_party_from_knowledge_annotation_au;
CREATE TRIGGER fts_core_party_from_knowledge_annotation_au
  AFTER UPDATE OF target_type, target_id, body_text ON knowledge_annotation
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p
     WHERE (new.target_type = 'core.party' AND p.party_id = new.target_id)
        OR (new.target_type = 'core.activity' AND p.party_id IN (
              SELECT l.to_id FROM core_link l
               WHERE l.from_type = 'core.activity' AND l.from_id = new.target_id
                 AND l.to_type = 'core.party' AND l.valid_to IS NULL)));
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
              WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                 OR (an.target_type = 'core.activity' AND an.target_id IN (
                       SELECT l.from_id FROM core_link l
                        WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                          AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE (new.target_type = 'core.party' AND p.party_id = new.target_id)
        OR (new.target_type = 'core.activity' AND p.party_id IN (
              SELECT l.to_id FROM core_link l
               WHERE l.from_type = 'core.activity' AND l.from_id = new.target_id
                 AND l.to_type = 'core.party' AND l.valid_to IS NULL));
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p
     WHERE (old.target_type = 'core.party' AND p.party_id = old.target_id)
        OR (old.target_type = 'core.activity' AND p.party_id IN (
              SELECT l.to_id FROM core_link l
               WHERE l.from_type = 'core.activity' AND l.from_id = old.target_id
                 AND l.to_type = 'core.party' AND l.valid_to IS NULL)));
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
              WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                 OR (an.target_type = 'core.activity' AND an.target_id IN (
                       SELECT l.from_id FROM core_link l
                        WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                          AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE (old.target_type = 'core.party' AND p.party_id = old.target_id)
        OR (old.target_type = 'core.activity' AND p.party_id IN (
              SELECT l.to_id FROM core_link l
               WHERE l.from_type = 'core.activity' AND l.from_id = old.target_id
                 AND l.to_type = 'core.party' AND l.valid_to IS NULL));
END;

-- The link: an activity gains, loses or moves the party it is about.

DROP TRIGGER IF EXISTS fts_core_party_from_core_link_ad;
CREATE TRIGGER fts_core_party_from_core_link_ad
  AFTER DELETE ON core_link
  WHEN old.from_type = 'core.activity' AND old.to_type = 'core.party'
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = old.to_id);
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
              WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                 OR (an.target_type = 'core.activity' AND an.target_id IN (
                       SELECT l.from_id FROM core_link l
                        WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                          AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = old.to_id;
END;

DROP TRIGGER IF EXISTS fts_core_party_from_core_link_ai;
CREATE TRIGGER fts_core_party_from_core_link_ai
  AFTER INSERT ON core_link
  WHEN new.from_type = 'core.activity' AND new.to_type = 'core.party'
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = new.to_id);
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
              WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                 OR (an.target_type = 'core.activity' AND an.target_id IN (
                       SELECT l.from_id FROM core_link l
                        WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                          AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = new.to_id;
END;

DROP TRIGGER IF EXISTS fts_core_party_from_core_link_au;
CREATE TRIGGER fts_core_party_from_core_link_au
  AFTER UPDATE OF from_type, from_id, to_type, to_id, valid_to ON core_link
  WHEN (old.from_type = 'core.activity' AND old.to_type = 'core.party')
    OR (new.from_type = 'core.activity' AND new.to_type = 'core.party')
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p
     WHERE new.from_type = 'core.activity' AND new.to_type = 'core.party'
       AND p.party_id = new.to_id);
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
              WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                 OR (an.target_type = 'core.activity' AND an.target_id IN (
                       SELECT l.from_id FROM core_link l
                        WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                          AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE new.from_type = 'core.activity' AND new.to_type = 'core.party'
       AND p.party_id = new.to_id;
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p
     WHERE old.from_type = 'core.activity' AND old.to_type = 'core.party'
       AND p.party_id = old.to_id
       AND NOT (new.from_type = 'core.activity' AND new.to_type = 'core.party'
                AND new.to_id = old.to_id));
  INSERT INTO fts_core_party(rowid, party_id, display_name, sort_name, nickname, role, met, channels, memo)
    SELECT p.rowid,
           p.party_id,
           p.display_name,
           p.sort_name,
           pp.nickname,
           pp.role,
           pp.met,
           (SELECT group_concat(ch.value || ' ' || ch.normalized_value, ' ')
              FROM social_contact_channel ch WHERE ch.party_id = p.party_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
              WHERE (an.target_type = 'core.party' AND an.target_id = p.party_id)
                 OR (an.target_type = 'core.activity' AND an.target_id IN (
                       SELECT l.from_id FROM core_link l
                        WHERE l.from_type = 'core.activity' AND l.to_type = 'core.party'
                          AND l.to_id = p.party_id AND l.valid_to IS NULL)))
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE old.from_type = 'core.activity' AND old.to_type = 'core.party'
       AND p.party_id = old.to_id
       AND NOT (new.from_type = 'core.activity' AND new.to_type = 'core.party'
                AND new.to_id = old.to_id);
END;

-- 3. Agenda (R1): an event's index gains its place.

DROP TABLE IF EXISTS fts_core_event_vocab;
DROP TRIGGER IF EXISTS fts_core_event_ai;
DROP TRIGGER IF EXISTS fts_core_event_au;
DROP TRIGGER IF EXISTS fts_core_event_ad;
DROP TABLE IF EXISTS fts_core_event;

CREATE VIRTUAL TABLE fts_core_event USING fts5(
  event_id UNINDEXED, summary, description, location,
  tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO fts_core_event(rowid, event_id, summary, description, location)
  SELECT p.rowid,
         p.event_id,
         p.summary,
         p.description,
         pl.name
    FROM core_event p
    LEFT JOIN core_place pl ON pl.place_id = p.location_place_id
   WHERE p.deleted_at IS NULL;

CREATE TRIGGER fts_core_event_ad
  AFTER DELETE ON core_event
BEGIN
  DELETE FROM fts_core_event WHERE rowid = old.rowid;
END;

CREATE TRIGGER fts_core_event_ai
  AFTER INSERT ON core_event
BEGIN
  INSERT INTO fts_core_event(rowid, event_id, summary, description, location)
    SELECT p.rowid,
           p.event_id,
           p.summary,
           p.description,
           pl.name
      FROM core_event p
      LEFT JOIN core_place pl ON pl.place_id = p.location_place_id
     WHERE p.rowid = new.rowid
       AND p.deleted_at IS NULL;
END;

CREATE TRIGGER fts_core_event_au
  AFTER UPDATE ON core_event
BEGIN
  DELETE FROM fts_core_event WHERE rowid = old.rowid;
  INSERT INTO fts_core_event(rowid, event_id, summary, description, location)
    SELECT p.rowid,
           p.event_id,
           p.summary,
           p.description,
           pl.name
      FROM core_event p
      LEFT JOIN core_place pl ON pl.place_id = p.location_place_id
     WHERE p.rowid = new.rowid
       AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS fts_core_event_from_core_place_au;
CREATE TRIGGER fts_core_event_from_core_place_au
  AFTER UPDATE OF name ON core_place
BEGIN
  DELETE FROM fts_core_event WHERE rowid IN (
    SELECT p.rowid FROM core_event p WHERE p.location_place_id = new.place_id);
  INSERT INTO fts_core_event(rowid, event_id, summary, description, location)
    SELECT p.rowid,
           p.event_id,
           p.summary,
           p.description,
           pl.name
      FROM core_event p
      LEFT JOIN core_place pl ON pl.place_id = p.location_place_id
     WHERE p.location_place_id = new.place_id
       AND p.deleted_at IS NULL;
END;

-- 4. Tasks (R1): a task's index gains its project.

DROP TABLE IF EXISTS fts_schedule_task_vocab;
DROP TRIGGER IF EXISTS fts_schedule_task_ai;
DROP TRIGGER IF EXISTS fts_schedule_task_au;
DROP TRIGGER IF EXISTS fts_schedule_task_ad;
DROP TABLE IF EXISTS fts_schedule_task;

CREATE VIRTUAL TABLE fts_schedule_task USING fts5(
  task_id UNINDEXED, title, description, project,
  tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO fts_schedule_task(rowid, task_id, title, description, project)
  SELECT p.rowid,
         p.task_id,
         p.title,
         p.description,
         pr.name
    FROM schedule_task p
    LEFT JOIN schedule_project pr ON pr.project_id = p.project_id
   WHERE p.deleted_at IS NULL;

CREATE TRIGGER fts_schedule_task_ad
  AFTER DELETE ON schedule_task
BEGIN
  DELETE FROM fts_schedule_task WHERE rowid = old.rowid;
END;

CREATE TRIGGER fts_schedule_task_ai
  AFTER INSERT ON schedule_task
BEGIN
  INSERT INTO fts_schedule_task(rowid, task_id, title, description, project)
    SELECT p.rowid,
           p.task_id,
           p.title,
           p.description,
           pr.name
      FROM schedule_task p
      LEFT JOIN schedule_project pr ON pr.project_id = p.project_id
     WHERE p.rowid = new.rowid
       AND p.deleted_at IS NULL;
END;

CREATE TRIGGER fts_schedule_task_au
  AFTER UPDATE ON schedule_task
BEGIN
  DELETE FROM fts_schedule_task WHERE rowid = old.rowid;
  INSERT INTO fts_schedule_task(rowid, task_id, title, description, project)
    SELECT p.rowid,
           p.task_id,
           p.title,
           p.description,
           pr.name
      FROM schedule_task p
      LEFT JOIN schedule_project pr ON pr.project_id = p.project_id
     WHERE p.rowid = new.rowid
       AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS fts_schedule_task_from_schedule_project_au;
CREATE TRIGGER fts_schedule_task_from_schedule_project_au
  AFTER UPDATE OF name ON schedule_project
BEGIN
  DELETE FROM fts_schedule_task WHERE rowid IN (
    SELECT p.rowid FROM schedule_task p WHERE p.project_id = new.project_id);
  INSERT INTO fts_schedule_task(rowid, task_id, title, description, project)
    SELECT p.rowid,
           p.task_id,
           p.title,
           p.description,
           pr.name
      FROM schedule_task p
      LEFT JOIN schedule_project pr ON pr.project_id = p.project_id
     WHERE p.project_id = new.project_id
       AND p.deleted_at IS NULL;
END;

-- 5. Tally (R1): an expense's index gains its category, group, items and memo.

DROP TABLE IF EXISTS fts_tally_expense_vocab;
DROP TRIGGER IF EXISTS fts_tally_expense_ai;
DROP TRIGGER IF EXISTS fts_tally_expense_au;
DROP TRIGGER IF EXISTS fts_tally_expense_ad;
DROP TABLE IF EXISTS fts_tally_expense;

CREATE VIRTUAL TABLE fts_tally_expense USING fts5(
  expense_id UNINDEXED, description, category, group_name, items, memo,
  tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
  SELECT p.rowid,
         p.expense_id,
         p.description,
         CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
         c.name,
         (SELECT group_concat(li.description, ' ')
            FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
         (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
           WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
    FROM tally_expense p
    LEFT JOIN tally_group g ON g.group_id = p.group_id
    LEFT JOIN social_circle c ON c.circle_id = g.circle_id
   WHERE p.deleted_at IS NULL;

CREATE TRIGGER fts_tally_expense_ad
  AFTER DELETE ON tally_expense
BEGIN
  DELETE FROM fts_tally_expense WHERE rowid = old.rowid;
END;

CREATE TRIGGER fts_tally_expense_ai
  AFTER INSERT ON tally_expense
BEGIN
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.rowid = new.rowid
       AND p.deleted_at IS NULL;
END;

CREATE TRIGGER fts_tally_expense_au
  AFTER UPDATE ON tally_expense
BEGIN
  DELETE FROM fts_tally_expense WHERE rowid = old.rowid;
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.rowid = new.rowid
       AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS fts_tally_expense_from_tally_expense_line_item_ad;
CREATE TRIGGER fts_tally_expense_from_tally_expense_line_item_ad
  AFTER DELETE ON tally_expense_line_item
BEGIN
  DELETE FROM fts_tally_expense WHERE rowid IN (
    SELECT p.rowid FROM tally_expense p WHERE p.expense_id = old.expense_id);
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.expense_id = old.expense_id
       AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS fts_tally_expense_from_tally_expense_line_item_ai;
CREATE TRIGGER fts_tally_expense_from_tally_expense_line_item_ai
  AFTER INSERT ON tally_expense_line_item
BEGIN
  DELETE FROM fts_tally_expense WHERE rowid IN (
    SELECT p.rowid FROM tally_expense p WHERE p.expense_id = new.expense_id);
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.expense_id = new.expense_id
       AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS fts_tally_expense_from_tally_expense_line_item_au;
CREATE TRIGGER fts_tally_expense_from_tally_expense_line_item_au
  AFTER UPDATE OF expense_id, description ON tally_expense_line_item
BEGIN
  DELETE FROM fts_tally_expense WHERE rowid IN (
    SELECT p.rowid FROM tally_expense p WHERE p.expense_id = new.expense_id);
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.expense_id = new.expense_id
       AND p.deleted_at IS NULL;
  DELETE FROM fts_tally_expense WHERE rowid IN (
    SELECT p.rowid FROM tally_expense p WHERE p.expense_id = old.expense_id
         AND old.expense_id IS NOT new.expense_id);
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.expense_id = old.expense_id
       AND old.expense_id IS NOT new.expense_id
       AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS fts_tally_expense_from_knowledge_annotation_ad;
CREATE TRIGGER fts_tally_expense_from_knowledge_annotation_ad
  AFTER DELETE ON knowledge_annotation
  WHEN old.target_type = 'tally.expense'
BEGIN
  DELETE FROM fts_tally_expense WHERE rowid IN (
    SELECT p.rowid FROM tally_expense p WHERE p.expense_id = old.target_id
         AND old.target_type = 'tally.expense');
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.expense_id = old.target_id
       AND old.target_type = 'tally.expense'
       AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS fts_tally_expense_from_knowledge_annotation_ai;
CREATE TRIGGER fts_tally_expense_from_knowledge_annotation_ai
  AFTER INSERT ON knowledge_annotation
  WHEN new.target_type = 'tally.expense'
BEGIN
  DELETE FROM fts_tally_expense WHERE rowid IN (
    SELECT p.rowid FROM tally_expense p WHERE p.expense_id = new.target_id
         AND new.target_type = 'tally.expense');
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.expense_id = new.target_id
       AND new.target_type = 'tally.expense'
       AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS fts_tally_expense_from_knowledge_annotation_au;
CREATE TRIGGER fts_tally_expense_from_knowledge_annotation_au
  AFTER UPDATE OF target_type, target_id, body_text ON knowledge_annotation
BEGIN
  DELETE FROM fts_tally_expense WHERE rowid IN (
    SELECT p.rowid FROM tally_expense p WHERE p.expense_id = new.target_id
         AND new.target_type = 'tally.expense');
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.expense_id = new.target_id
       AND new.target_type = 'tally.expense'
       AND p.deleted_at IS NULL;
  DELETE FROM fts_tally_expense WHERE rowid IN (
    SELECT p.rowid FROM tally_expense p WHERE p.expense_id = old.target_id
         AND old.target_type = 'tally.expense'
         AND (old.target_type IS NOT new.target_type OR old.target_id IS NOT new.target_id));
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.expense_id = old.target_id
       AND old.target_type = 'tally.expense'
       AND (old.target_type IS NOT new.target_type OR old.target_id IS NOT new.target_id)
       AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS fts_tally_expense_from_social_circle_au;
CREATE TRIGGER fts_tally_expense_from_social_circle_au
  AFTER UPDATE OF name ON social_circle
BEGIN
  DELETE FROM fts_tally_expense WHERE rowid IN (
    SELECT p.rowid FROM tally_expense p WHERE p.group_id IN (SELECT g.group_id FROM tally_group g WHERE g.circle_id = new.circle_id));
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.group_id IN (SELECT g.group_id FROM tally_group g WHERE g.circle_id = new.circle_id)
       AND p.deleted_at IS NULL;
END;

DROP TRIGGER IF EXISTS fts_tally_expense_from_tally_group_au;
CREATE TRIGGER fts_tally_expense_from_tally_group_au
  AFTER UPDATE OF circle_id ON tally_group
BEGIN
  DELETE FROM fts_tally_expense WHERE rowid IN (
    SELECT p.rowid FROM tally_expense p WHERE p.group_id = new.group_id);
  INSERT INTO fts_tally_expense(rowid, expense_id, description, category, group_name, items, memo)
    SELECT p.rowid,
           p.expense_id,
           p.description,
           CASE WHEN p.category = 'general' THEN NULL ELSE p.category END,
           c.name,
           (SELECT group_concat(li.description, ' ')
              FROM tally_expense_line_item li WHERE li.expense_id = p.expense_id),
           (SELECT group_concat(an.body_text, ' ') FROM knowledge_annotation an
             WHERE an.target_type = 'tally.expense' AND an.target_id = p.expense_id)
      FROM tally_expense p
      LEFT JOIN tally_group g ON g.group_id = p.group_id
      LEFT JOIN social_circle c ON c.circle_id = g.circle_id
     WHERE p.group_id = new.group_id
       AND p.deleted_at IS NULL;
END;

-- 6. Containers (R5): the four indexes the door's second registry reads.
--
-- `fts_core_collection` is untouched (see R5); its vocabulary is created below.
-- The other three are dropped and created again with the same columns they had,
-- so the baseline's unconditional triggers can give way to guarded ones, and are
-- filled from the live rows with the SELECT their triggers run.

-- 6a. A project, while it is not archived.

DROP TABLE IF EXISTS fts_schedule_project_vocab;
DROP TRIGGER IF EXISTS fts_schedule_project_ai;
DROP TRIGGER IF EXISTS fts_schedule_project_au;
DROP TRIGGER IF EXISTS fts_schedule_project_ad;
DROP TABLE IF EXISTS fts_schedule_project;

CREATE VIRTUAL TABLE fts_schedule_project USING fts5(
  project_id UNINDEXED, name,
  tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO fts_schedule_project(rowid, project_id, name)
  SELECT p.rowid, p.project_id, p.name
    FROM schedule_project p
   WHERE p.archived_at IS NULL;

CREATE TRIGGER fts_schedule_project_ad
  AFTER DELETE ON schedule_project
BEGIN
  DELETE FROM fts_schedule_project WHERE rowid = old.rowid;
END;

CREATE TRIGGER fts_schedule_project_ai
  AFTER INSERT ON schedule_project
BEGIN
  INSERT INTO fts_schedule_project(rowid, project_id, name)
    SELECT new.rowid, new.project_id, new.name
     WHERE new.archived_at IS NULL;
END;

CREATE TRIGGER fts_schedule_project_au
  AFTER UPDATE ON schedule_project
BEGIN
  DELETE FROM fts_schedule_project WHERE rowid = old.rowid;
  INSERT INTO fts_schedule_project(rowid, project_id, name)
    SELECT new.rowid, new.project_id, new.name
     WHERE new.archived_at IS NULL;
END;

-- 6b. A circle that a live Tally group stands on.

DROP TABLE IF EXISTS fts_social_circle_vocab;
DROP TRIGGER IF EXISTS fts_social_circle_ai;
DROP TRIGGER IF EXISTS fts_social_circle_au;
DROP TRIGGER IF EXISTS fts_social_circle_ad;
DROP TRIGGER IF EXISTS fts_social_circle_from_tally_group_ai;
DROP TRIGGER IF EXISTS fts_social_circle_from_tally_group_au;
DROP TRIGGER IF EXISTS fts_social_circle_from_tally_group_ad;
DROP TABLE IF EXISTS fts_social_circle;

CREATE VIRTUAL TABLE fts_social_circle USING fts5(
  circle_id UNINDEXED, name,
  tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO fts_social_circle(rowid, circle_id, name)
  SELECT c.rowid, c.circle_id, c.name
    FROM social_circle c
   WHERE EXISTS (SELECT 1 FROM tally_group g
                  WHERE g.circle_id = c.circle_id AND g.archived_at IS NULL);

CREATE TRIGGER fts_social_circle_ad
  AFTER DELETE ON social_circle
BEGIN
  DELETE FROM fts_social_circle WHERE rowid = old.rowid;
END;

CREATE TRIGGER fts_social_circle_ai
  AFTER INSERT ON social_circle
BEGIN
  INSERT INTO fts_social_circle(rowid, circle_id, name)
    SELECT new.rowid, new.circle_id, new.name
     WHERE EXISTS (SELECT 1 FROM tally_group g
                    WHERE g.circle_id = new.circle_id AND g.archived_at IS NULL);
END;

CREATE TRIGGER fts_social_circle_au
  AFTER UPDATE ON social_circle
BEGIN
  DELETE FROM fts_social_circle WHERE rowid = old.rowid;
  INSERT INTO fts_social_circle(rowid, circle_id, name)
    SELECT new.rowid, new.circle_id, new.name
     WHERE EXISTS (SELECT 1 FROM tally_group g
                    WHERE g.circle_id = new.circle_id AND g.archived_at IS NULL);
END;

-- A group is made AFTER its circle, archived and restored by `archived_at`, and
-- deleted before its circle; each re-indexes the circle it stands on. An update
-- of `circle_id` re-indexes both the circle it left and the one it reached.

CREATE TRIGGER fts_social_circle_from_tally_group_ai
  AFTER INSERT ON tally_group
BEGIN
  DELETE FROM fts_social_circle WHERE rowid IN (
    SELECT c.rowid FROM social_circle c WHERE c.circle_id = new.circle_id);
  INSERT INTO fts_social_circle(rowid, circle_id, name)
    SELECT c.rowid, c.circle_id, c.name
      FROM social_circle c
     WHERE c.circle_id = new.circle_id
       AND EXISTS (SELECT 1 FROM tally_group g
                    WHERE g.circle_id = c.circle_id AND g.archived_at IS NULL);
END;

CREATE TRIGGER fts_social_circle_from_tally_group_au
  AFTER UPDATE OF circle_id, archived_at ON tally_group
BEGIN
  DELETE FROM fts_social_circle WHERE rowid IN (
    SELECT c.rowid FROM social_circle c
     WHERE c.circle_id IN (old.circle_id, new.circle_id));
  INSERT INTO fts_social_circle(rowid, circle_id, name)
    SELECT c.rowid, c.circle_id, c.name
      FROM social_circle c
     WHERE c.circle_id IN (old.circle_id, new.circle_id)
       AND EXISTS (SELECT 1 FROM tally_group g
                    WHERE g.circle_id = c.circle_id AND g.archived_at IS NULL);
END;

CREATE TRIGGER fts_social_circle_from_tally_group_ad
  AFTER DELETE ON tally_group
BEGIN
  DELETE FROM fts_social_circle WHERE rowid IN (
    SELECT c.rowid FROM social_circle c WHERE c.circle_id = old.circle_id);
  INSERT INTO fts_social_circle(rowid, circle_id, name)
    SELECT c.rowid, c.circle_id, c.name
      FROM social_circle c
     WHERE c.circle_id = old.circle_id
       AND EXISTS (SELECT 1 FROM tally_group g
                    WHERE g.circle_id = c.circle_id AND g.archived_at IS NULL);
END;

-- 6c. A Docs folder: a concept of the folders scheme that is not the root.
-- `https://centraid.dev/schemes/folders` is `FOLDER_SCHEME_URI` in
-- `crates/vault/src/commands/core.rs`, and `root` its `ROOT_FOLDER_NOTATION`.

DROP TABLE IF EXISTS fts_core_concept_vocab;
DROP TRIGGER IF EXISTS fts_core_concept_ai;
DROP TRIGGER IF EXISTS fts_core_concept_au;
DROP TRIGGER IF EXISTS fts_core_concept_ad;
DROP TRIGGER IF EXISTS fts_core_concept_from_core_concept_scheme_au;
DROP TABLE IF EXISTS fts_core_concept;

CREATE VIRTUAL TABLE fts_core_concept USING fts5(
  concept_id UNINDEXED, pref_label,
  tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO fts_core_concept(rowid, concept_id, pref_label)
  SELECT c.rowid, c.concept_id, c.pref_label
    FROM core_concept c
    JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
   WHERE s.uri = 'https://centraid.dev/schemes/folders'
     AND c.notation <> 'root';

CREATE TRIGGER fts_core_concept_ad
  AFTER DELETE ON core_concept
BEGIN
  DELETE FROM fts_core_concept WHERE rowid = old.rowid;
END;

CREATE TRIGGER fts_core_concept_ai
  AFTER INSERT ON core_concept
BEGIN
  INSERT INTO fts_core_concept(rowid, concept_id, pref_label)
    SELECT new.rowid, new.concept_id, new.pref_label
     WHERE new.notation <> 'root'
       AND EXISTS (SELECT 1 FROM core_concept_scheme s
                    WHERE s.scheme_id = new.scheme_id
                      AND s.uri = 'https://centraid.dev/schemes/folders');
END;

CREATE TRIGGER fts_core_concept_au
  AFTER UPDATE ON core_concept
BEGIN
  DELETE FROM fts_core_concept WHERE rowid = old.rowid;
  INSERT INTO fts_core_concept(rowid, concept_id, pref_label)
    SELECT new.rowid, new.concept_id, new.pref_label
     WHERE new.notation <> 'root'
       AND EXISTS (SELECT 1 FROM core_concept_scheme s
                    WHERE s.scheme_id = new.scheme_id
                      AND s.uri = 'https://centraid.dev/schemes/folders');
END;

-- A scheme whose URI changes moves every concept of it in or out of the folders.

CREATE TRIGGER fts_core_concept_from_core_concept_scheme_au
  AFTER UPDATE OF uri ON core_concept_scheme
BEGIN
  DELETE FROM fts_core_concept WHERE rowid IN (
    SELECT c.rowid FROM core_concept c WHERE c.scheme_id = new.scheme_id);
  INSERT INTO fts_core_concept(rowid, concept_id, pref_label)
    SELECT c.rowid, c.concept_id, c.pref_label
      FROM core_concept c
     WHERE c.scheme_id = new.scheme_id
       AND c.notation <> 'root'
       AND new.uri = 'https://centraid.dev/schemes/folders';
END;

-- 7. Chat (R6): one row per thread, its title and what the member said.

DROP TABLE IF EXISTS fts_chat_thread_vocab;
DROP TRIGGER IF EXISTS fts_chat_thread_ai;
DROP TRIGGER IF EXISTS fts_chat_thread_au;
DROP TRIGGER IF EXISTS fts_chat_thread_ad;
DROP TRIGGER IF EXISTS fts_chat_thread_from_chat_message_ai;
DROP TRIGGER IF EXISTS fts_chat_thread_from_chat_message_au;
DROP TRIGGER IF EXISTS fts_chat_thread_from_chat_message_ad;
DROP TABLE IF EXISTS fts_chat_thread;

CREATE VIRTUAL TABLE fts_chat_thread USING fts5(
  thread_id UNINDEXED, title, said,
  tokenize = "unicode61 remove_diacritics 2"
);

INSERT INTO fts_chat_thread(rowid, thread_id, title, said)
  SELECT p.rowid, p.thread_id, p.title,
         CASE WHEN s.said IS NULL THEN NULL
              WHEN length(s.said) > 262144
              THEN substr(s.said, 1, 262144) || ' ...(truncated for search index)'
              ELSE s.said END
    FROM chat_thread p
    LEFT JOIN (SELECT u.thread_id AS thread_id, group_concat(u.text, ' ') AS said
                 FROM (SELECT m.thread_id, m.text FROM chat_message m
                        WHERE m.role = 'user'
                        ORDER BY m.thread_id, m.ordinal) u
                GROUP BY u.thread_id) s ON s.thread_id = p.thread_id;

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

-- Only a new title (or id) re-indexes: `chat_thread_touch_updated_at` rewrites
-- `updated_at` and `row_version` on every activity, and those are in no column.
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

-- The member's messages only: an assistant message, whatever it says and
-- whatever settles it, is in no index (R6).
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

-- 8. The vocabulary of each domain, each container and the chat index (R3, R5, R6).

DROP TABLE IF EXISTS fts_knowledge_note_vocab;
CREATE VIRTUAL TABLE fts_knowledge_note_vocab USING fts5vocab(fts_knowledge_note, 'row');

DROP TABLE IF EXISTS fts_core_party_vocab;
CREATE VIRTUAL TABLE fts_core_party_vocab USING fts5vocab(fts_core_party, 'row');

DROP TABLE IF EXISTS fts_core_event_vocab;
CREATE VIRTUAL TABLE fts_core_event_vocab USING fts5vocab(fts_core_event, 'row');

DROP TABLE IF EXISTS fts_schedule_task_vocab;
CREATE VIRTUAL TABLE fts_schedule_task_vocab USING fts5vocab(fts_schedule_task, 'row');

DROP TABLE IF EXISTS fts_tally_expense_vocab;
CREATE VIRTUAL TABLE fts_tally_expense_vocab USING fts5vocab(fts_tally_expense, 'row');

DROP TABLE IF EXISTS fts_core_content_item_vocab;
CREATE VIRTUAL TABLE fts_core_content_item_vocab USING fts5vocab(fts_core_content_item, 'row');

DROP TABLE IF EXISTS fts_core_document_vocab;
CREATE VIRTUAL TABLE fts_core_document_vocab USING fts5vocab(fts_core_document, 'row');

DROP TABLE IF EXISTS fts_core_collection_vocab;
CREATE VIRTUAL TABLE fts_core_collection_vocab USING fts5vocab(fts_core_collection, 'row');

DROP TABLE IF EXISTS fts_schedule_project_vocab;
CREATE VIRTUAL TABLE fts_schedule_project_vocab USING fts5vocab(fts_schedule_project, 'row');

DROP TABLE IF EXISTS fts_social_circle_vocab;
CREATE VIRTUAL TABLE fts_social_circle_vocab USING fts5vocab(fts_social_circle, 'row');

DROP TABLE IF EXISTS fts_core_concept_vocab;
CREATE VIRTUAL TABLE fts_core_concept_vocab USING fts5vocab(fts_core_concept, 'row');

DROP TABLE IF EXISTS fts_chat_thread_vocab;
CREATE VIRTUAL TABLE fts_chat_thread_vocab USING fts5vocab(fts_chat_thread, 'row');
