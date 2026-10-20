-- RUNG THREE of the vault's ladder: the health pack, and `core_activity` made mutable (#1129,
-- R-1129-1).
--
-- Health follows the phone's health store one way (R-1127-1): HealthKit on iOS, Health Connect
-- on Android. It keeps DAILY TOTALS and WORKOUTS, never raw samples, in two tables that are
-- projections of rows the spine already has:
--
--   health_daily    one stated total per (subject, day, metric), a fact about a person. The
--                   primary key makes a re-read of a day a replace, never an addition, and
--                   `health.record_days` writes only a value that moved (R-1088-12). A day does
--                   not go through `phone_link`: the store gives it no identity (R-1129-3).
--   health_workout  the health half of a `core_activity`. The activity is the entity a note's
--                   `[[link]]`, a `core_link` and `phone_link.entity_id` point at; this row adds
--                   only what the store measured. It follows by the store's id through
--                   `phone_link`, source `health` (R-1129-2).
--
-- The kind of a workout is a concept of the `health:workout-kinds` scheme. The eight common kinds
-- are seeded here under fixed ids with literal timestamps (a squash compares two foundings made at
-- different instants); a kind the seed does not name is minted on first use from the store's word
-- by `health.follow_workout`, and `phone_kind` keeps that word whole either way.
--
-- WHAT IT DOES NOT STORE: no derived figure (no typical, trend, streak or weekly total: the read
-- side computes them over `health_daily`), no unit column (the unit is in the metric's name), no
-- zone and no per-row read stamp (when a pass last ran is the engine's, R-1129-13), no text, no
-- bytes and nothing sealed.
--
-- `core_activity` BECOMES MUTABLE (the owner's answer 5): a followed workout changes when a watch
-- syncs late or an app edits it, so the activity gains `updated_at` and `row_version` and the touch
-- trigger every mutable table carries, which People's logged interactions inherit. SQLite cannot
-- add a column with a non-constant default, so the table is REBUILT: its own indexes and triggers
-- are dropped, the old table is renamed aside (no view, no other table's trigger and no other
-- table's foreign key names it, so the rename rewrites nothing else), the new one is created under
-- the old name so its stored text is the text below, every row is copied with
-- `updated_at = created_at` and `row_version = 1`, and the indexes and entity triggers are
-- recreated byte for byte. The rung runs in one transaction; on an opened vault foreign keys are
-- ON, so their check is deferred to its commit.

PRAGMA defer_foreign_keys = ON;

DROP TRIGGER core_activity_entity_delete;
DROP TRIGGER core_activity_entity_insert;
DROP INDEX idx_activity_actor_party;
DROP INDEX idx_activity_kind_concept;
DROP INDEX idx_activity_location_place;
DROP INDEX idx_activity_source_app;
ALTER TABLE core_activity RENAME TO core_activity_before_health;

-- table core_activity
CREATE TABLE core_activity (
  activity_id       TEXT PRIMARY KEY,
  actor_party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  kind_concept_id   TEXT NOT NULL REFERENCES core_concept(concept_id),
  started_at        TEXT NOT NULL,
  ended_at          TEXT CHECK (ended_at IS NULL OR ended_at >= started_at),
  location_place_id TEXT REFERENCES core_place(place_id),
  source_app_id     TEXT REFERENCES access_app(app_id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version       INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  FOREIGN KEY (activity_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

INSERT INTO core_activity
  (activity_id, actor_party_id, kind_concept_id, started_at, ended_at, location_place_id,
   source_app_id, created_at, updated_at, row_version)
SELECT activity_id, actor_party_id, kind_concept_id, started_at, ended_at, location_place_id,
       source_app_id, created_at, created_at, 1
  FROM core_activity_before_health;

DROP TABLE core_activity_before_health;

-- index idx_activity_actor_party
CREATE INDEX idx_activity_actor_party ON core_activity(actor_party_id);

-- index idx_activity_kind_concept
CREATE INDEX idx_activity_kind_concept ON core_activity(kind_concept_id);

-- index idx_activity_location_place
CREATE INDEX idx_activity_location_place ON core_activity(location_place_id);

-- index idx_activity_source_app
CREATE INDEX idx_activity_source_app ON core_activity(source_app_id);

-- The Workouts list pages newest first by (started_at, activity_id), and the follower asks for the
-- newest followed workout's start (R-1129-4): both walk this index rather than sort every row.
-- index core_activity_started_page_idx
CREATE INDEX core_activity_started_page_idx
  ON core_activity(started_at, activity_id);

-- trigger core_activity_entity_delete
CREATE TRIGGER core_activity_entity_delete
AFTER DELETE ON core_activity
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.activity_id;
END;

-- trigger core_activity_entity_insert
CREATE TRIGGER core_activity_entity_insert
BEFORE INSERT ON core_activity
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: core_activity (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.activity_id AND entity_type <> 'core.activity');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.activity_id, 'core.activity', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

-- trigger core_activity_touch_updated_at
CREATE TRIGGER core_activity_touch_updated_at
AFTER UPDATE ON core_activity
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE core_activity
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE activity_id = NEW.activity_id;
END;

-- table health_daily
CREATE TABLE health_daily (
  subject_party_id TEXT NOT NULL REFERENCES core_party(party_id) ON DELETE CASCADE,
  -- The phone's local calendar day as the health store reckons it at read time
  -- (HealthKit's statistics and Health Connect's aggregate both bucket by the
  -- device's current zone). Sleep is keyed to the day the member WOKE.
  day              TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                        AND date(day) = day),
  -- The unit is part of the metric's name, so there is no unit column and
  -- nothing to add across (the currency lesson: ONT-13, ONT-23).
  metric           TEXT NOT NULL CHECK (metric IN (
                     'steps',              -- sum
                     'active_energy_kcal', -- sum
                     'exercise_min',       -- sum
                     'sleep_min',          -- sum of asleep intervals, night ending on `day`
                     'resting_hr_bpm',     -- the store's daily average
                     'weight_kg')),        -- the last sample of the day
  value            REAL NOT NULL CHECK (value >= 0),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version      INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (subject_party_id, day, metric)
) STRICT;

-- trigger health_daily_touch_updated_at
CREATE TRIGGER health_daily_touch_updated_at
AFTER UPDATE ON health_daily
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE health_daily
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE subject_party_id = NEW.subject_party_id AND day = NEW.day AND metric = NEW.metric;
END;

-- table health_workout
CREATE TABLE health_workout (
  activity_id      TEXT PRIMARY KEY REFERENCES core_activity(activity_id) ON DELETE CASCADE,
  -- The store's own word for the kind (`HKWorkoutActivityType.running`,
  -- `EXERCISE_TYPE_RUNNING`), kept whole; the concept on the activity is the
  -- vault's reading of it.
  phone_kind       TEXT NOT NULL CHECK (length(trim(phone_kind)) > 0),
  -- The app or device that recorded it ("Apple Watch", "Strava"); shown, never joined.
  recorded_by      TEXT,
  -- Active time when the store distinguishes it from the span (pauses).
  moving_sec       INTEGER CHECK (moving_sec IS NULL OR moving_sec > 0),
  distance_m       REAL CHECK (distance_m IS NULL OR distance_m >= 0),
  energy_kcal      REAL CHECK (energy_kcal IS NULL OR energy_kcal >= 0),
  avg_hr_bpm       INTEGER CHECK (avg_hr_bpm IS NULL OR avg_hr_bpm > 0),
  elevation_gain_m REAL CHECK (elevation_gain_m IS NULL OR elevation_gain_m >= 0),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version      INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

-- trigger health_workout_touch_updated_at
CREATE TRIGGER health_workout_touch_updated_at
AFTER UPDATE ON health_workout
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE health_workout
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE activity_id = NEW.activity_id;
END;

-- The workout kinds, seeded under fixed ids. The entity triggers write each one's `core_entity`
-- row from its literal `created_at`.
INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version, created_at) VALUES ('health:workout-kinds', 'urn:centraid:health:workout-kinds', 'Workout kinds', 'centraid', '1', '2026-10-20T09:00:00.000Z');
INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition, stable_id, normalized_key, pref_label_lang, created_at, updated_at, row_version) VALUES ('health:kind:run', 'health:workout-kinds', 'run', 'Run', NULL, NULL, NULL, 'run', NULL, NULL, '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z', 1);
INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition, stable_id, normalized_key, pref_label_lang, created_at, updated_at, row_version) VALUES ('health:kind:walk', 'health:workout-kinds', 'walk', 'Walk', NULL, NULL, NULL, 'walk', NULL, NULL, '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z', 1);
INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition, stable_id, normalized_key, pref_label_lang, created_at, updated_at, row_version) VALUES ('health:kind:cycle', 'health:workout-kinds', 'cycle', 'Cycle', NULL, NULL, NULL, 'cycle', NULL, NULL, '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z', 1);
INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition, stable_id, normalized_key, pref_label_lang, created_at, updated_at, row_version) VALUES ('health:kind:strength', 'health:workout-kinds', 'strength', 'Strength', NULL, NULL, NULL, 'strength', NULL, NULL, '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z', 1);
INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition, stable_id, normalized_key, pref_label_lang, created_at, updated_at, row_version) VALUES ('health:kind:swim', 'health:workout-kinds', 'swim', 'Swim', NULL, NULL, NULL, 'swim', NULL, NULL, '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z', 1);
INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition, stable_id, normalized_key, pref_label_lang, created_at, updated_at, row_version) VALUES ('health:kind:hike', 'health:workout-kinds', 'hike', 'Hike', NULL, NULL, NULL, 'hike', NULL, NULL, '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z', 1);
INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition, stable_id, normalized_key, pref_label_lang, created_at, updated_at, row_version) VALUES ('health:kind:yoga', 'health:workout-kinds', 'yoga', 'Yoga', NULL, NULL, NULL, 'yoga', NULL, NULL, '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z', 1);
INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition, stable_id, normalized_key, pref_label_lang, created_at, updated_at, row_version) VALUES ('health:kind:other', 'health:workout-kinds', 'other', 'Other', NULL, NULL, NULL, 'other', NULL, NULL, '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z', 1);
