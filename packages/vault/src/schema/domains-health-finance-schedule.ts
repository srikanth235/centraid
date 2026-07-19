// Domain DDL — schemas `health`, `finance`, `schedule` from
// duaility-ontology.html §03. Domains extend core rows (UNIQUE NOT NULL FK to
// the row they specialize — rule R02 "extend, don't fork") or reference them;
// they never re-declare identity.

export const HEALTH_DDL = `
CREATE TABLE health_vital (
  vital_id       TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL UNIQUE REFERENCES core_observation(observation_id),
  vital_type     TEXT NOT NULL CHECK (vital_type IN ('heart_rate','bp_systolic','bp_diastolic','spo2','body_weight','glucose','temp')),
  context        TEXT CHECK (context IN ('rest','exercise','sleep','post_meal')),
  loinc_code     TEXT
) STRICT;

CREATE TABLE health_workout (
  workout_id       TEXT PRIMARY KEY,
  activity_id      TEXT NOT NULL UNIQUE REFERENCES core_activity(activity_id),
  sport_concept_id TEXT NOT NULL REFERENCES core_concept(concept_id),
  distance_m       REAL CHECK (distance_m >= 0),
  energy_kcal      REAL CHECK (energy_kcal >= 0),
  avg_hr           REAL CHECK (avg_hr > 0),
  training_load    REAL,
  route_content_id TEXT REFERENCES core_content_item(content_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_workout_sport_concept ON health_workout(sport_concept_id);
CREATE INDEX IF NOT EXISTS idx_workout_route_content ON health_workout(route_content_id);

CREATE TABLE health_sleep_session (
  sleep_id       TEXT PRIMARY KEY,
  activity_id    TEXT NOT NULL UNIQUE REFERENCES core_activity(activity_id),
  stages_json    TEXT CHECK (stages_json IS NULL OR json_valid(stages_json)),
  efficiency_pct REAL CHECK (efficiency_pct BETWEEN 0 AND 100),
  interruptions  INTEGER CHECK (interruptions >= 0),
  hrv_ms         REAL
) STRICT;

CREATE TABLE health_medication_course (
  course_id           TEXT PRIMARY KEY,
  subject_party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  rxnorm_code         TEXT,
  name                TEXT NOT NULL,
  dose_text           TEXT NOT NULL,
  schedule_rrule      TEXT,
  prescriber_party_id TEXT REFERENCES core_party(party_id),
  started_at          TEXT NOT NULL,
  ended_at            TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_medication_course_subject_party ON health_medication_course(subject_party_id);
CREATE INDEX IF NOT EXISTS idx_medication_course_prescriber_party ON health_medication_course(prescriber_party_id);

CREATE TABLE health_condition (
  condition_id     TEXT PRIMARY KEY,
  subject_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  snomed_code      TEXT,
  icd10_code       TEXT,
  label            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('active','remission','resolved')),
  severity         TEXT CHECK (severity IN ('mild','moderate','severe')),
  onset_date       TEXT,
  abatement_date   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_condition_subject_party ON health_condition(subject_party_id);
`;

export const FINANCE_DDL = `
CREATE TABLE finance_txn_split (
  split_id            TEXT PRIMARY KEY,
  txn_id              TEXT NOT NULL REFERENCES core_transaction(txn_id),
  amount_minor        INTEGER NOT NULL,
  category_concept_id TEXT NOT NULL REFERENCES core_concept(concept_id),
  memo                TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_txn_split_txn ON finance_txn_split(txn_id);
CREATE INDEX IF NOT EXISTS idx_txn_split_category_concept ON finance_txn_split(category_concept_id);

CREATE TABLE finance_budget (
  budget_id           TEXT PRIMARY KEY,
  owner_party_id      TEXT NOT NULL REFERENCES core_party(party_id),
  category_concept_id TEXT NOT NULL REFERENCES core_concept(concept_id),
  period              TEXT NOT NULL CHECK (period IN ('month','quarter','year')),
  limit_minor         INTEGER NOT NULL CHECK (limit_minor >= 0),
  currency            TEXT NOT NULL CHECK (length(currency) = 3),
  starts_on           TEXT NOT NULL,
  UNIQUE (owner_party_id, category_concept_id, period, starts_on)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_budget_category_concept ON finance_budget(category_concept_id);

CREATE TABLE finance_holding (
  holding_id       TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES core_account(account_id),
  instrument       TEXT NOT NULL,
  qty_scaled       INTEGER NOT NULL,
  qty_scale        INTEGER NOT NULL CHECK (qty_scale BETWEEN 0 AND 9),
  cost_basis_minor INTEGER,
  as_of            TEXT NOT NULL,
  UNIQUE (account_id, instrument, as_of)
) STRICT;

CREATE TABLE finance_recurring_series (
  series_id             TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES core_account(account_id),
  counterparty_party_id TEXT REFERENCES core_party(party_id),
  rrule                 TEXT NOT NULL,
  anchor_on             TEXT,
  expected_minor        INTEGER NOT NULL,
  tolerance_pct         REAL NOT NULL CHECK (tolerance_pct BETWEEN 0 AND 100),
  last_txn_id           TEXT REFERENCES core_transaction(txn_id),
  status                TEXT NOT NULL CHECK (status IN ('active','paused','ended'))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_recurring_series_account ON finance_recurring_series(account_id);
CREATE INDEX IF NOT EXISTS idx_recurring_series_counterparty_party ON finance_recurring_series(counterparty_party_id);
CREATE INDEX IF NOT EXISTS idx_recurring_series_last_txn ON finance_recurring_series(last_txn_id);

CREATE TABLE finance_fx_rate (
  rate_id     TEXT PRIMARY KEY,
  base_ccy    TEXT NOT NULL CHECK (length(base_ccy) = 3),
  quote_ccy   TEXT NOT NULL CHECK (length(quote_ccy) = 3),
  rate_scaled INTEGER NOT NULL CHECK (rate_scaled > 0),
  rate_scale  INTEGER NOT NULL CHECK (rate_scale BETWEEN 0 AND 12),
  as_of       TEXT NOT NULL,
  UNIQUE (base_ccy, quote_ccy, as_of)
) STRICT;
`;

export const SCHEDULE_DDL = `
CREATE TABLE schedule_calendar (
  calendar_id    TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  name           TEXT NOT NULL,
  color          TEXT,
  default_tz     TEXT NOT NULL,
  visibility     TEXT NOT NULL CHECK (visibility IN ('private','shared','public')),
  external_uri   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_calendar_owner_party ON schedule_calendar(owner_party_id);

CREATE TABLE schedule_event_ext (
  event_ext_id      TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL UNIQUE REFERENCES core_event(event_id),
  calendar_id       TEXT NOT NULL REFERENCES schedule_calendar(calendar_id),
  busy              TEXT NOT NULL CHECK (busy IN ('busy','free')),
  conferencing_uri  TEXT,
  reminders_json    TEXT CHECK (reminders_json IS NULL OR json_valid(reminders_json)),
  travel_buffer_min INTEGER CHECK (travel_buffer_min >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_event_ext_calendar ON schedule_event_ext(calendar_id);

CREATE TABLE schedule_attendee (
  attendee_id  TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES core_event(event_id),
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  role         TEXT NOT NULL CHECK (role IN ('chair','required','optional')),
  partstat     TEXT NOT NULL CHECK (partstat IN ('needs-action','accepted','declined','tentative')),
  responded_at TEXT,
  UNIQUE (event_id, party_id)
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
  remind_before_min INTEGER CHECK (remind_before_min >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_task_owner_party ON schedule_task(owner_party_id);
CREATE INDEX IF NOT EXISTS idx_task_parent_task ON schedule_task(parent_task_id);

CREATE TABLE schedule_availability_rule (
  rule_id        TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  weekday_mask   INTEGER NOT NULL CHECK (weekday_mask BETWEEN 1 AND 127),
  window_start   TEXT NOT NULL,
  window_end     TEXT NOT NULL CHECK (window_end > window_start),
  kind           TEXT NOT NULL CHECK (kind IN ('work','focus','personal','blocked')),
  tz             TEXT NOT NULL
) STRICT;
-- Deliberate recurrence split (issue #450): recurring events/tasks/plans use
-- RFC 5545 RRULE text for interchange fidelity; availability is a compact
-- weekly constraint, so weekday_mask is its native, queryable encoding.
CREATE INDEX IF NOT EXISTS idx_availability_rule_owner_party ON schedule_availability_rule(owner_party_id);
`;
