import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export const TIME_ORGANIZE_DDL = `
-- \`core_event.end_tz\` and \`.recurrence_semantics\` moved into CORE_DDL
-- (#916): core_event's semantics CHECKs name them, and a CHECK cannot
-- reference a column a later ALTER adds.

CREATE TABLE schedule_project (
  project_id     TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  area           TEXT,
  color          TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  archived_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (project_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE schedule_section (
  section_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES schedule_project(project_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (section_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

-- SET NULL, not the silent dangle the columns shipped with (#916): retiring a
-- project or a section does not delete the tasks that sat in it.
ALTER TABLE schedule_task ADD COLUMN project_id TEXT
  REFERENCES schedule_project(project_id) ON DELETE SET NULL;
ALTER TABLE schedule_task ADD COLUMN section_id TEXT
  REFERENCES schedule_section(section_id) ON DELETE SET NULL;
ALTER TABLE schedule_task ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedule_task ADD COLUMN recurrence_anchor TEXT NOT NULL DEFAULT 'scheduled'
  CHECK (recurrence_anchor IN ('scheduled','completion'));
-- ONE NAME FOR A ZONE (#916, R4 / review 3.4). The vault spelled the same
-- column four ways: \`core_place.tz\`, \`core_event.start_tz\`/\`end_tz\`,
-- \`schedule_task.recurrence_tz\` and \`tally_recurring_expense.time_zone\`. A
-- table with ONE zone calls it \`tz\`; \`core_event\` keeps a pair because two
-- zones are a real thing an event can have.
ALTER TABLE schedule_task ADD COLUMN tz TEXT;

CREATE INDEX schedule_project_owner_idx
  ON schedule_project(owner_party_id, archived_at, sort_order);
CREATE INDEX schedule_section_project_idx
  ON schedule_section(project_id, sort_order);
CREATE INDEX schedule_task_organize_idx
  ON schedule_task(project_id, section_id, sort_order);
CREATE INDEX schedule_task_section_idx
  ON schedule_task(section_id);
-- #916, R12 / review 10.3: the due-reminder sweep reads tasks by due date.
CREATE INDEX schedule_task_due_at_idx ON schedule_task(due_at) WHERE due_at IS NOT NULL;

-- THE KEY IS THE SERIES-LOCAL WALL CLOCK (#916, R5 / review 3.1).
--
-- The exception used to be keyed on the RESOLVED UTC instant of the occurrence
-- it excepts. That made the key a function of the series' anchor and zone
-- rather than of the occurrence, so editing the series (\`schedule.
-- edit_event_occurrence\` with scope 'series' moves \`dtstart\`) silently
-- orphaned every exception on it — the skips stopped matching and the skipped
-- occurrences came back. A recurrence rule expands in WALL CLOCK, so the
-- occurrence's own identity is its wall-clock start, and \`recurrence_semantics\`
-- records which reading that wall clock is under. Both travel with the series.
CREATE TABLE schedule_recurrence_exception (
  exception_id  TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL CHECK (target_type IN ('core.event','tally.recurring_expense')),
  target_id     TEXT NOT NULL,
  -- The series-local wall clock of the occurrence, in the series' own zone —
  -- never a UTC instant, and never suffixed 'Z' unless the series is itself
  -- UTC.
  original_start_local TEXT NOT NULL,
  -- The series' reading of that wall clock, copied at write time so the
  -- exception can be matched without re-reading the series.
  recurrence_semantics TEXT NOT NULL
    CHECK (recurrence_semantics IN ('zoned','floating','all-day')),
  scope         TEXT NOT NULL DEFAULT 'occurrence'
    CHECK (scope IN ('occurrence','future')),
  action        TEXT NOT NULL CHECK (action IN ('skip','override')),
  -- A shadow event is DELIBERATELY one row: start, end, summary and reminders
  -- are the overriding occurrence's own values and have no life apart from it.
  -- \`attendee_party_ids\` left this JSON under #916 (R6 / review 10.4) —
  -- party ids inside a JSON blob are invisible to identity merge and to the
  -- purge cascade, so they are rows in
  -- \`schedule_recurrence_exception_attendee\` below.
  override_json TEXT CHECK (
    (action = 'skip' AND override_json IS NULL)
    OR (action = 'override' AND override_json IS NOT NULL AND json_valid(override_json))
  ),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  UNIQUE (target_type, target_id, original_start_local, scope),
  FOREIGN KEY (exception_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE,
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX schedule_recurrence_exception_target_idx
  ON schedule_recurrence_exception(target_type, target_id, original_start_local);

CREATE TABLE schedule_recurrence_exception_attendee (
  exception_id TEXT NOT NULL
    REFERENCES schedule_recurrence_exception(exception_id) ON DELETE CASCADE,
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  created_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  PRIMARY KEY (exception_id, party_id)
) STRICT;
CREATE INDEX schedule_recurrence_exception_attendee_party_idx
  ON schedule_recurrence_exception_attendee(party_id);

CREATE TABLE social_contact_channel (
  channel_id       TEXT PRIMARY KEY,
  party_id         TEXT NOT NULL REFERENCES core_party(party_id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('phone','email','address','handle')),
  label            TEXT,
  value            TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  is_preferred     INTEGER NOT NULL DEFAULT 0 CHECK (is_preferred IN (0,1)),
  provenance_json  TEXT CHECK (provenance_json IS NULL OR json_valid(provenance_json)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  UNIQUE (party_id, kind, normalized_value),
  FOREIGN KEY (channel_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX social_contact_channel_party_idx
  ON social_contact_channel(party_id, kind, is_preferred DESC);
CREATE INDEX social_contact_channel_duplicate_idx
  ON social_contact_channel(kind, normalized_value, party_id);
CREATE UNIQUE INDEX social_contact_channel_preferred_idx
  ON social_contact_channel(party_id, kind) WHERE is_preferred = 1;

ALTER TABLE tally_expense ADD COLUMN original_amount_minor INTEGER
  CHECK (original_amount_minor IS NULL OR original_amount_minor > 0);
ALTER TABLE tally_expense ADD COLUMN original_currency TEXT
  CHECK (original_currency IS NULL OR length(original_currency) = 3);
ALTER TABLE tally_expense ADD COLUMN settlement_currency TEXT
  CHECK (settlement_currency IS NULL OR length(settlement_currency) = 3);
ALTER TABLE tally_expense ADD COLUMN rate_scaled INTEGER
  CHECK (rate_scaled IS NULL OR rate_scaled > 0);
ALTER TABLE tally_expense ADD COLUMN rate_scale INTEGER
  CHECK (rate_scale IS NULL OR rate_scale BETWEEN 0 AND 12);
ALTER TABLE tally_expense ADD COLUMN rate_source TEXT;
ALTER TABLE tally_expense ADD COLUMN rate_date TEXT;

CREATE TABLE tally_recurring_expense (
  template_id           TEXT PRIMARY KEY,
  group_id              TEXT NOT NULL
    REFERENCES tally_group(group_id) ON DELETE CASCADE,
  description           TEXT NOT NULL,
  original_amount_minor INTEGER NOT NULL CHECK (original_amount_minor > 0),
  original_currency     TEXT NOT NULL CHECK (length(original_currency) = 3),
  settlement_currency   TEXT NOT NULL CHECK (length(settlement_currency) = 3),
  paid_by               TEXT NOT NULL REFERENCES core_party(party_id),
  category              TEXT NOT NULL,
  -- The split is ROWS (#916, owner decision D3), in
  -- \`tally_recurring_expense_split\` below. It used to be a JSON array of
  -- {party_id, share} objects, which put party ids somewhere identity merge
  -- could not see them, the purge cascade could not reach them, and no CHECK
  -- could hold their shares to the template's amount.
  rrule                 TEXT NOT NULL,
  anchor_start          TEXT NOT NULL,
  -- \`tz\`, not \`time_zone\` (#916, R4): one name for a zone column.
  tz                    TEXT NOT NULL,
  rate_scaled           INTEGER CHECK (rate_scaled IS NULL OR rate_scaled > 0),
  rate_scale            INTEGER CHECK (rate_scale IS NULL OR rate_scale BETWEEN 0 AND 12),
  rate_source           TEXT,
  rate_date             TEXT,
  status                TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','ended')),
  last_materialized_start TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (template_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
-- Mirrors \`tally_expense_split\` column for column, because it is the same
-- fact about a template rather than an expense: who owes what, in minor units,
-- keyed by (template, party). The template key cascades — a template's splits
-- die with it — and the party key does NOT: a share is money, so it REFUSES
-- the purge of the person who owes it until the member settles or removes it
-- (#916, D1; the same reading \`tally_expense_split\` has always had).
CREATE TABLE tally_recurring_expense_split (
  template_id  TEXT NOT NULL
    REFERENCES tally_recurring_expense(template_id) ON DELETE CASCADE,
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  share_minor  INTEGER NOT NULL CHECK (share_minor >= 0),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (template_id, party_id)
) STRICT;
CREATE INDEX tally_recurring_expense_split_party_idx
  ON tally_recurring_expense_split(party_id);

CREATE INDEX tally_recurring_expense_group_idx
  ON tally_recurring_expense(group_id, status, anchor_start);
CREATE INDEX tally_recurring_expense_paid_by_idx
  ON tally_recurring_expense(paid_by);
-- After the template table exists, because it is a REFERENCE now (#916, R2 /
-- review 10.2): the column named a template with nothing checking it and no
-- index to find the instances by, so a deleted template left its materialized
-- expenses pointing at a row that was not there. SET NULL rather than CASCADE
-- — an expense that already happened is not undone by retiring its template.
ALTER TABLE tally_expense ADD COLUMN recurring_template_id TEXT
  REFERENCES tally_recurring_expense(template_id) ON DELETE SET NULL;
CREATE UNIQUE INDEX tally_expense_recurring_instance_idx
  ON tally_expense(recurring_template_id, spent_on)
  WHERE recurring_template_id IS NOT NULL;

${touchUpdatedAt("schedule_project", "project_id")}
${touchUpdatedAt("schedule_section", "section_id")}
${touchUpdatedAt("schedule_recurrence_exception", "exception_id")}
${touchUpdatedAt("social_contact_channel", "channel_id")}
${touchUpdatedAt("tally_recurring_expense", "template_id")}
${touchUpdatedAt("tally_recurring_expense_split", ["template_id", "party_id"])}
${touchUpdatedAt("schedule_recurrence_exception_attendee", ["exception_id", "party_id"])}
`;
