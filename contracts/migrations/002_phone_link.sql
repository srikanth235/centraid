-- RUNG TWO of the vault's ladder: the phone link (#1127, R-1127-1 to R-1127-3, R-1127-7).
--
-- People, Agenda and Docs follow what the phone holds: a contact, a calendar event and a file in a
-- folder the member picked arrive as an ordinary person, event or document. This table records
-- WHICH PHONE RECORD each such row came from, so a later pass can find the row again, tell that the
-- phone record changed or went away, and tell that the member edited the row and it stopped
-- following (R-1127-2: detached by fingerprint, never by an edit command).
--
-- ONE ROW PER FOLLOWED ROW. The core's sync engine is the only writer (`phone.link`,
-- `phone.detach`, `phone.forget`); the shell's engine pages the rows back through the page door.
--
--   source        which phone store: contacts -> a party, calendar -> an event, files -> a
--                 document. Photos is not a source here (R-1127-4): the vault is a photograph's
--                 backup and never mirrors its delete.
--   phone_id      the phone store's own id for the record, opaque to the vault.
--   entity_id     the vault row it became. A REAL FOREIGN KEY to `core_entity`, not a
--                 (type, id) pair SQLite cannot see (#916, D-1020-DC6): a purged row takes its
--                 link with it, and `phone_link_kind_matches_source` holds that the entity is the
--                 kind the source implies, which no command can be bypassed around.
--   fingerprint   an opaque digest of the phone-owned fields the engine last WROTE. A row whose
--                 fields no longer match it was edited in Centraid.
--   detached_at   NULL while the row follows the phone; set ONCE, when it stopped.
--   last_seen_at  when a pass last found the phone record.
--
-- Not an entity kind: the table keys into `core_entity` on `entity_id`, not on its own primary
-- key, so `seed_entity_kinds` does not register it. A link is machinery about a row, not a thing
-- a member names.

-- table phone_link
CREATE TABLE phone_link (
  link_id      TEXT PRIMARY KEY,
  source       TEXT NOT NULL CHECK (source IN ('contacts', 'calendar', 'files')),
  phone_id     TEXT NOT NULL CHECK (length(trim(phone_id)) > 0),
  entity_id    TEXT NOT NULL REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL CHECK (length(fingerprint) > 0),
  detached_at  TEXT,
  last_seen_at TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version  INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  UNIQUE (source, phone_id),
  UNIQUE (entity_id)
) STRICT;

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
                          END);
END;

-- trigger phone_link_kind_matches_source_update
CREATE TRIGGER phone_link_kind_matches_source_update
BEFORE UPDATE OF source, entity_id ON phone_link
BEGIN
  SELECT RAISE(ABORT, 'a phone link points at the kind its source implies: phone_link (#1127)')
   WHERE NOT EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.entity_id
        AND entity_type = CASE NEW.source
                            WHEN 'contacts' THEN 'core.party'
                            WHEN 'calendar' THEN 'core.event'
                            WHEN 'files'    THEN 'core.document'
                          END);
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
