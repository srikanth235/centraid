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
`;

export const FINANCE_DDL = `
CREATE TABLE finance_txn_split (
  split_id            TEXT PRIMARY KEY,
  txn_id              TEXT NOT NULL REFERENCES core_transaction(txn_id),
  amount_minor        INTEGER NOT NULL,
  category_concept_id TEXT NOT NULL REFERENCES core_concept(concept_id),
  memo                TEXT
) STRICT;

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
  expected_minor        INTEGER NOT NULL,
  tolerance_pct         REAL NOT NULL CHECK (tolerance_pct BETWEEN 0 AND 100),
  last_txn_id           TEXT REFERENCES core_transaction(txn_id),
  status                TEXT NOT NULL CHECK (status IN ('active','paused','ended'))
) STRICT;

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

CREATE TABLE schedule_event_ext (
  event_ext_id      TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL UNIQUE REFERENCES core_event(event_id),
  calendar_id       TEXT NOT NULL REFERENCES schedule_calendar(calendar_id),
  busy              TEXT NOT NULL CHECK (busy IN ('busy','free')),
  conferencing_uri  TEXT,
  reminders_json    TEXT CHECK (reminders_json IS NULL OR json_valid(reminders_json)),
  travel_buffer_min INTEGER CHECK (travel_buffer_min >= 0)
) STRICT;

CREATE TABLE schedule_attendee (
  attendee_id  TEXT PRIMARY KEY,
  event_id     TEXT NOT NULL REFERENCES core_event(event_id),
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  role         TEXT NOT NULL CHECK (role IN ('chair','required','optional')),
  partstat     TEXT NOT NULL CHECK (partstat IN ('needs-action','accepted','declined','tentative')),
  responded_at TEXT,
  UNIQUE (event_id, party_id)
) STRICT;

CREATE TABLE schedule_task (
  task_id        TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  title          TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('needs-action','in-process','completed','cancelled')),
  priority       INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 9),
  due_at         TEXT,
  completed_at   TEXT,
  effort_min     INTEGER CHECK (effort_min > 0),
  parent_task_id TEXT REFERENCES schedule_task(task_id),
  rrule          TEXT
) STRICT;

CREATE TABLE schedule_availability_rule (
  rule_id        TEXT PRIMARY KEY,
  owner_party_id TEXT NOT NULL REFERENCES core_party(party_id),
  weekday_mask   INTEGER NOT NULL CHECK (weekday_mask BETWEEN 1 AND 127),
  window_start   TEXT NOT NULL,
  window_end     TEXT NOT NULL CHECK (window_end > window_start),
  kind           TEXT NOT NULL CHECK (kind IN ('work','focus','personal','blocked')),
  tz             TEXT NOT NULL
) STRICT;
`;
