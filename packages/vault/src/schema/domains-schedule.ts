import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export const SCHEDULE_DDL = `
CREATE TABLE schedule_calendar (
  calendar_id    TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  color          TEXT,
  default_tz     TEXT NOT NULL,
  visibility     TEXT NOT NULL CHECK (visibility IN ('private','shared','public')),
  external_uri   TEXT,
  created_at     TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (calendar_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_calendar_owner_party ON schedule_calendar(owner_party_id);

CREATE TABLE schedule_event_ext (
  event_ext_id      TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL UNIQUE REFERENCES core_event(event_id),
  calendar_id       TEXT NOT NULL REFERENCES schedule_calendar(calendar_id),
  busy              TEXT NOT NULL CHECK (busy IN ('busy','free')),
  conferencing_uri  TEXT,
  reminders_json    TEXT CHECK (reminders_json IS NULL OR json_valid(reminders_json)),
  travel_buffer_min INTEGER CHECK (travel_buffer_min >= 0),
  created_at        TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at        TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (event_ext_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_event_ext_calendar ON schedule_event_ext(calendar_id);

CREATE TABLE schedule_attendee (
  attendee_id  TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES core_event(event_id),
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  role         TEXT NOT NULL CHECK (role IN ('chair','required','optional')),
  partstat     TEXT NOT NULL CHECK (partstat IN ('needs-action','accepted','declined','tentative')),
  responded_at TEXT,
  created_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  UNIQUE (event_id, party_id),
  FOREIGN KEY (attendee_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_attendee_party ON schedule_attendee(party_id);

-- iCalendar carries an ORGANIZER property separately from attendee roles, so
-- both encodings stay. The invariant is directional (issue #450): a chair,
-- when present, is the organizer; an organizer need not be duplicated as an
-- attendee because imported calendars often omit that self-entry.
CREATE TRIGGER schedule_chair_matches_organizer_insert
BEFORE INSERT ON schedule_attendee
WHEN NEW.role = 'chair' AND NOT EXISTS (
  SELECT 1 FROM core_event e
   WHERE e.event_id = NEW.event_id
     AND e.organizer_party_id = NEW.party_id
)
BEGIN
  SELECT RAISE(ABORT, 'chair attendee must match the event organizer');
END;
CREATE TRIGGER schedule_chair_matches_organizer_update
BEFORE UPDATE OF event_id, party_id, role ON schedule_attendee
WHEN NEW.role = 'chair' AND NOT EXISTS (
  SELECT 1 FROM core_event e
   WHERE e.event_id = NEW.event_id
     AND e.organizer_party_id = NEW.party_id
)
BEGIN
  SELECT RAISE(ABORT, 'chair attendee must match the event organizer');
END;
CREATE TRIGGER schedule_organizer_matches_chair_update
BEFORE UPDATE OF organizer_party_id ON core_event
WHEN EXISTS (
  SELECT 1 FROM schedule_attendee a
   WHERE a.event_id = OLD.event_id
     AND a.role = 'chair'
     AND a.party_id IS NOT NEW.organizer_party_id
)
BEGIN
  SELECT RAISE(ABORT, 'event organizer must match its chair attendee');
END;

CREATE TABLE schedule_task (
  task_id        TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  title          TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('needs-action','in-process','completed','cancelled')),
  priority       INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 9),
  due_at         TEXT,
  completed_at   TEXT,
  effort_min     INTEGER CHECK (effort_min > 0),
  parent_task_id TEXT REFERENCES schedule_task(task_id),
  rrule          TEXT,
  remind_before_min INTEGER CHECK (remind_before_min >= 0),
  -- The trash pair (#883, ruling O-trash): a task the member deleted leaves
  -- every surface at once, search included (#916, R11).
  deleted_at     TEXT,
  purge_at       TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  created_at     TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at     TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (task_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_task_owner_party ON schedule_task(owner_party_id);
CREATE INDEX IF NOT EXISTS idx_task_purge_at ON schedule_task(purge_at);
CREATE INDEX IF NOT EXISTS idx_task_parent_task ON schedule_task(parent_task_id);

${touchUpdatedAt("schedule_event_ext", "event_ext_id")}
${touchUpdatedAt("schedule_attendee", "attendee_id")}
${touchUpdatedAt("schedule_task", "task_id")}
`;
