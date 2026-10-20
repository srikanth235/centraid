//! THE THREE `health.*` COMMANDS (#1129, R-1129-2, R-1129-3).
//!
//! What each test holds, and the claim a port would get wrong:
//!
//! 1. **Reading the same week twice writes nothing** (R-1088-12): an identical batch finds every
//!    value held and moves no `row_version`; a changed value moves its row once and no other.
//! 2. **A refused batch writes nothing**: an unknown subject, a day the calendar has not got, an
//!    unknown metric, a negative value or a metric stated twice is a `Failed` outcome naming its
//!    predicate, and not one row of the batch lands.
//! 3. **A workout is an activity, followed by its own id**: a follow writes both rows, a re-follow
//!    with a corrected distance updates both once, an identical re-follow writes nothing, and an
//!    id that names an activity with no workout row is refused (it is not a workout).
//! 4. **A kind the seed does not name is minted once** into the workout-kinds scheme and reused.
//! 5. **A purge cascades and leaves the link a tombstone**, which `phone.link` then refuses; a
//!    `health` link passes `phone.link` on a workout and is refused on an event.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Vault};
use serde_json::{Value, json};

struct Bench {
    scratch: common::Scratch,
    registry: Registry,
    principal: Principal,
}

impl Bench {
    fn open(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        Self {
            scratch,
            registry,
            principal: Principal::owner("health"),
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    fn try_run(&self, command: &str, input: Value) -> CommandOutcome {
        self.vault()
            .execute(
                &self.registry,
                &self.principal,
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("`{command}` errored rather than answering: {error}"))
    }

    fn run(&self, command: &str, input: Value) -> Value {
        let outcome = self.try_run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "`{command}` refused: {:?} / {:?}",
            outcome.predicate,
            outcome.reason
        );
        outcome.output
    }

    /// The predicate a refused command named; fails if it ran or wrote any health row.
    fn refused(&self, command: &str, input: Value) -> String {
        let before = self.state();
        let outcome = self.try_run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "`{command}` should have been refused"
        );
        assert!(outcome.reason.is_some(), "a refusal says why");
        assert_eq!(
            before,
            self.state(),
            "a refused `{command}` wrote something"
        );
        outcome.predicate.expect("a refusal names its predicate")
    }

    /// Every row the commands write, every column, as text: a no-op that still wrote shows in
    /// `row_version` and `updated_at`.
    fn state(&self) -> String {
        let mut lines = Vec::new();
        for sql in [
            "SELECT * FROM health_daily ORDER BY subject_party_id, day, metric",
            "SELECT * FROM health_workout ORDER BY activity_id",
            "SELECT * FROM core_activity ORDER BY activity_id",
            "SELECT * FROM core_concept WHERE scheme_id = 'health:workout-kinds' ORDER BY concept_id",
            "SELECT * FROM phone_link ORDER BY link_id",
        ] {
            lines.push(
                self.vault()
                    .read(|connection| {
                        let mut statement = connection.prepare(sql)?;
                        let columns = statement.column_count();
                        let rows = statement.query_map([], |row| {
                            let mut line = String::new();
                            for column in 0..columns {
                                line.push_str(&format!("{:?}|", row.get_ref(column)?));
                            }
                            Ok(line)
                        })?;
                        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?.join("\n"))
                    })
                    .expect("the rows read"),
            );
        }
        lines.join("\n--\n")
    }

    fn count(&self, sql: &str) -> i64 {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    }

    fn origin(&self) -> String {
        self.run(
            "phone.origin",
            json!({ "source": "health", "phone_origin": "store:apple-health", "label": "Apple Health" }),
        )["origin_id"]
            .as_str()
            .expect("an origin id")
            .to_owned()
    }
}

/// A week of four metrics, as a pass would send it.
fn week(steps_on_the_19th: f64) -> Value {
    let mut days = Vec::new();
    for day in 13..=19 {
        let day = format!("2026-10-{day}");
        let steps = if day == "2026-10-19" {
            steps_on_the_19th
        } else {
            7_000.0
        };
        days.push(json!({ "day": day, "metric": "steps", "value": steps }));
        days.push(json!({ "day": day, "metric": "sleep_min", "value": 431.5 }));
        days.push(json!({ "day": day, "metric": "resting_hr_bpm", "value": 58.0 }));
        days.push(json!({ "day": day, "metric": "weight_kg", "value": 71.25 }));
    }
    json!({ "days": days })
}

fn workout(id: &str, kind: &str, distance: Option<f64>) -> Value {
    json!({
        "activity_id": id, "kind": kind, "phone_kind": "HKWorkoutActivityType.running",
        "started_at": "2026-10-19T07:00:00Z", "ended_at": "2026-10-19T07:41:30.250Z",
        "recorded_by": "Apple Watch", "moving_sec": 2400, "distance_m": distance,
        "energy_kcal": 412.0, "avg_hr_bpm": 151, "elevation_gain_m": 38.5,
    })
}

// ---------------------------------------------------------------------------
// 1. Days
// ---------------------------------------------------------------------------

#[test]
fn reading_the_same_week_twice_writes_nothing() {
    let bench = Bench::open("health-week");
    let first = bench.run("health.record_days", week(9_120.0));
    assert_eq!(first, json!({ "written": 28, "unchanged": 0 }));
    assert_eq!(bench.count("SELECT COUNT(*) FROM health_daily"), 28);
    // The subject is the vault's own party when the batch names none.
    let owner = common::owner_party(bench.vault()).expect("an owner");
    assert_eq!(
        bench.count(&format!(
            "SELECT COUNT(*) FROM health_daily WHERE subject_party_id = '{owner}'"
        )),
        28
    );

    let before = bench.state();
    let again = bench.run("health.record_days", week(9_120.0));
    assert_eq!(again, json!({ "written": 0, "unchanged": 28 }));
    assert_eq!(
        before,
        bench.state(),
        "a second read of the same week wrote"
    );
    assert_eq!(
        bench.count("SELECT COUNT(*) FROM health_daily WHERE row_version <> 1"),
        0
    );
}

#[test]
fn a_late_upload_moves_its_one_day_once() {
    let bench = Bench::open("health-late");
    bench.run("health.record_days", week(4_000.0));
    // The watch uploads late: the 19th's steps grow, nothing else moves.
    let late = bench.run("health.record_days", week(9_120.0));
    assert_eq!(late, json!({ "written": 1, "unchanged": 27 }));
    assert_eq!(
        bench.count(
            "SELECT COUNT(*) FROM health_daily
              WHERE day = '2026-10-19' AND metric = 'steps' AND value = 9120 AND row_version = 2"
        ),
        1
    );
    assert_eq!(
        bench.count("SELECT COUNT(*) FROM health_daily WHERE row_version <> 1"),
        1,
        "only the changed day moved"
    );
    // A sum the store now reports nothing for is sent as 0, and a day is never deleted.
    let cleared = bench.run(
        "health.record_days",
        json!({ "days": [{ "day": "2026-10-19", "metric": "steps", "value": 0 }] }),
    );
    assert_eq!(cleared, json!({ "written": 1, "unchanged": 0 }));
    assert_eq!(bench.count("SELECT COUNT(*) FROM health_daily"), 28);
}

#[test]
fn a_refused_batch_names_its_predicate_and_writes_nothing() {
    let bench = Bench::open("health-refuse");
    bench.run("health.record_days", week(9_120.0));
    let good = json!({ "day": "2026-10-20", "metric": "steps", "value": 10 });
    let batch = |bad: Value| json!({ "days": [good.clone(), bad] });

    for (bad, predicate) in [
        (
            json!({ "day": "2026-10-20", "metric": "heart_rate", "value": 1 }),
            "schema",
        ),
        (
            json!({ "day": "2026-10-20", "metric": "weight", "value": 1 }),
            "schema",
        ),
        (
            json!({ "day": "2026-10-20", "metric": "sleep_min", "value": -1 }),
            "schema",
        ),
        (
            json!({ "day": "20/10/2026", "metric": "sleep_min", "value": 1 }),
            "schema",
        ),
        (
            json!({ "day": "2026-02-30", "metric": "sleep_min", "value": 1 }),
            "days_are_calendar_days",
        ),
        (
            json!({ "day": "2026-10-20", "metric": "steps", "value": 11 }),
            "days_name_each_metric_once",
        ),
    ] {
        assert_eq!(
            bench.refused("health.record_days", batch(bad.clone())),
            predicate,
            "{bad}"
        );
    }
    assert_eq!(
        bench.refused(
            "health.record_days",
            json!({ "subject_party_id": "nobody", "days": [good] }),
        ),
        "days_subject_is_a_party"
    );
    assert_eq!(
        bench.count("SELECT COUNT(*) FROM health_daily WHERE day = '2026-10-20'"),
        0,
        "the good half of a refused batch did not land either"
    );
}

// ---------------------------------------------------------------------------
// 2. Workouts
// ---------------------------------------------------------------------------

#[test]
fn a_followed_workout_is_corrected_in_place_and_an_identical_follow_writes_nothing() {
    let bench = Bench::open("health-follow");
    let first = bench.run(
        "health.follow_workout",
        workout("wk-1", "run", Some(8_012.0)),
    );
    assert_eq!(
        first,
        json!({ "activity_id": "wk-1", "created": true, "changed": true })
    );
    let owner = common::owner_party(bench.vault()).expect("an owner");
    assert_eq!(
        bench.count(&format!(
            "SELECT COUNT(*) FROM core_activity
              WHERE activity_id = 'wk-1' AND actor_party_id = '{owner}'
                AND kind_concept_id = 'health:kind:run'
                AND started_at = '2026-10-19T07:00:00.000Z'
                AND ended_at = '2026-10-19T07:41:30.250Z'
                AND source_app_id IS NULL AND row_version = 1"
        )),
        1,
        "the activity is the self party's, its span in the vault's spelling"
    );
    assert_eq!(
        bench.count(
            "SELECT COUNT(*) FROM health_workout
              WHERE activity_id = 'wk-1' AND phone_kind = 'HKWorkoutActivityType.running'
                AND recorded_by = 'Apple Watch' AND moving_sec = 2400 AND distance_m = 8012
                AND energy_kcal = 412 AND avg_hr_bpm = 151 AND elevation_gain_m = 38.5"
        ),
        1
    );
    assert_eq!(
        bench.count("SELECT COUNT(*) FROM core_entity WHERE entity_id = 'wk-1'"),
        1
    );
    // It does not link itself: the engine does, through `phone.link`.
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_link"), 0);

    // IDENTICAL: nothing moves.
    let before = bench.state();
    let same = bench.run(
        "health.follow_workout",
        workout("wk-1", "run", Some(8_012.0)),
    );
    assert_eq!(same["changed"], json!(false));
    assert_eq!(before, bench.state());

    // CORRECTED: the watch synced late, and the activity's span and kind move with it.
    let mut corrected = workout("wk-1", "walk", Some(8_140.0));
    corrected["ended_at"] = json!("2026-10-19T07:45:00Z");
    let moved = bench.run("health.follow_workout", corrected);
    assert_eq!(
        moved,
        json!({ "activity_id": "wk-1", "created": false, "changed": true })
    );
    assert_eq!(
        bench.count(
            "SELECT COUNT(*) FROM core_activity WHERE activity_id = 'wk-1'
                AND kind_concept_id = 'health:kind:walk' AND row_version = 2"
        ),
        1
    );
    assert_eq!(
        bench.count(
            "SELECT COUNT(*) FROM health_workout WHERE activity_id = 'wk-1'
                AND distance_m = 8140 AND row_version = 2"
        ),
        1
    );
    // A measure the store stopped reporting is cleared, not kept from before.
    bench.run("health.follow_workout", {
        let mut gone = workout("wk-1", "walk", None);
        gone["ended_at"] = json!("2026-10-19T07:45:00Z");
        gone
    });
    assert_eq!(
        bench.count(
            "SELECT COUNT(*) FROM health_workout WHERE activity_id = 'wk-1'
                AND distance_m IS NULL AND row_version = 3"
        ),
        1
    );
}

#[test]
fn an_activity_that_is_not_a_workout_is_refused_and_so_is_a_span_that_runs_backwards() {
    let bench = Bench::open("health-not-a-workout");
    // A logged interaction is an activity with no workout row.
    let person = bench.run(
        "people.add_person",
        json!({ "display_name": "Ada", "cadence_days": 30 }),
    )["party_id"]
        .as_str()
        .expect("a party")
        .to_owned();
    bench.run(
        "people.log_interaction",
        json!({ "party_id": person, "kind": "call" }),
    );
    let interaction: String = bench
        .vault()
        .read(|connection| {
            Ok(
                connection.query_row("SELECT activity_id FROM core_activity", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .expect("the interaction");
    assert_eq!(
        bench.refused(
            "health.follow_workout",
            workout(&interaction, "run", Some(1.0))
        ),
        "workout_is_a_workout"
    );
    assert_eq!(
        bench.refused(
            "health.purge_workout",
            json!({ "activity_id": interaction })
        ),
        "workout_exists"
    );
    // An id another kind of row holds is not a workout either.
    assert_eq!(
        bench.refused("health.follow_workout", workout(&person, "run", Some(1.0))),
        "workout_is_a_workout"
    );
    let mut backwards = workout("wk-2", "run", Some(1.0));
    backwards["ended_at"] = json!("2026-10-19T06:00:00Z");
    assert_eq!(
        bench.refused("health.follow_workout", backwards),
        "workout_ends_after_it_starts"
    );
    let mut nonsense = workout("wk-3", "run", Some(1.0));
    nonsense["distance_m"] = json!(-4);
    assert_eq!(bench.refused("health.follow_workout", nonsense), "schema");
}

#[test]
fn a_kind_the_seed_does_not_name_is_minted_once_and_reused() {
    let bench = Bench::open("health-kinds");
    bench.run("health.follow_workout", workout("wk-1", "pilates", None));
    assert_eq!(
        bench.count("SELECT COUNT(*) FROM core_concept WHERE scheme_id = 'health:workout-kinds'"),
        9
    );
    bench.run("health.follow_workout", workout("wk-2", "pilates", None));
    assert_eq!(
        bench.count("SELECT COUNT(*) FROM core_concept WHERE scheme_id = 'health:workout-kinds'"),
        9,
        "the second use reuses the first's concept"
    );
    assert_eq!(
        bench.count(
            "SELECT COUNT(DISTINCT a.kind_concept_id) FROM core_activity a
               JOIN core_concept c ON c.concept_id = a.kind_concept_id
              WHERE c.notation = 'pilates' AND c.pref_label = 'pilates'"
        ),
        1
    );
    // A seeded kind is its fixed id, and never a second concept.
    bench.run("health.follow_workout", workout("wk-3", "swim", None));
    assert_eq!(
        bench
            .count("SELECT COUNT(*) FROM core_activity WHERE kind_concept_id = 'health:kind:swim'"),
        1
    );
}

// ---------------------------------------------------------------------------
// 3. The link and the purge
// ---------------------------------------------------------------------------

#[test]
fn a_purge_cascades_and_leaves_a_tombstone_that_phone_link_refuses() {
    let bench = Bench::open("health-purge");
    bench.run(
        "health.follow_workout",
        workout("wk-1", "run", Some(5_000.0)),
    );
    let origin = bench.origin();
    let link = |entity: &str, phone_id: &str| {
        json!({
            "source": "health", "phone_id": phone_id, "origin_id": origin,
            "entity_id": entity, "fingerprint": "fp-1",
        })
    };
    bench.run("phone.link", link("wk-1", "HKWorkout:1"));

    // A `health` link to an event is refused: a workout is an activity.
    let lunch = "evt-1";
    bench
        .vault()
        .commit(|tx| {
            tx.set_producer("test.health_commands");
            tx.connection().execute(
                "INSERT INTO core_event (event_id, summary, dtstart, start_tz, status, sequence, created_at)
                 VALUES (?1, 'Lunch', '2026-10-20T12:00:00Z', 'UTC', 'confirmed', 0, '2026-10-20T09:00:00.000Z')",
                [lunch],
            )?;
            Ok(())
        })
        .expect("an event");
    assert_eq!(
        bench.refused("phone.link", link(lunch, "HKWorkout:2")),
        "link_entity_is_live_and_of_the_sources_kind"
    );

    let purged = bench.run("health.purge_workout", json!({ "activity_id": "wk-1" }));
    assert_eq!(purged, json!({ "activity_id": "wk-1" }));
    for sql in [
        "SELECT COUNT(*) FROM core_activity",
        "SELECT COUNT(*) FROM health_workout",
        "SELECT COUNT(*) FROM core_entity WHERE entity_id = 'wk-1'",
    ] {
        assert_eq!(bench.count(sql), 0, "{sql}");
    }
    assert_eq!(
        bench.count(
            "SELECT COUNT(*) FROM phone_link WHERE phone_id = 'HKWorkout:1' AND entity_id IS NULL"
        ),
        1,
        "the link is left a tombstone"
    );
    // The purged workout does not come back on the next pass.
    bench.run(
        "health.follow_workout",
        workout("wk-9", "run", Some(5_000.0)),
    );
    assert_eq!(
        bench.refused("phone.link", link("wk-9", "HKWorkout:1")),
        "link_row_was_not_purged"
    );
    // And a purge of what is not there is refused, not a quiet success.
    assert_eq!(
        bench.refused("health.purge_workout", json!({ "activity_id": "wk-1" })),
        "workout_exists"
    );
}
