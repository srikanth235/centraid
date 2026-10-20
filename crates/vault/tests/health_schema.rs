//! RUNG THREE, the health pack (#1129, R-1129-1): the schema holds what the commands lean on.
//!
//! What each test holds, and the claim a port would get wrong:
//!
//! 1. **The pack states its commitments.** Every `health_%` table is registered with what it is
//!    a projection of, is mutable, and carries `updated_at`, `row_version` and its touch trigger;
//!    `core_activity` is now mutable the same way, and an UPDATE moves its `row_version`.
//! 2. **A day's total is a fact, stated once.** The metric CHECK names its unit, a day is a real
//!    calendar date, a value is never negative, and `(subject, day, metric)` is the key, so a
//!    second statement of the same day is a conflict and never a second row.
//! 3. **Health stores no derived figure**: no unit, zone, typical, total, streak or read stamp.
//! 4. **The workout kinds are seeded once, under fixed ids**, each an entity of its own.
//! 5. **A `health` link points at an activity** and at nothing else.
//! 6. **The rung is a climb.** A file wound back to rung two, holding an activity and a calendar
//!    link, opens at the head with the activity's row kept, `updated_at = created_at` and
//!    `row_version = 1`, and nothing else moved.

mod common;

use centraid_ontology::golden::scratch_dir;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::{Result, Vault, head_version};
use rusqlite::Connection;

const NOW: &str = "2026-10-20T09:00:00.000Z";

fn count(vault: &Vault, sql: &str) -> i64 {
    vault
        .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .unwrap_or_else(|error| panic!("{sql}: {error}"))
}

fn texts(connection: &Connection, sql: &str) -> Vec<String> {
    let mut statement = connection.prepare(sql).expect("the query prepares");
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("the query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("the rows read")
}

fn run(vault: &Vault, sql: &str) -> Result<()> {
    vault
        .commit(|tx| {
            tx.set_producer("test.health_schema");
            tx.connection().execute_batch(sql)?;
            Ok(())
        })
        .map(|_| ())
}

fn day(vault: &Vault, subject: &str, day: &str, metric: &str, value: f64) -> Result<()> {
    vault
        .commit(|tx| {
            tx.set_producer("test.health_schema");
            tx.connection().execute(
                "INSERT INTO health_daily (subject_party_id, day, metric, value) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![subject, day, metric, value],
            )?;
            Ok(())
        })
        .map(|_| ())
}

fn activity(vault: &Vault, id: &str, actor: &str, kind: &str) {
    vault
        .commit(|tx| {
            tx.set_producer("test.health_schema");
            tx.connection().execute(
                "INSERT INTO core_activity
                   (activity_id, actor_party_id, kind_concept_id, started_at, ended_at, created_at)
                 VALUES (?1, ?2, ?3, '2026-10-19T07:00:00Z', '2026-10-19T07:40:00Z', ?4)",
                rusqlite::params![id, actor, kind, NOW],
            )?;
            Ok(())
        })
        .expect("an activity is written");
}

fn event(vault: &Vault, id: &str) {
    run(
        vault,
        &format!(
            "INSERT INTO core_event (event_id, summary, dtstart, start_tz, status, sequence, created_at)
             VALUES ('{id}', 'Lunch', '2026-10-20T12:00:00Z', 'UTC', 'confirmed', 0, '{NOW}')"
        ),
    )
    .expect("an event is written");
}

fn link(vault: &Vault, link_id: &str, source: &str, phone_id: &str, entity: &str) -> Result<()> {
    run(
        vault,
        &format!(
            "INSERT OR IGNORE INTO phone_origin (origin_id, source, phone_origin, label, created_at)
             VALUES ('o-{source}', '{source}', 'store', 'Main', '{NOW}');
             INSERT INTO phone_link
               (link_id, source, phone_id, origin_id, entity_id, fingerprint, last_seen_at, created_at)
             VALUES ('{link_id}', '{source}', '{phone_id}', 'o-{source}', '{entity}', 'f1', '{NOW}', '{NOW}')"
        ),
    )
}

fn has_column(vault: &Vault, table: &str, column: &str) -> bool {
    count(
        vault,
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"),
    ) == 1
}

fn has_trigger(vault: &Vault, name: &str) -> bool {
    count(
        vault,
        &format!("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = '{name}'"),
    ) == 1
}

// ---------------------------------------------------------------------------
// 1. The pack's commitments
// ---------------------------------------------------------------------------

#[test]
fn every_health_table_is_registered_mutable_and_stamped_and_so_is_the_activity() {
    let scratch = common::Scratch::founded("health-commitments").expect("a vault is founded");
    let vault = &scratch.vault;
    let registries = centraid_ontology::registries::v0_registries();
    assert!(
        registries
            .ontology_packs
            .iter()
            .any(|pack| pack == "health")
    );
    let registered: Vec<(String, String, Option<String>)> = registries
        .entities
        .iter()
        .filter(|entity| entity.logical.starts_with("health."))
        .map(|entity| {
            assert_eq!(entity.lifecycle, "mutable", "{}", entity.table);
            (
                entity.logical.clone(),
                entity.table.clone(),
                entity.projection_of.clone(),
            )
        })
        .collect();
    assert_eq!(
        registered,
        vec![
            (
                "health.daily".to_owned(),
                "health_daily".to_owned(),
                Some("core.party".to_owned())
            ),
            (
                "health.workout".to_owned(),
                "health_workout".to_owned(),
                Some("core.activity".to_owned())
            ),
        ]
    );
    // The physical tables are exactly the registered ones.
    let tables = vault
        .read(|connection| {
            Ok(texts(
                connection,
                "SELECT name FROM sqlite_master WHERE type = 'table'
                    AND name LIKE 'health\\_%' ESCAPE '\\' ORDER BY name",
            ))
        })
        .expect("the tables read");
    assert_eq!(tables, vec!["health_daily", "health_workout"]);
    // Neither is an entity kind: a projection is part of its parent's row.
    assert_eq!(
        count(
            vault,
            "SELECT COUNT(*) FROM core_entity_kind WHERE kind LIKE 'health.%'"
        ),
        0
    );

    // Every mutable table here, and the activity the workout extends, is stamped.
    let activity_entity = registries
        .entities
        .iter()
        .find(|entity| entity.logical == "core.activity")
        .expect("core.activity is registered");
    assert_eq!(activity_entity.lifecycle, "mutable");
    for table in ["health_daily", "health_workout", "core_activity"] {
        for column in ["updated_at", "row_version"] {
            assert!(has_column(vault, table, column), "{table} has no {column}");
        }
        assert!(
            has_trigger(vault, &format!("{table}_touch_updated_at")),
            "{table} has no touch trigger"
        );
    }
}

#[test]
fn an_edit_to_an_activity_moves_its_row_version_and_its_stamp() {
    let scratch = common::Scratch::founded("health-activity").expect("a vault is founded");
    let vault = &scratch.vault;
    let owner = common::owner_party(vault).expect("an owner");
    activity(vault, "a1", &owner, "health:kind:run");
    assert_eq!(
        count(
            vault,
            "SELECT row_version FROM core_activity WHERE activity_id = 'a1'"
        ),
        1
    );
    run(
        vault,
        "UPDATE core_activity SET ended_at = '2026-10-19T07:45:00Z' WHERE activity_id = 'a1'",
    )
    .expect("an activity changes");
    assert_eq!(
        count(
            vault,
            "SELECT row_version FROM core_activity WHERE activity_id = 'a1'"
        ),
        2
    );
    assert_eq!(
        count(
            vault,
            &format!(
                "SELECT COUNT(*) FROM core_activity WHERE activity_id = 'a1' AND updated_at <> '{NOW}'"
            )
        ),
        1,
        "the touch trigger stamped the edit"
    );
}

// ---------------------------------------------------------------------------
// 2. A day's total
// ---------------------------------------------------------------------------

#[test]
fn a_days_total_names_its_unit_is_a_real_day_is_never_negative_and_is_stated_once() {
    let scratch = common::Scratch::founded("health-daily").expect("a vault is founded");
    let vault = &scratch.vault;
    let owner = common::owner_party(vault).expect("an owner");
    for metric in [
        "steps",
        "active_energy_kcal",
        "exercise_min",
        "sleep_min",
        "resting_hr_bpm",
        "weight_kg",
    ] {
        day(vault, &owner, "2026-10-19", metric, 1.0).expect("each named metric is stored");
    }
    // A metric is one of six, and the unit is in its name: a bare `weight` is refused.
    for metric in ["weight", "weight_lb", "heart_rate", "Steps", ""] {
        assert!(
            day(vault, &owner, "2026-10-18", metric, 1.0).is_err(),
            "{metric:?} is not a metric"
        );
    }
    // A day is a real calendar date written as YYYY-MM-DD.
    for bad in [
        "2026-02-30",
        "2026-2-3",
        "2026-10-19T00:00:00Z",
        "19/10/2026",
        "",
    ] {
        assert!(
            day(vault, &owner, bad, "steps", 1.0).is_err(),
            "{bad:?} is not a day"
        );
    }
    // A value is never negative; zero is a value (a day the store says nothing happened).
    assert!(day(vault, &owner, "2026-10-18", "steps", -1.0).is_err());
    day(vault, &owner, "2026-10-18", "steps", 0.0).expect("zero is a total");
    // The same (subject, day, metric) twice is a conflict, never a second row.
    let again = day(vault, &owner, "2026-10-19", "steps", 9_000.0)
        .expect_err("a re-statement of a day is a conflict");
    assert!(
        again.to_string().to_ascii_lowercase().contains("unique"),
        "{again}"
    );
    assert_eq!(
        count(
            vault,
            "SELECT COUNT(*) FROM health_daily WHERE day = '2026-10-19' AND metric = 'steps'"
        ),
        1
    );
    // An edit is a replace that moves the stamp.
    run(
        vault,
        "UPDATE health_daily SET value = 9000 WHERE day = '2026-10-19' AND metric = 'steps'",
    )
    .expect("a day's value changes");
    assert_eq!(
        count(
            vault,
            "SELECT row_version FROM health_daily WHERE day = '2026-10-19' AND metric = 'steps'"
        ),
        2
    );
    // A subject is a party that exists.
    assert!(day(vault, "nobody", "2026-10-17", "steps", 1.0).is_err());
}

// ---------------------------------------------------------------------------
// 3. No derived figure
// ---------------------------------------------------------------------------

#[test]
fn health_stores_no_derived_figure_no_unit_and_no_read_stamp() {
    let scratch = common::Scratch::founded("health-figures").expect("a vault is founded");
    for table in ["health_daily", "health_workout"] {
        for column in ["unit", "tz", "typical", "total", "streak", "read_at"] {
            assert!(
                !has_column(&scratch.vault, table, column),
                "{table} stores `{column}`"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 4. The workout kinds
// ---------------------------------------------------------------------------

#[test]
fn the_eight_workout_kinds_are_seeded_under_fixed_ids() {
    let scratch = common::Scratch::founded("health-kinds").expect("a vault is founded");
    let kinds = scratch
        .vault
        .read(|connection| {
            Ok(texts(
                connection,
                "SELECT c.concept_id || '|' || c.notation || '|' || c.pref_label || '|' || e.entity_type
                   FROM core_concept c
                   JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                   JOIN core_entity e ON e.entity_id = c.concept_id
                  WHERE s.uri = 'urn:centraid:health:workout-kinds'
                  ORDER BY c.concept_id",
            ))
        })
        .expect("the kinds read");
    assert_eq!(
        kinds,
        vec![
            "health:kind:cycle|cycle|Cycle|core.concept",
            "health:kind:hike|hike|Hike|core.concept",
            "health:kind:other|other|Other|core.concept",
            "health:kind:run|run|Run|core.concept",
            "health:kind:strength|strength|Strength|core.concept",
            "health:kind:swim|swim|Swim|core.concept",
            "health:kind:walk|walk|Walk|core.concept",
            "health:kind:yoga|yoga|Yoga|core.concept",
        ]
    );
    assert_eq!(
        count(
            &scratch.vault,
            "SELECT COUNT(*) FROM core_entity
              WHERE entity_id = 'health:workout-kinds' AND entity_type = 'core.concept_scheme'"
        ),
        1
    );
}

// ---------------------------------------------------------------------------
// 5. The health link
// ---------------------------------------------------------------------------

#[test]
fn a_health_link_points_at_an_activity_and_at_nothing_else() {
    let scratch = common::Scratch::founded("health-link").expect("a vault is founded");
    let vault = &scratch.vault;
    let owner = common::owner_party(vault).expect("an owner");
    activity(vault, "a1", &owner, "health:kind:run");
    event(vault, "e1");
    link(vault, "l1", "health", "hk-1", "a1").expect("health -> activity");
    let error = link(vault, "l2", "health", "hk-2", "e1").expect_err("health -> event is refused");
    assert!(
        error.to_string().contains("the kind its source implies"),
        "{error}"
    );
    // Nor can a calendar link point at an activity, or a health link be moved onto an event.
    assert!(link(vault, "l3", "calendar", "k-1", "a1").is_err());
    assert!(
        run(
            vault,
            "UPDATE phone_link SET entity_id = 'e1' WHERE link_id = 'l1'"
        )
        .is_err()
    );
    // A workout row decorates exactly its activity, and goes with it.
    run(
        vault,
        "INSERT INTO health_workout (activity_id, phone_kind) VALUES ('a1', 'running')",
    )
    .expect("a workout row");
    assert!(
        run(
            vault,
            "INSERT INTO health_workout (activity_id, phone_kind) VALUES ('e1', 'running')"
        )
        .is_err(),
        "a workout is the health half of an activity, not of an event"
    );
    run(vault, "DELETE FROM core_entity WHERE entity_id = 'a1'").expect("the activity is purged");
    assert_eq!(count(vault, "SELECT COUNT(*) FROM health_workout"), 0);
    assert_eq!(
        count(
            vault,
            "SELECT COUNT(*) FROM phone_link WHERE link_id = 'l1' AND entity_id IS NULL"
        ),
        1,
        "the link is left a tombstone"
    );
}

// ---------------------------------------------------------------------------
// 6. The climb
// ---------------------------------------------------------------------------

#[test]
fn the_rung_is_a_climb_a_file_at_two_reaches_three_with_its_activities_kept() {
    let dir = scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    let owner;
    {
        let vault = Vault::create_with(
            &path,
            Box::new(FixedClock::frozen()),
            Box::new(SeededIds::new("health-climb")),
        )
        .expect("a vault is founded");
        vault.found("Test", "Test Owner").expect("an owner");
        owner = common::owner_party(&vault).expect("an owner");
        event(&vault, "e1");
        link(&vault, "l1", "calendar", "k-1", "e1").expect("a calendar link");
    }
    // WIND IT BACK to rung two, then write the rows the old shape let through: an activity with
    // no `updated_at` or `row_version`, under a concept rung one seeds.
    {
        let connection = Connection::open(&path).expect("the file opens");
        common::undo_rung_three(&connection);
        connection
            .execute_batch(&format!(
                "PRAGMA user_version = 2;
                 INSERT INTO core_activity
                   (activity_id, actor_party_id, kind_concept_id, started_at, created_at)
                 VALUES ('a-old', '{owner}', 'money:cat:food', '2026-10-01T12:00:00Z',
                         '2026-10-01T12:30:00.000Z');"
            ))
            .expect("the old shape takes a row");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('core_activity')
                      WHERE name IN ('updated_at', 'row_version')",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .expect("the columns read"),
            0,
            "the file really is at rung two's shape"
        );
    }
    assert_eq!(head_version(), 3);

    let vault = Vault::open(&path).expect("a file at rung two opens and climbs");
    assert_eq!(count(&vault, "PRAGMA user_version"), 3);
    // The row is kept whole, stamped as of its making, at its first version.
    assert_eq!(
        count(
            &vault,
            "SELECT COUNT(*) FROM core_activity
              WHERE activity_id = 'a-old' AND kind_concept_id = 'money:cat:food'
                AND started_at = '2026-10-01T12:00:00Z'
                AND created_at = '2026-10-01T12:30:00.000Z'
                AND updated_at = created_at AND row_version = 1"
        ),
        1
    );
    // Its entity row survived the rebuild, and the entity triggers are live on the new table.
    assert_eq!(
        count(
            &vault,
            "SELECT COUNT(*) FROM core_entity WHERE entity_id = 'a-old' AND entity_type = 'core.activity'"
        ),
        1
    );
    activity(&vault, "a-new", &owner, "health:kind:walk");
    assert_eq!(
        count(
            &vault,
            "SELECT COUNT(*) FROM core_entity WHERE entity_id = 'a-new'"
        ),
        1
    );
    // The calendar link is untouched, the pack is there and the kinds are seeded.
    assert_eq!(
        count(
            &vault,
            "SELECT COUNT(*) FROM phone_link WHERE link_id = 'l1' AND entity_id = 'e1'"
        ),
        1
    );
    assert_eq!(
        count(
            &vault,
            "SELECT COUNT(*) FROM core_concept WHERE scheme_id = 'health:workout-kinds'"
        ),
        8
    );
    for trigger in [
        "core_activity_entity_delete",
        "core_activity_entity_insert",
        "core_activity_touch_updated_at",
        "health_daily_touch_updated_at",
        "health_workout_touch_updated_at",
    ] {
        assert!(has_trigger(&vault, trigger), "{trigger} after the climb");
    }
    // The rebuilt table's text is the rung's, not a rename's quoted copy.
    assert_eq!(
        count(
            &vault,
            "SELECT COUNT(*) FROM sqlite_master
              WHERE name = 'core_activity' AND sql LIKE 'CREATE TABLE core_activity (%'"
        ),
        1
    );
    // Nothing dangles, and the file is whole.
    assert_eq!(
        count(&vault, "SELECT COUNT(*) FROM pragma_foreign_key_check"),
        0
    );
    let integrity: String = vault
        .read(
            |connection| Ok(connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?),
        )
        .expect("the check runs");
    assert_eq!(integrity, "ok");
    // A purge still cascades through the rebuilt foreign key.
    run(&vault, "DELETE FROM core_entity WHERE entity_id = 'a-old'").expect("a purge");
    assert_eq!(
        count(
            &vault,
            "SELECT COUNT(*) FROM core_activity WHERE activity_id = 'a-old'"
        ),
        0
    );
    drop(vault);
    let _ = std::fs::remove_dir_all(dir);
}
