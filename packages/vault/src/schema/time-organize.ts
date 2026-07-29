// Issue #630 Wave 4: durable time semantics and the organizational spine.
// This is one forward-only rung because the new foreign keys and columns form
// one contract consumed together by Agenda, Tasks, People, and Tally.

export const TIME_ORGANIZE_DDL = `
ALTER TABLE core_event ADD COLUMN end_tz TEXT;
ALTER TABLE core_event ADD COLUMN recurrence_semantics TEXT NOT NULL DEFAULT 'zoned'
  CHECK (recurrence_semantics IN ('zoned','floating','all-day'));

CREATE TABLE schedule_project (
  project_id     TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  area           TEXT,
  color          TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  archived_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE TABLE schedule_section (
  section_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES schedule_project(project_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

ALTER TABLE schedule_task ADD COLUMN project_id TEXT REFERENCES schedule_project(project_id);
ALTER TABLE schedule_task ADD COLUMN section_id TEXT REFERENCES schedule_section(section_id);
ALTER TABLE schedule_task ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedule_task ADD COLUMN recurrence_anchor TEXT NOT NULL DEFAULT 'scheduled'
  CHECK (recurrence_anchor IN ('scheduled','completion'));
ALTER TABLE schedule_task ADD COLUMN recurrence_tz TEXT;

CREATE INDEX schedule_project_owner_idx
  ON schedule_project(owner_party_id, archived_at, sort_order);
CREATE INDEX schedule_section_project_idx
  ON schedule_section(project_id, sort_order);
CREATE INDEX schedule_task_organize_idx
  ON schedule_task(project_id, section_id, sort_order);
CREATE INDEX schedule_task_section_idx
  ON schedule_task(section_id);

CREATE TABLE schedule_recurrence_exception (
  exception_id  TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL CHECK (target_type IN ('core.event','tally.recurring_expense')),
  target_id     TEXT NOT NULL,
  original_start TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'occurrence'
    CHECK (scope IN ('occurrence','future')),
  action        TEXT NOT NULL CHECK (action IN ('skip','override')),
  override_json TEXT CHECK (
    (action = 'skip' AND override_json IS NULL)
    OR (action = 'override' AND override_json IS NOT NULL AND json_valid(override_json))
  ),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (target_type, target_id, original_start, scope)
) STRICT;
CREATE INDEX schedule_recurrence_exception_target_idx
  ON schedule_recurrence_exception(target_type, target_id, original_start);

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
  updated_at       TEXT NOT NULL,
  UNIQUE (party_id, kind, normalized_value)
) STRICT;
CREATE INDEX social_contact_channel_party_idx
  ON social_contact_channel(party_id, kind, is_preferred DESC);
CREATE INDEX social_contact_channel_duplicate_idx
  ON social_contact_channel(kind, normalized_value, party_id);
CREATE UNIQUE INDEX social_contact_channel_preferred_idx
  ON social_contact_channel(party_id, kind) WHERE is_preferred = 1;

CREATE TABLE people_merge (
  merge_id        TEXT PRIMARY KEY,
  source_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  target_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  revision_id     TEXT NOT NULL REFERENCES core_entity_revision(revision_id),
  merged_at       TEXT NOT NULL,
  undone_at       TEXT,
  CHECK (source_party_id <> target_party_id)
) STRICT;
CREATE UNIQUE INDEX people_merge_source_active_idx
  ON people_merge(source_party_id) WHERE undone_at IS NULL;
CREATE INDEX people_merge_target_idx
  ON people_merge(target_party_id);
CREATE INDEX people_merge_revision_idx
  ON people_merge(revision_id);

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
ALTER TABLE tally_expense ADD COLUMN recurring_template_id TEXT;

CREATE TABLE tally_recurring_expense (
  template_id           TEXT PRIMARY KEY,
  group_id              TEXT NOT NULL REFERENCES tally_group(group_id),
  description           TEXT NOT NULL,
  original_amount_minor INTEGER NOT NULL CHECK (original_amount_minor > 0),
  original_currency     TEXT NOT NULL CHECK (length(original_currency) = 3),
  settlement_currency   TEXT NOT NULL CHECK (length(settlement_currency) = 3),
  paid_by               TEXT NOT NULL REFERENCES core_party(party_id),
  category              TEXT NOT NULL,
  splits_json           TEXT NOT NULL CHECK (json_valid(splits_json)),
  rrule                 TEXT NOT NULL,
  anchor_start          TEXT NOT NULL,
  time_zone             TEXT NOT NULL,
  rate_scaled           INTEGER CHECK (rate_scaled IS NULL OR rate_scaled > 0),
  rate_scale            INTEGER CHECK (rate_scale IS NULL OR rate_scale BETWEEN 0 AND 12),
  rate_source           TEXT,
  rate_date             TEXT,
  status                TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','ended')),
  last_materialized_start TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
) STRICT;
CREATE INDEX tally_recurring_expense_group_idx
  ON tally_recurring_expense(group_id, status, anchor_start);
CREATE INDEX tally_recurring_expense_paid_by_idx
  ON tally_recurring_expense(paid_by);
CREATE UNIQUE INDEX tally_expense_recurring_instance_idx
  ON tally_expense(recurring_template_id, spent_on)
  WHERE recurring_template_id IS NOT NULL;
`;
