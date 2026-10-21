-- RUNG TWO of the vault's ladder: the phone link (#1127, R-1127-1 to R-1127-3, R-1127-7).
--
-- People, Agenda, Docs and Health follow what the phone holds: a contact, a calendar event, a file
-- in a folder the member picked and a workout in the health store arrive as an ordinary person,
-- event, document or activity. AMENDED IN PLACE before any release to admit the fourth source,
-- `health` (#1129, R-1129-1), and again to give a link and an origin the device that made them
-- (#1129, F-K-1): the rung lives only on unreleased builds. This table records
-- WHICH PHONE RECORD each such row came from, so a later pass can find the row again, tell that the
-- phone record changed or went away, and tell that the member edited the row and it stopped
-- following (R-1127-2: detached by fingerprint, never by an edit command).
--
-- ONE ROW PER FOLLOWED ROW (or its tombstone). The core's sync engine is the only writer (`phone.link`,
-- `phone.relink`, `phone.detach`, `phone.forget`); the shell's engine pages the rows back through the
-- page door.
--
--   source        which phone store: contacts -> a party, calendar -> an event, files -> a
--                 document, health -> an activity (a workout, #1129, R-1129-2; a health store's
--                 daily totals carry no identity and are not linked, R-1129-3). Photos is not a
--                 source here (R-1127-4): the vault is a photograph's backup and never mirrors
--                 its delete.
--   phone_id      the phone store's own id for the record, opaque to the vault.
--   device_id     WHICH PHONE MADE THE LINK, for an id that means something on one device only
--                 (R-1127-10's `local:`: an iOS contact identifier, an Android `CONTACT_ID`, a
--                 followed file's path, a health store's workout id), and NULL for an id that names
--                 the same record on every device (`uid:`, `lookup:`). The phone mints it once per
--                 install and keeps it out of every backup, so a vault restored onto a new phone
--                 holds the old phone's links under the old phone's id: the new phone re-finds
--                 them by match and never reads their absence as a delete (F-K-1). A record is
--                 `(source, phone_id)` among device-independent links and `(source, device_id,
--                 phone_id)` among the rest: two phones may both have a contact `local:42`, and
--                 they are two people.
--   origin_id     the phone account, calendar, picked folder or health store the record came
--                 from, as a row of `phone_origin` (R-1127-9). A REAL FOREIGN KEY, so an origin
--                 that still has links cannot be deleted; the pair `(origin_id, source)` is the
--                 key, so a link's origin is always of its own source.
--   entity_id     the vault row it became. A REAL FOREIGN KEY to `core_entity`, not a
--                 (type, id) pair SQLite cannot see (#916, D-1020-DC6), and `ON DELETE SET NULL`:
--                 a purged row leaves its link behind with a NULL entity, which is the
--                 TOMBSTONE that keeps the phone record from arriving a second time (a member who
--                 deleted a person forever does not want the next pass to bring them back).
--                 `phone_link_kind_matches_source` holds that a live entity is the kind the
--                 source implies, which no command can be bypassed around, and
--                 `phone_link_purge_is_one_way` that a tombstone is never given a row again.
--                 The engine forgets a tombstone once the phone record is gone too.
--   fingerprint   an opaque digest of the phone-owned fields the engine last WROTE. A row whose
--                 fields no longer match it was edited in Centraid.
--   detached_at   NULL while the row follows the phone; set ONCE, when it stopped.
--   last_seen_at  when a pass last found the phone record.
--
-- ONE ROW PER ORIGIN, in `phone_origin` (R-1127-9). A Google account removed from the phone, a
-- calendar turned off or a picked folder gone takes all of its records from the phone at once;
-- the engine then holds the rows and asks the member "Keep its 214 events?". The question is asked
-- AFTER the origin has left the phone, so its member-readable `label` lives here, written while the
-- origin was present and never cleared by its going. A table, not columns on every link: the label
-- is stored once (a rename is one write, not 214), and `phone_link.origin_id` is a foreign key
-- SQLite sees rather than a text copy it cannot (D-1020-DC6).
--
--   phone_origin  the phone store's own id for the account, calendar or folder; opaque to the
--                 vault, kind-prefixed by the shell (R-1127-10).
--   label         what the member calls it ("Google: ada@example.com", "Work").
--   device_id     the phone that last read it present. Only that phone may take its absence for
--                 the origin leaving: a restored vault's origins are another phone's until this
--                 one reads them, and an iOS container or calendar id, or a picked folder, means
--                 nothing on the new phone (F-K-1).

-- table phone_origin
CREATE TABLE phone_origin (
  origin_id    TEXT PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('contacts', 'calendar', 'files', 'health')),
  phone_origin TEXT NOT NULL CHECK (length(trim(phone_origin)) > 0),
  label        TEXT NOT NULL CHECK (length(trim(label)) > 0),
  device_id    TEXT NOT NULL CHECK (length(trim(device_id)) > 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version  INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (source, phone_origin),
  UNIQUE (origin_id, source)
) STRICT;

-- trigger phone_origin_touch_updated_at
CREATE TRIGGER phone_origin_touch_updated_at
AFTER UPDATE ON phone_origin
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE phone_origin
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE origin_id = NEW.origin_id;
END;

-- Neither table is an entity kind: `phone_link` keys into `core_entity` on `entity_id`, not on its
-- own primary key, so `seed_entity_kinds` does not register it, and an origin is not in
-- `core_entity` at all. A link and an origin are machinery about rows, not things a member names.

-- table phone_link
CREATE TABLE phone_link (
  link_id      TEXT PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('contacts', 'calendar', 'files', 'health')),
  phone_id     TEXT NOT NULL CHECK (length(trim(phone_id)) > 0),
  device_id    TEXT CHECK (device_id IS NULL OR length(trim(device_id)) > 0),
  origin_id    TEXT NOT NULL,
  entity_id    TEXT REFERENCES core_entity(entity_id) ON DELETE SET NULL,
  fingerprint  TEXT NOT NULL CHECK (length(fingerprint) > 0),
  detached_at  TEXT,
  last_seen_at TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version  INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (entity_id),
  FOREIGN KEY (origin_id, source) REFERENCES phone_origin (origin_id, source)
) STRICT;

-- index phone_link_record_idx
CREATE UNIQUE INDEX phone_link_record_idx
  ON phone_link(source, phone_id) WHERE device_id IS NULL;

-- index phone_link_device_record_idx
CREATE UNIQUE INDEX phone_link_device_record_idx
  ON phone_link(source, device_id, phone_id) WHERE device_id IS NOT NULL;

-- trigger phone_link_kind_matches_source
CREATE TRIGGER phone_link_kind_matches_source
BEFORE INSERT ON phone_link
BEGIN
  SELECT RAISE(ABORT, 'a phone link points at the kind its source implies: phone_link (#1127)')
   WHERE NOT EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.entity_id
        AND entity_type = CASE NEW.source
                            WHEN 'contacts' THEN 'core.party'
                            WHEN 'calendar' THEN 'core.event'
                            WHEN 'files'    THEN 'core.document'
                            WHEN 'health'   THEN 'core.activity'
                          END);
END;

-- trigger phone_link_kind_matches_source_update
CREATE TRIGGER phone_link_kind_matches_source_update
BEFORE UPDATE OF source, entity_id ON phone_link
WHEN NEW.entity_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a phone link points at the kind its source implies: phone_link (#1127)')
   WHERE NOT EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.entity_id
        AND entity_type = CASE NEW.source
                            WHEN 'contacts' THEN 'core.party'
                            WHEN 'calendar' THEN 'core.event'
                            WHEN 'files'    THEN 'core.document'
                            WHEN 'health'   THEN 'core.activity'
                          END);
END;

-- trigger phone_link_purge_is_one_way
CREATE TRIGGER phone_link_purge_is_one_way
BEFORE UPDATE OF entity_id ON phone_link
WHEN OLD.entity_id IS NULL AND NEW.entity_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'a purged phone link is never given a row again: phone_link (#1127)');
END;

-- trigger phone_link_detach_is_one_way
CREATE TRIGGER phone_link_detach_is_one_way
BEFORE UPDATE OF detached_at ON phone_link
WHEN OLD.detached_at IS NOT NULL AND NEW.detached_at IS NOT OLD.detached_at
BEGIN
  SELECT RAISE(ABORT, 'a detached phone link is never re-attached: phone_link (#1127)');
END;

-- trigger phone_link_touch_updated_at
CREATE TRIGGER phone_link_touch_updated_at
AFTER UPDATE ON phone_link
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE phone_link
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE link_id = NEW.link_id;
END;
