-- SEARCH FINDS WHAT A MEMBER TYPED — RUNG THIRTEEN (#1097, R1, R1a, R1b, R1c, R1d, R2a, R3).
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
-- read, so one probe per domain still answers (Home stays at seven), and it
-- retires the indexes nothing reads whose text is now folded in.
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
--                                             written by `people.add_note`)
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
-- that memo reaches no index and no vocabulary. `fts_locker_item` is untouched.
--
-- ## R2a — what is retired
--
-- Five indexes had writers and no reader (`rg -l "fts_<name>\b" --glob '!*.sql'`
-- finds nothing for any of them), and the text of each is folded above:
-- `fts_people_profile`, `fts_core_place`, `fts_schedule_project`,
-- `fts_social_circle` and `fts_knowledge_annotation`, with their fifteen
-- triggers. `fts_core_collection`, `fts_core_transaction`, `fts_social_thread`,
-- `fts_social_message` and `fts_locker_item` stay as they were: containers,
-- chat history and Locker are not domains yet.
--
-- ## R3 — a vocabulary for each domain
--
-- `fts_<index>_vocab`, an `fts5vocab(<index>, 'row')` table, for the seven
-- domain indexes and never for Locker. It lists every term with the number of
-- rows it is in (`term`, `doc`, `cnt`), which is what a correction pass reads
-- to find the word a member meant. It is a persistent table because the read
-- connection is `query_only` and a temp table needs a write. The name is not an
-- FTS5 shadow name (`_config`, `_content`, `_data`, `_docsize`, `_idx`), which
-- is what `log::guard::is_reportable` and the contract vault's `is_fts_shadow`
-- key on; a vocab table is a virtual table, so the snapshot's table census
-- leaves it out. A RUNG THAT REBUILDS A DOMAIN INDEX MUST DROP ITS `_vocab`
-- FIRST and create it again after.
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

DROP TRIGGER IF EXISTS fts_schedule_project_ai;
DROP TRIGGER IF EXISTS fts_schedule_project_au;
DROP TRIGGER IF EXISTS fts_schedule_project_ad;
DROP TABLE IF EXISTS fts_schedule_project;

DROP TRIGGER IF EXISTS fts_social_circle_ai;
DROP TRIGGER IF EXISTS fts_social_circle_au;
DROP TRIGGER IF EXISTS fts_social_circle_ad;
DROP TABLE IF EXISTS fts_social_circle;

DROP TRIGGER IF EXISTS fts_knowledge_annotation_ai;
DROP TRIGGER IF EXISTS fts_knowledge_annotation_au;
DROP TRIGGER IF EXISTS fts_knowledge_annotation_ad;
DROP TABLE IF EXISTS fts_knowledge_annotation;

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
           WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = old.party_id
       AND old.party_id IS NOT new.party_id;
END;

DROP TRIGGER IF EXISTS fts_core_party_from_knowledge_annotation_ad;
CREATE TRIGGER fts_core_party_from_knowledge_annotation_ad
  AFTER DELETE ON knowledge_annotation
  WHEN old.target_type = 'core.party'
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = old.target_id
         AND old.target_type = 'core.party');
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = old.target_id
       AND old.target_type = 'core.party';
END;

DROP TRIGGER IF EXISTS fts_core_party_from_knowledge_annotation_ai;
CREATE TRIGGER fts_core_party_from_knowledge_annotation_ai
  AFTER INSERT ON knowledge_annotation
  WHEN new.target_type = 'core.party'
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = new.target_id
         AND new.target_type = 'core.party');
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = new.target_id
       AND new.target_type = 'core.party';
END;

DROP TRIGGER IF EXISTS fts_core_party_from_knowledge_annotation_au;
CREATE TRIGGER fts_core_party_from_knowledge_annotation_au
  AFTER UPDATE OF target_type, target_id, body_text ON knowledge_annotation
BEGIN
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = new.target_id
         AND new.target_type = 'core.party');
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = new.target_id
       AND new.target_type = 'core.party';
  DELETE FROM fts_core_party WHERE rowid IN (
    SELECT p.rowid FROM core_party p WHERE p.party_id = old.target_id
         AND old.target_type = 'core.party'
         AND (old.target_type IS NOT new.target_type OR old.target_id IS NOT new.target_id));
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
             WHERE an.target_type = 'core.party' AND an.target_id = p.party_id)
      FROM core_party p
      LEFT JOIN people_profile pp ON pp.party_id = p.party_id AND pp.deleted_at IS NULL
     WHERE p.party_id = old.target_id
       AND old.target_type = 'core.party'
       AND (old.target_type IS NOT new.target_type OR old.target_id IS NOT new.target_id);
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

-- 6. The vocabulary of each domain (R3).

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
