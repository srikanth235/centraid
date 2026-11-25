//! Health on the v0 tables (#1214): workouts, readings and daily totals, the health store followed
//! into both kinds, and what each read answers. The rules the database holds for these tables are
//! in `schema_rules.rs`; the earlier workout, measurement and CSV tests are rewritten here.

mod common;

use centraid_vault::commands::follow::differences;
use centraid_vault::commands::measurement::{self, Units};
use centraid_vault::commands::{reading, workout};
use centraid_vault::value::Value;
use common::world::World;
use serde_json::{Value as Json, json};

fn id_of(output: &Json, key: &str) -> String {
    output[key].as_str().expect("an id").to_owned()
}

fn person(w: &World, title: &str) -> String {
    id_of(&w.ok("person.add", json!({ "title": title })), "id")
}

fn owner(w: &World) -> String {
    w.one("SELECT self_id FROM vault", &[])
}

/// What these tests ask of a world beyond `common::world::World`.
trait Ask {
    fn count(&self, sql: &str) -> i64;
    fn count_where(&self, sql: &str, param: &str) -> i64;
    fn maybe<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> Option<T>;
    fn by_title(&self, kind: &str, title: &str) -> String;
    fn raw_result(&self, sql: &str) -> Result<(), String>;
    fn try_run(&self, name: &str, input: Json) -> Result<centraid_vault::CommandOutcome, String>;
}

impl Ask for World {
    fn count(&self, sql: &str) -> i64 {
        self.one(sql, &[])
    }
    fn count_where(&self, sql: &str, param: &str) -> i64 {
        if param.is_empty() {
            self.one(sql, &[])
        } else {
            self.one(sql, &[param])
        }
    }
    fn maybe<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> Option<T> {
        self.vault()
            .read(|c| {
                Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| {
                    r.get::<_, Option<T>>(0)
                })
                .ok()
                .flatten())
            })
            .expect("a read")
    }
    fn by_title(&self, kind: &str, title: &str) -> String {
        self.one(
            "SELECT id FROM entity WHERE kind = ?1 AND title = ?2 COLLATE NOCASE",
            &[kind, title],
        )
    }
    fn raw_result(&self, sql: &str) -> Result<(), String> {
        self.vault()
            .commit(|tx| {
                tx.connection().execute_batch(sql)?;
                Ok(())
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    fn try_run(&self, name: &str, input: Json) -> Result<centraid_vault::CommandOutcome, String> {
        self.scratch.clock.advance_ms(1_000);
        self.vault()
            .execute(
                &self.registry,
                &centraid_vault::Principal::owner("phone"),
                &centraid_vault::Command::new(name, input),
            )
            .map_err(|error| error.to_string())
    }
}

fn plan(w: &World, sql: &str) -> String {
    w.vault()
        .explain_query_plan(
            sql,
            &[
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
                Value::Null,
            ],
        )
        .expect("a plan")
        .join(" | ")
}

fn assert_walks(plan: &str, index: &str) {
    assert!(plan.contains(index), "{index} not in {plan}");
    assert!(!plan.contains("TEMP B-TREE"), "sorts after reading: {plan}");
    assert!(
        !plan
            .split(" | ")
            .any(|step| step.starts_with("SCAN") && !step.contains("USING")),
        "a table scan: {plan}"
    );
}

// ---------------------------------------------------------------------------------------------
// 1. Workouts
// ---------------------------------------------------------------------------------------------

#[test]
fn a_member_logs_a_workout_with_its_kind_place_notes_and_people_and_changes_it() {
    let w = World::new("health_workout");
    let ada = person(&w, "Ada");
    let bo = person(&w, "Bo");
    let park = w.mint();
    w.commit(|tx| {
        tx.insert_entity(
            &park,
            centraid_vault::model::Kind::Place,
            "The park",
            "2026-03-01T09:00:00.000Z",
        )?;
        tx.connection()
            .execute("INSERT INTO place (id) VALUES (?1)", [&park])?;
        Ok(())
    });
    let id = id_of(
        &w.ok(
            "workout.log",
            json!({
                "type": "run", "starts": "2026-03-04", "moving_s": 1_800, "distance_m": 5_000,
                "place_id": park, "notes": "felt good", "with": [ada]
            }),
        ),
        "workout_id",
    );
    // the raw rows: an entity of its own kind, a kind row, the kind of workout a concept, no source
    assert_eq!(
        w.one::<String>(
            "SELECT e.kind || '|' || e.title || '|' || k.type_id || '|' || k.type_kind || '|' || k.starts
                    || '|' || k.place_id || '|' || k.notes || '|' || k.moving_s || '|' || k.distance_m
               FROM entity e JOIN workout k ON k.id = e.id WHERE e.id = ?1",
            &[&id]
        ),
        format!("workout|Run|workout_kind:run|workout_kind|2026-03-04T00:00:00.000Z|{park}|felt good|1800|5000.0")
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('activity', 'type_kind')"),
        0
    );
    assert_eq!(
        w.strings(
            "SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'with'",
            &[&id]
        ),
        vec![ada.clone()]
    );
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM source WHERE entity_id = ?1", &id),
        0
    );
    // an edit changes figures, the title, the people and clears what is null
    w.ok(
        "workout.edit",
        json!({"id": id, "title": "Morning run", "distance_m": 5_500, "moving_s": null,
               "with": [bo], "notes": null, "type": "pilates"}),
    );
    assert_eq!(
        w.one::<String>(
            "SELECT e.title || '|' || k.distance_m || '|' || ifnull(k.moving_s, 'none') || '|' || ifnull(k.notes, 'none')
                    || '|' || k.type_id
               FROM entity e JOIN workout k ON k.id = e.id WHERE e.id = ?1",
            &[&id]
        ),
        format!("Morning run|5500.0|none|none|{}", w.by_title("workout_kind", "pilates"))
    );
    assert_eq!(
        w.strings(
            "SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'with'",
            &[&id]
        ),
        vec![bo.clone()]
    );
    // refusals in words
    assert!(
        w.refused(
            "workout.log",
            json!({"starts": "2026-03-04T08:00:00Z", "ends": "2026-03-04T07:00:00Z"})
        )
        .contains("cannot end before it starts")
    );
    assert!(
        w.refused("workout.log", json!({"starts": "last tuesday"}))
            .contains("is not a day or an instant")
    );
    assert!(
        w.refused(
            "workout.log",
            json!({"starts": "2026-03-04", "place_id": ada})
        )
        .contains("not a place")
    );
    assert!(
        w.refused(
            "workout.log",
            json!({"starts": "2026-03-04", "with": [park]})
        )
        .contains("not a person")
    );
    let long = "x".repeat(workout::NOTES_BUDGET_BYTES + 1);
    assert!(
        w.refused(
            "workout.log",
            json!({"starts": "2026-03-04", "notes": long})
        )
        .contains("budget")
    );
    // the shared verbs: trash, restore, delete forever
    w.ok("entity.trash", json!({"id": id}));
    assert!(
        w.refused("workout.edit", json!({"id": id, "title": "x"}))
            .contains("trash")
    );
    w.ok("entity.restore", json!({"id": id}));
    w.ok("entity.trash", json!({"id": id}));
    w.ok("entity.purge", json!({"id": id}));
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM workout WHERE id = ?1", &id),
        0
    );
}

#[test]
fn whole_measures_take_integer_valued_floats_on_log_and_edit() {
    let w = World::new("health_whole");
    for (moving, heart) in [(json!(1800), json!(142)), (json!(1800.0), json!(142.0))] {
        let id = id_of(
            &w.ok("workout.log", json!({"type": "run", "starts": "2026-03-04", "moving_s": moving, "heart_bpm": heart})),
            "workout_id",
        );
        let read = |id: &str| -> (Option<i64>, Option<i64>) {
            (
                w.maybe("SELECT moving_s FROM workout WHERE id = ?1", &[id]),
                w.maybe("SELECT heart_bpm FROM workout WHERE id = ?1", &[id]),
            )
        };
        assert_eq!(read(&id), (Some(1800), Some(142)));
        w.ok(
            "workout.edit",
            json!({"id": id, "moving_s": 1900, "heart_bpm": 150}),
        );
        assert_eq!(read(&id), (Some(1900), Some(150)));
        w.ok("workout.edit", json!({"id": id, "heart_bpm": null}));
        assert_eq!(read(&id), (Some(1900), None));
    }
}

#[test]
fn what_happened_on_a_day_spans_workouts_and_touches_by_an_index_walk() {
    let w = World::new("health_day");
    let ada = person(&w, "Ada");
    w.ok(
        "workout.log",
        json!({"type": "run", "starts": "2026-03-04T07:00:00Z", "distance_m": 5_300}),
    );
    w.ok(
        "workout.log",
        json!({"type": "walk", "starts": "2026-03-05T07:00:00Z"}),
    );
    let gone = id_of(
        &w.ok(
            "workout.log",
            json!({"type": "swim", "starts": "2026-03-04T09:00:00Z"}),
        ),
        "id",
    );
    w.ok("entity.trash", json!({"id": gone}));
    w.ok(
        "touch.log",
        json!({"people": [ada], "kind": "Call", "starts": "2026-03-04T08:00:00Z"}),
    );
    let (from, to) = ("2026-03-04T00:00:00.000Z", "2026-03-05T00:00:00.000Z");
    let day = w
        .vault()
        .read(|c| workout::what_happened(c, from, to, Units::Imperial))
        .expect("a day");
    assert_eq!(day.workouts.len(), 1);
    assert_eq!(day.workouts[0].kind, "Run");
    assert_eq!(day.workouts[0].distance.as_deref(), Some("3.3 mi"));
    assert_eq!(day.touches.len(), 1);
    assert_walks(&plan(&w, workout::ON_DAY_SQL), "workout_by_start");
    assert_walks(&plan(&w, workout::TOUCHES_ON_DAY_SQL), "touch_by_start");
}

// ---------------------------------------------------------------------------------------------
// 2, 3. Readings and their guards
// ---------------------------------------------------------------------------------------------

#[test]
fn a_reading_is_added_edited_trashed_restored_and_deleted_forever() {
    let w = World::new("health_reading");
    let id = id_of(
        &w.ok("reading.add", json!({"metric": "weight_kg", "at": "2026-03-04T07:00:00Z", "value": 72.4, "context": "fasting"})),
        "reading_id",
    );
    assert_eq!(
        w.one::<String>(
            "SELECT e.kind || '|' || e.title || '|' || r.person_id || '|' || r.metric || '|' || r.value
                    || '|' || ifnull(r.value2, 'none') || '|' || r.context
               FROM entity e JOIN reading r ON r.id = e.id WHERE e.id = ?1",
            &[&id]
        ),
        format!("reading||{}|weight_kg|72.4|none|fasting", owner(&w))
    );
    // the second figure only where the metric has one; a total's metric is no reading
    let bp = id_of(
        &w.ok("reading.add", json!({"metric": "blood_pressure", "at": "2026-03-04T07:01:00Z", "value": 120, "value2": 80})),
        "id",
    );
    assert!(
        w.refused(
            "reading.add",
            json!({"metric": "blood_pressure", "at": "2026-03-04T07:01:00Z", "value": 120})
        )
        .contains("two figures")
    );
    assert!(
        w.refused(
            "reading.add",
            json!({"metric": "weight_kg", "at": "2026-03-04T07:01:00Z", "value": 70, "value2": 1})
        )
        .contains("one figure")
    );
    assert!(
        w.refused(
            "reading.add",
            json!({"metric": "steps", "at": "2026-03-04T07:01:00Z", "value": 70})
        )
        .contains("daily total")
    );
    assert!(
        w.refused(
            "reading.add",
            json!({"metric": "mood", "at": "2026-03-04T07:01:00Z", "value": 1})
        )
        .contains("not a figure")
    );
    assert!(
        w.refused(
            "reading.add",
            json!({"metric": "weight_kg", "at": "yesterday", "value": 1})
        )
        .contains("not a day")
    );
    // a negative value is a reading too
    w.ok(
        "reading.add",
        json!({"metric": "glucose_mmol", "at": "2026-03-04T07:02:00Z", "value": -1.5}),
    );
    // edit: the figure, the moment, the context
    w.ok(
        "reading.edit",
        json!({"id": id, "value": 72.0, "context": null}),
    );
    w.ok("reading.edit", json!({"id": bp, "value2": 85}));
    assert!(
        w.refused("reading.edit", json!({"id": bp, "value2": null}))
            .contains("two figures")
    );
    assert_eq!(
        w.count_where(
            "SELECT CAST(value AS INTEGER) FROM reading WHERE id = ?1",
            &id
        ),
        72
    );
    assert_eq!(
        w.maybe::<String>("SELECT context FROM reading WHERE id = ?1", &[&id]),
        None
    );
    // earlier versions: the edit kept the reading as it was
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &id),
        1
    );
    w.ok("history.restore_version", json!({"id": id, "seq": 1}));
    assert_eq!(
        w.maybe::<f64>("SELECT value FROM reading WHERE id = ?1", &[&id]),
        Some(72.4)
    );
    // trash, restore, delete forever
    w.ok("entity.trash", json!({"id": id}));
    assert!(
        w.refused("reading.edit", json!({"id": id, "value": 1}))
            .contains("trash")
    );
    w.ok("entity.restore", json!({"id": id}));
    w.ok("entity.trash", json!({"id": id}));
    w.ok("entity.purge", json!({"id": id}));
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM reading WHERE id = ?1", &id),
        0
    );
}

#[test]
fn a_reading_has_no_title_cannot_be_linked_or_tagged_or_found() {
    let w = World::new("health_guards");
    let id = id_of(
        &w.ok(
            "reading.add",
            json!({"metric": "weight_kg", "at": "2026-03-04T07:00:00Z", "value": 72.4}),
        ),
        "id",
    );
    let note = id_of(
        &w.ok(
            "note.create",
            json!({"title": "Weigh-ins", "body": "see [[72.4 kg]] and [[]]"}),
        ),
        "id",
    );
    // an empty title, and the database refuses a name
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        ""
    );
    assert!(
        w.raw_result(&format!(
            "UPDATE entity SET title = '72.4 kg' WHERE id = '{id}'"
        ))
        .is_err()
    );
    // not a link end, not a mention target, no tag
    assert!(
        w.try_run("link.add", json!({"a": note, "b": id}))
            .map_or(true, |o| o.status
                != centraid_vault::CommandStatus::Executed)
    );
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM mention WHERE to_id = ?1", &id),
        0
    );
    assert!(
        w.try_run("tag.add", json!({"id": id, "label": "health"}))
            .map_or(true, |o| o.status
                != centraid_vault::CommandStatus::Executed)
    );
    assert_eq!(
        w.count_where(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 OR to_id = ?1",
            &id
        ),
        0
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT linkable FROM entity_kind WHERE code = 'reading'",
            &[]
        ),
        0
    );
    // never owed to the index, never in search or search_past
    let n: i64 = w.one("SELECT n FROM entity WHERE id = ?1", &[&id]);
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM search_owed WHERE n = ?1",
            &[&n.to_string()]
        ),
        0
    );
    w.ok("reading.edit", json!({"id": id, "value": 73}));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM search_owed WHERE n = ?1",
            &[&n.to_string()]
        ),
        0
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM search WHERE rowid = ?1",
            &[&n.to_string()]
        ),
        0
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM search_past WHERE rowid = ?1",
            &[&n.to_string()]
        ),
        0
    );
}

// ---------------------------------------------------------------------------------------------
// 4. Daily totals
// ---------------------------------------------------------------------------------------------

#[test]
fn a_day_has_one_total_set_by_hand_corrected_or_taken_back() {
    let w = World::new("health_totals");
    w.ok(
        "measurement.log",
        json!({"day": "2026-03-04", "metric": "steps", "value": 8000}),
    );
    w.ok(
        "measurement.log",
        json!({"id": "2026-03-04:steps", "value": 9000}),
    );
    assert_eq!(w.count_where("SELECT COUNT(*) FROM measurement", ""), 1);
    assert_eq!(
        w.count_where("SELECT CAST(value AS INTEGER) FROM measurement", ""),
        9000
    );
    assert_eq!(
        w.maybe::<String>("SELECT origin_id FROM measurement", &[]),
        None
    );
    // a reading's metric is no total; a day is a day; `mood` is nothing Health keeps
    assert!(
        w.refused(
            "measurement.log",
            json!({"day": "2026-03-04", "metric": "weight_kg", "value": 70})
        )
        .contains("reading")
    );
    assert!(
        w.refused(
            "measurement.log",
            json!({"day": "2026-02-30", "metric": "steps", "value": 1})
        )
        .contains("not a calendar day")
    );
    assert!(
        w.refused(
            "measurement.log",
            json!({"day": "2026-03-04", "metric": "mood", "value": 1})
        )
        .contains("not a figure")
    );
    let cleared = w.ok("measurement.clear", json!({"id": "2026-03-04:steps"}));
    assert_eq!(cleared["id"], "2026-03-04:steps");
    assert_eq!(w.count_where("SELECT COUNT(*) FROM measurement", ""), 0);
    assert_eq!(
        w.refused(
            "measurement.clear",
            json!({"day": "2026-03-04", "metric": "steps"})
        ),
        "There is no steps figure for 2026-03-04."
    );
}

fn record(w: &World, device: &str, cursor: Option<&str>, days: Json) -> Json {
    let mut origin = json!({"system": "health", "ref": "store:apple-health", "device_id": device});
    if let Some(cursor) = cursor {
        origin["cursor"] = json!(cursor);
    }
    w.ok(
        "measurement.record",
        json!({"origin": origin, "days": days}),
    )
}

#[test]
fn a_health_store_writes_totals_once_and_a_hand_figure_waits_for_the_store_to_stop() {
    let w = World::new("health_record");
    let days = json!([
        {"day": "2026-03-01", "metric": "steps", "value": 8000},
        {"day": "2026-03-01", "metric": "sleep_min", "value": 410},
        {"day": "2026-03-02", "metric": "steps", "value": 9100},
    ]);
    let first = record(&w, "phone-a", Some("anchor-1"), days.clone());
    assert_eq!(
        (first["written"].as_i64(), first["unchanged"].as_i64()),
        (Some(3), Some(0))
    );
    let origin: String = w.one("SELECT id FROM origin WHERE system = 'health'", &[]);
    assert_eq!(
        w.one::<String>("SELECT cursor FROM origin WHERE id = ?1", &[&origin]),
        "anchor-1"
    );
    assert_eq!(
        w.count_where(
            "SELECT COUNT(*) FROM measurement WHERE origin_id = ?1",
            &origin
        ),
        3
    );
    let second = record(&w, "phone-a", None, days);
    assert_eq!(
        (second["written"].as_i64(), second["unchanged"].as_i64()),
        (Some(0), Some(3))
    );
    // a correction overwrites the day's figure
    let changed = record(
        &w,
        "phone-a",
        None,
        json!([{"day": "2026-03-01", "metric": "steps", "value": 0}]),
    );
    assert_eq!(changed["written"], 1);
    assert_eq!(w.count_where("SELECT CAST(value AS INTEGER) FROM measurement WHERE day = '2026-03-01' AND metric = 'steps'", ""), 0);
    // a stream cannot get in: a day and metric stated twice, a reading's metric, a bad day, a nobody
    let again = json!({"origin": {"system": "health", "ref": "store:apple-health"}});
    let with = |days: Json| {
        let mut input = again.clone();
        input["days"] = days;
        input
    };
    assert!(w.refused("measurement.record", with(json!([{"day": "2026-03-01", "metric": "steps", "value": 1}, {"day": "2026-03-01", "metric": "steps", "value": 2}]))).contains("stated twice"));
    assert!(
        w.refused(
            "measurement.record",
            with(json!([{"day": "2026-03-01", "metric": "weight_kg", "value": 1}]))
        )
        .contains("reading")
    );
    assert!(
        w.refused(
            "measurement.record",
            with(json!([{"day": "2026-02-30", "metric": "steps", "value": 1}]))
        )
        .contains("not a calendar day")
    );
    let mut nobody = with(json!([{"day": "2026-03-01", "metric": "steps", "value": 1}]));
    nobody["person_id"] = json!("nobody");
    assert!(
        w.refused("measurement.record", nobody)
            .contains("no such person")
    );
    // while the store is followed its figures are not typed over; once stopped they are the member's
    assert_eq!(
        w.refused(
            "measurement.log",
            json!({"day": "2026-03-05", "metric": "steps", "value": 9000})
        ),
        format!(
            "These figures come from {}; change them there, not here.",
            "store:apple-health"
        )
    );
    w.ok(
        "follow.stop",
        json!({"system": "health", "ref": "store:apple-health"}),
    );
    w.ok(
        "measurement.log",
        json!({"day": "2026-03-01", "metric": "steps", "value": 1234}),
    );
    assert_eq!(
        w.maybe::<String>(
            "SELECT origin_id FROM measurement WHERE day = '2026-03-01' AND metric = 'steps'",
            &[]
        ),
        None
    );
    w.ok("measurement.clear", json!({"id": "2026-03-02:steps"}));
}

// ---------------------------------------------------------------------------------------------
// 5. Following the health store
// ---------------------------------------------------------------------------------------------

fn run(external: &str, kind: &str, starts: &str, distance: f64) -> Json {
    json!({
        "external_id": external,
        "fields": {
            "kind": kind, "starts": starts, "ends": format!("{}07:45:00Z", &starts[..11]),
            "recorded_by": "Watch", "moving_s": 2_700, "distance_m": distance, "heart_bpm": 148,
        }
    })
}

fn weight(external: &str, at: &str, kilos: f64) -> Json {
    json!({"external_id": external, "fields": {"metric": "weight_kg", "at": at, "value": kilos}})
}

fn pass(w: &World, command: &str, device: &str, records: &[Json], complete: bool) -> Json {
    let records: Vec<Json> = records
        .iter()
        .map(|record| {
            let mut record = record.clone();
            record["device_id"] = json!(device);
            record
        })
        .collect();
    w.ok(
        command,
        json!({
            "origin": {"ref": "store:apple-health", "label": "Apple Health", "device_id": device},
            "records": records, "complete": complete,
        }),
    )
}

fn source_of(w: &World, external: &str) -> String {
    w.one(
        "SELECT entity_id FROM source WHERE external_id = ?1",
        &[external],
    )
}

#[test]
fn a_health_pass_makes_workouts_and_readings_and_a_totals_batch_names_the_same_store() {
    let w = World::new("health_follow");
    let added = pass(
        &w,
        "follow.health",
        "phone-a",
        &[run("w:1", "run", "2026-03-04T07:00:00Z", 5_234.5)],
        false,
    );
    assert_eq!(added["added"], 1);
    let id = source_of(&w, "w:1");
    assert_eq!(
        w.one::<String>(
            "SELECT k.type_id || ' ' || k.starts || ' ' || e.title || ' ' || k.recorded_by || ' ' || k.moving_s || ' ' || k.distance_m
               FROM workout k JOIN entity e ON e.id = k.id WHERE k.id = ?1",
            &[&id]
        ),
        "workout_kind:run 2026-03-04T07:00:00.000Z Run Watch 2700 5234.5"
    );
    let bp = json!({"external_id": "r:2", "fields": {"metric": "blood_pressure", "at": "2026-03-04T07:30:00Z", "value": 120, "value2": 80, "context": "sitting"}});
    let read = pass(
        &w,
        "follow.health_readings",
        "phone-a",
        &[weight("r:1", "2026-03-04T06:00:00Z", 72.4), bp],
        false,
    );
    assert_eq!(read["added"], 2);
    let reading_id = source_of(&w, "r:2");
    assert_eq!(
        w.one::<String>("SELECT e.kind || '|' || e.title || '|' || r.person_id || '|' || r.value2 || '|' || r.context FROM reading r JOIN entity e ON e.id = r.id WHERE r.id = ?1", &[&reading_id]),
        format!("reading||{}|80.0|sitting", owner(&w))
    );
    // a record the vault cannot keep is counted, not written
    let bad = pass(
        &w,
        "follow.health_readings",
        "phone-a",
        &[
            weight("r:9", "2026-03-04T06:00:00Z", 1.0),
            json!({"external_id": "r:8", "fields": {"metric": "steps", "at": "2026-03-04T06:00:00Z", "value": 1}}),
        ],
        false,
    );
    assert_eq!(bad["refused"], 1);
    // the totals come in as the same store's
    record(
        &w,
        "phone-a",
        None,
        json!([{"day": "2026-03-04", "metric": "steps", "value": 8000}]),
    );
    let store: String = w.one("SELECT id FROM origin WHERE system = 'health'", &[]);
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM origin WHERE system = 'health'", ""),
        1
    );
    assert_eq!(
        w.count_where(
            "SELECT COUNT(*) FROM measurement WHERE origin_id = ?1",
            &store
        ),
        1
    );
    // a later pass changes the row as the store: its revision says so, naming the origin
    pass(
        &w,
        "follow.health",
        "phone-a",
        &[run("w:1", "run", "2026-03-04T07:00:00Z", 5_300.0)],
        false,
    );
    assert_eq!(
        w.one::<String>("SELECT actor || ':' || ifnull(origin_id, '') FROM revision WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1", &[&id]),
        format!("store:{store}")
    );
    // no figure of a kind a system does not yield
    assert!(w.try_run("follow.health", json!({"origin": {"ref": "x", "label": "x", "device_id": "d"}, "records": [], "complete": false})).is_ok());
}

#[test]
fn a_member_edit_of_a_followed_workout_and_reading_is_kept_and_the_phone_says_its_figure() {
    let w = World::new("health_follow_edit");
    pass(
        &w,
        "follow.health",
        "phone-a",
        &[run("w:1", "run", "2026-03-04T07:00:00Z", 5_000.0)],
        false,
    );
    pass(
        &w,
        "follow.health_readings",
        "phone-a",
        &[weight("r:1", "2026-03-04T06:00:00Z", 72.4)],
        false,
    );
    let (workout_id, reading_id) = (source_of(&w, "w:1"), source_of(&w, "r:1"));
    // editing a followed row is not refused (L6)
    w.ok(
        "workout.edit",
        json!({"id": workout_id, "title": "Mine", "distance_m": 4_000}),
    );
    w.ok("reading.edit", json!({"id": reading_id, "value": 73.0}));
    let says = w
        .vault()
        .read(|c| differences(c, &workout_id))
        .expect("differences");
    let fields: Vec<&str> = says.iter().map(|d| d.field.as_str()).collect();
    assert!(
        fields.contains(&"title") && fields.contains(&"distance_m"),
        "{fields:?}"
    );
    let distance = says
        .iter()
        .find(|d| d.field == "distance_m")
        .expect("distance");
    assert_eq!(
        (distance.stated.as_f64(), distance.held.as_f64()),
        (Some(5_000.0), Some(4_000.0))
    );
    let says = w
        .vault()
        .read(|c| differences(c, &reading_id))
        .expect("differences");
    assert_eq!(says.len(), 1);
    assert_eq!(says[0].stated.as_f64(), Some(72.4));
    // the phone states more: the member's figure stands, an untouched one follows the phone
    let mut longer = run("w:1", "run", "2026-03-04T07:00:00Z", 5_300.0);
    longer["fields"]["moving_s"] = json!(3_000);
    pass(&w, "follow.health", "phone-a", &[longer], false);
    assert_eq!(
        w.maybe::<f64>(
            "SELECT distance_m FROM workout WHERE id = ?1",
            &[&workout_id]
        ),
        Some(4_000.0)
    );
    assert_eq!(
        w.maybe::<i64>("SELECT moving_s FROM workout WHERE id = ?1", &[&workout_id]),
        Some(3_000)
    );
    pass(
        &w,
        "follow.health_readings",
        "phone-a",
        &[weight("r:1", "2026-03-04T06:00:00Z", 72.9)],
        false,
    );
    assert_eq!(
        w.maybe::<f64>("SELECT value FROM reading WHERE id = ?1", &[&reading_id]),
        Some(73.0)
    );
}

#[test]
fn a_workout_gone_from_the_phone_stays_and_is_found_again_by_kind_and_minute() {
    let w = World::new("health_follow_gone");
    let (a, b) = (
        run("w:1", "run", "2026-03-04T07:00:00Z", 5_000.0),
        run("w:2", "swim", "2026-03-05T07:00:00Z", 1_000.0),
    );
    pass(&w, "follow.health", "phone-a", &[a.clone(), b], false);
    let swim = source_of(&w, "w:2");
    let read = pass(&w, "follow.health", "phone-a", &[a], true);
    assert_eq!(
        (read["forgotten"].as_i64(), read["trashed"].as_i64()),
        (Some(1), Some(0))
    );
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM source WHERE entity_id = ?1", &swim),
        0
    );
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM entity WHERE kind = 'workout'", ""),
        2
    );
    // a new phone, new ids, a start seconds off: the same rows
    let met = pass(
        &w,
        "follow.health",
        "phone-b",
        &[run("w:901", "swim", "2026-03-05T07:00:10Z", 1_000.0)],
        false,
    );
    assert_eq!(
        (met["matched"].as_i64(), met["added"].as_i64()),
        (Some(1), Some(0))
    );
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM entity WHERE kind = 'workout'", ""),
        2
    );
    // a reading gone from a complete read is kept too
    pass(
        &w,
        "follow.health_readings",
        "phone-b",
        &[weight("r:1", "2026-03-04T06:00:00Z", 72.4)],
        false,
    );
    pass(&w, "follow.health_readings", "phone-b", &[], true);
    assert_eq!(w.count_where("SELECT COUNT(*) FROM reading", ""), 1);
    assert_eq!(
        w.count_where(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &source_gone(&w)
        ),
        0
    );
}

fn source_gone(w: &World) -> String {
    w.one("SELECT id FROM entity WHERE kind = 'reading'", &[])
}

#[test]
fn a_watch_sync_adopts_the_workout_the_member_logged_and_keeps_their_figure() {
    let w = World::new("health_follow_adopt");
    let id = id_of(
        &w.ok(
            "workout.log",
            json!({"type": "run", "starts": "2026-03-04T07:00:00Z", "distance_m": 4_000}),
        ),
        "id",
    );
    pass(
        &w,
        "follow.health",
        "phone-a",
        &[run("w:1", "run", "2026-03-04T07:00:00Z", 5_000.0)],
        false,
    );
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM entity WHERE kind = 'workout'", ""),
        1
    );
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM source WHERE entity_id = ?1", &id),
        1
    );
    assert_eq!(
        w.maybe::<f64>("SELECT distance_m FROM workout WHERE id = ?1", &[&id]),
        Some(4_000.0)
    );
}

#[test]
fn the_health_store_followed_again_after_stop_adds_nothing_twice() {
    let w = World::new("health_follow_stop");
    pass(
        &w,
        "follow.health",
        "phone-a",
        &[run("w:1", "run", "2026-03-04T07:00:00Z", 5_000.0)],
        false,
    );
    w.ok(
        "follow.stop",
        json!({"system": "health", "ref": "store:apple-health"}),
    );
    assert!(w.refused("measurement.record", json!({"origin": {"system": "health", "ref": "store:apple-health"}, "days": [{"day": "2026-03-04", "metric": "steps", "value": 1}]})).contains("not followed"));
    let again = pass(
        &w,
        "follow.health",
        "phone-b",
        &[run("w:1", "run", "2026-03-04T07:00:00Z", 5_000.0)],
        false,
    );
    assert_eq!(again["added"], 0);
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM entity WHERE kind = 'workout'", ""),
        1
    );
}

// ---------------------------------------------------------------------------------------------
// 6. Reads
// ---------------------------------------------------------------------------------------------

#[test]
fn the_reads_are_bounded_index_walks_formatted_in_the_members_units() {
    let w = World::new("health_reads");
    let me = owner(&w);
    for (day, steps) in [
        ("2026-03-01", 1000),
        ("2026-03-02", 2000),
        ("2026-03-03", 3000),
    ] {
        w.ok(
            "measurement.log",
            json!({"day": day, "metric": "steps", "value": steps}),
        );
    }
    w.ok(
        "measurement.log",
        json!({"day": "2026-03-02", "metric": "sleep_min", "value": 400}),
    );
    let trend = w
        .vault()
        .read(|c| measurement::trend(c, &me, "steps", "2026-03-02", "2026-03-31", Units::Metric))
        .expect("a trend");
    assert_eq!(
        trend.iter().map(|p| p.day.as_str()).collect::<Vec<_>>(),
        ["2026-03-02", "2026-03-03"]
    );
    assert_eq!(trend[0].shown, "2000");
    let day = w
        .vault()
        .read(|c| measurement::totals_on(c, &me, "2026-03-02", Units::Metric))
        .expect("a day");
    assert_eq!(
        day.iter().map(|p| p.metric.as_str()).collect::<Vec<_>>(),
        ["sleep_min", "steps"]
    );
    for (at, kilos) in [
        ("2026-03-01T07:00:00Z", 72.4),
        ("2026-03-03T07:00:00Z", 71.0),
    ] {
        w.ok(
            "reading.add",
            json!({"metric": "weight_kg", "at": at, "value": kilos}),
        );
    }
    let newest = id_of(
        &w.ok(
            "reading.add",
            json!({"metric": "weight_kg", "at": "2026-03-05T07:00:00Z", "value": 70.0}),
        ),
        "id",
    );
    w.ok("reading.add", json!({"metric": "blood_pressure", "at": "2026-03-05T07:00:00Z", "value": 120, "value2": 80}));
    w.ok("entity.trash", json!({"id": newest}));
    let latest = w
        .vault()
        .read(|c| reading::latest(c, &me, Units::Imperial))
        .expect("latest");
    assert_eq!(
        latest.keys().map(String::as_str).collect::<Vec<_>>(),
        ["blood_pressure", "weight_kg"]
    );
    assert_eq!(latest["weight_kg"].shown, "156.5 lb");
    assert_eq!(latest["blood_pressure"].shown, "120/80 mmHg");
    let over = w
        .vault()
        .read(|c| {
            reading::over_time(
                c,
                &me,
                "weight_kg",
                "2026-03-01T00:00:00.000Z",
                "2026-04-01T00:00:00.000Z",
                Units::Metric,
            )
        })
        .expect("over time");
    assert_eq!(
        over.iter().map(|r| r.shown.as_str()).collect::<Vec<_>>(),
        ["72.4 kg", "71 kg"]
    );
    // each is an index walk
    assert_walks(&plan(&w, measurement::TREND_SQL), "m USING PRIMARY KEY");
    assert_walks(&plan(&w, measurement::TOTALS_ON_SQL), "PRIMARY KEY");
    assert_walks(&plan(&w, reading::OVER_TIME_SQL), "reading_by_");
    assert_walks(&plan(&w, reading::LATEST_SQL), "reading_by_");
}

// ---------------------------------------------------------------------------------------------
// 7. Export, and earlier versions
// ---------------------------------------------------------------------------------------------

fn file(w: &World, input: Json) -> (Json, String) {
    let out = w.ok("health.export_csv", input);
    let text = String::from_utf8(
        base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            out["content"].as_str().expect("content"),
        )
        .expect("base64"),
    )
    .expect("utf8");
    (out, text)
}

#[test]
fn health_exports_totals_readings_and_workouts_as_csv_and_leaves_the_trash_out() {
    let w = World::new("health_csv");
    let ada = person(&w, "Ada");
    w.ok(
        "measurement.log",
        json!({"day": "2026-03-04", "metric": "steps", "value": 8000}),
    );
    let (out, text) = file(&w, json!({"what": "measurements"}));
    assert_eq!(out["name"], "Daily totals.csv");
    assert_eq!(
        text,
        "Date,Metric,Value,Unit\r\n2026-03-04,Steps,8000,count\r\n"
    );
    let (out, _) = file(&w, json!({"what": "measurements", "metric": "steps"}));
    assert_eq!(out["name"], "Steps by day.csv");
    let kept = id_of(&w.ok("reading.add", json!({"metric": "blood_pressure", "at": "2026-03-04T07:00:00Z", "value": 120, "value2": 80, "context": "after a meal, seated"})), "id");
    let dropped = id_of(
        &w.ok(
            "reading.add",
            json!({"metric": "weight_kg", "at": "2026-03-04T08:00:00Z", "value": 70}),
        ),
        "id",
    );
    w.ok("entity.trash", json!({"id": dropped}));
    let (out, text) = file(&w, json!({"what": "readings"}));
    assert_eq!(out["count"], 1);
    assert_eq!(
        text,
        "Time,Metric,Value,Second value,Unit,Context\r\n2026-03-04T07:00:00+00:00,Blood pressure,120,80,mmHg,\"after a meal, seated\"\r\n"
    );
    let _ = kept;
    assert!(
        w.refused(
            "health.export_csv",
            json!({"what": "readings", "metric": "steps"})
        )
        .contains("daily total")
    );
    assert!(
        w.refused(
            "health.export_csv",
            json!({"what": "measurements", "metric": "mood"})
        )
        .contains("not a figure")
    );
    let walk = id_of(&w.ok("workout.log", json!({"type": "run", "title": "=Run, fast", "starts": "2026-03-04T07:00:00Z", "ends": "2026-03-04T07:45:00Z", "distance_m": 5300, "with": [ada], "notes": "good"})), "id");
    let gone = id_of(
        &w.ok(
            "workout.log",
            json!({"type": "walk", "starts": "2026-03-05T07:00:00Z"}),
        ),
        "id",
    );
    w.ok("entity.trash", json!({"id": gone}));
    let (out, text) = file(&w, json!({"what": "workouts"}));
    assert_eq!(
        (out["count"].as_i64(), out["name"].as_str()),
        (Some(1), Some("Workouts.csv"))
    );
    assert!(text.contains("'=Run"), "{text}");
    assert!(
        text.contains("Ada") && text.contains("good") && text.contains("5300"),
        "{text}"
    );
    let (out, _) = file(&w, json!({"what": "workouts", "id": walk}));
    assert!(
        out["name"]
            .as_str()
            .expect("name")
            .ends_with("2026-03-04.csv")
    );
    // nothing was written
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &walk),
        0
    );
}

#[test]
fn a_workout_keeps_its_earlier_versions_and_gives_one_back() {
    let w = World::new("health_versions");
    let id = id_of(&w.ok("workout.log", json!({"type": "run", "starts": "2026-03-04T07:00:00Z", "distance_m": 5_000, "notes": "first"})), "id");
    w.ok(
        "workout.edit",
        json!({"id": id, "distance_m": 6_000, "notes": "second"}),
    );
    assert_eq!(
        w.count_where("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &id),
        1
    );
    w.ok("history.restore_version", json!({"id": id, "seq": 1}));
    assert_eq!(
        w.one::<String>(
            "SELECT distance_m || '|' || notes FROM workout WHERE id = ?1",
            &[&id]
        ),
        "5000.0|first"
    );
}

// ---------------------------------------------------------------------------------------------
// 8. No raw sensor stream
// ---------------------------------------------------------------------------------------------

#[test]
fn no_table_or_command_stores_a_raw_sensor_stream() {
    let w = World::new("health_no_stream");
    // The only tables that hold a metric are a day's total (one row per person, day and metric) and a
    // reading (one entity each, never a batch): a series has nowhere to go.
    assert_eq!(
        w.strings(
            "SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
              WHERE m.type = 'table' AND c.name = 'metric' ORDER BY m.name",
            &[]
        ),
        ["measurement", "reading"]
    );
    assert_eq!(
        w.strings(
            "SELECT name FROM pragma_table_info('measurement') WHERE pk > 0 ORDER BY pk",
            &[]
        ),
        ["person_id", "day", "metric"]
    );
    // no command takes a series: the only batch is a store's daily totals, each named once
    let registry = centraid_vault::commands::Registry::with_system_commands().expect("registry");
    for name in registry.names().into_iter().filter(|name| {
        [
            "health.",
            "measurement.",
            "reading.",
            "workout.",
            "follow.health",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    }) {
        let schema = registry.get(name).expect("a command").schema().to_string();
        assert!(
            !schema.contains("samples") && !schema.contains("series"),
            "{name}"
        );
    }
    let samples: Vec<Json> = (0..1_000)
        .map(|_| json!({"day": "2026-03-04", "metric": "highest_hr_bpm", "value": 90}))
        .collect();
    record(&w, "phone-a", Some("anchor-1"), json!([]));
    assert!(
        w.refused(
            "measurement.record",
            json!({"origin": {"system": "health", "ref": "store:apple-health"}, "days": samples})
        )
        .contains("stated twice")
    );
    assert_eq!(w.count_where("SELECT COUNT(*) FROM measurement", ""), 0);
}

// ---------------------------------------------------------------------------------------------
// 9. The store's cursor, and taking what the phone says
// ---------------------------------------------------------------------------------------------

const STORE: &str = "store:apple-health";

fn cursor(w: &World, device: &str) -> Option<String> {
    w.vault()
        .read(|c| centraid_vault::commands::origin_cursor::read(c, "health", STORE, device))
        .expect("a read")
}

fn at_hour(id: &str, hour: u32) -> Json {
    json!({ "external_id": format!("local:{id}"), "device_id": "phone-a", "fields": {
        "kind": "run",
        "starts": format!("2026-03-02T{hour:02}:00:00.000Z"),
        "ends": format!("2026-03-02T{hour:02}:30:00.000Z") } })
}

fn pass_with(w: &World, device: &str, records: Json, extra: Json) -> Json {
    let mut input = json!({
        "origin": { "ref": STORE, "label": "Apple Health", "device_id": device },
        "records": records,
    });
    for (name, value) in extra.as_object().cloned().unwrap_or_default() {
        if name == "cursor" {
            input["origin"]["cursor"] = value;
        } else {
            input[name] = value;
        }
    }
    w.ok("follow.health", input)
}

#[test]
fn health_days_and_the_cursor_past_them_are_one_commit_and_a_refused_batch_moves_neither() {
    let w = World::new("health_cursor_days");
    let days = |value: f64| json!([{ "day": "2026-03-02", "metric": "steps", "value": value }]);
    record(&w, "phone-a", Some("a1"), days(900.0));
    assert_eq!(
        w.maybe::<f64>(
            "SELECT value FROM measurement WHERE day = '2026-03-02'",
            &[]
        ),
        Some(900.0)
    );
    assert_eq!(cursor(&w, "phone-a").as_deref(), Some("a1"));
    assert_eq!(cursor(&w, "phone-b"), None);
    let origin = |cursor: &str| json!({"system": "health", "ref": STORE, "device_id": "phone-a", "cursor": cursor});
    let refused = w.run("measurement.record", json!({"origin": origin("a2"), "days": [{"day": "2026-02-30", "metric": "steps", "value": 5.0}]}));
    assert_eq!(refused.status, centraid_vault::CommandStatus::Failed);
    assert_eq!(cursor(&w, "phone-a").as_deref(), Some("a1"));
    let nameless = w.run(
        "measurement.record",
        json!({"origin": {"system": "health", "ref": STORE, "cursor": "a3"}, "days": days(1.0)}),
    );
    assert_eq!(nameless.status, centraid_vault::CommandStatus::Failed);
    assert_eq!(cursor(&w, "phone-a").as_deref(), Some("a1"));
    assert_eq!(
        w.maybe::<f64>(
            "SELECT value FROM measurement WHERE day = '2026-03-02'",
            &[]
        ),
        Some(900.0)
    );
}

#[test]
fn a_pass_moves_the_cursor_with_its_records_and_another_install_takes_the_origin_over() {
    let w = World::new("health_cursor_pass");
    pass_with(
        &w,
        "phone-a",
        json!([at_hour("w1", 7)]),
        json!({"cursor": "a1"}),
    );
    assert_eq!(cursor(&w, "phone-a").as_deref(), Some("a1"));
    pass_with(&w, "phone-a", json!([at_hour("w1", 7)]), json!({}));
    assert_eq!(cursor(&w, "phone-a").as_deref(), Some("a1"));
    let nameless = w.run("follow.health", json!({"origin": {"ref": STORE, "label": "Apple Health", "cursor": "a2"}, "records": [at_hour("w2", 9)]}));
    assert_eq!(nameless.status, centraid_vault::CommandStatus::Failed);
    assert_eq!(w.count("SELECT COUNT(*) FROM workout"), 1);
    pass_with(&w, "phone-b", json!([]), json!({}));
    assert_eq!(cursor(&w, "phone-a"), None);
    pass_with(&w, "phone-b", json!([]), json!({"cursor": "b1"}));
    assert_eq!(cursor(&w, "phone-b").as_deref(), Some("b1"));
}

#[test]
fn a_workout_a_delta_names_deleted_keeps_its_row_and_forgets_its_source() {
    let w = World::new("health_cursor_gone");
    pass_with(
        &w,
        "phone-a",
        json!([at_hour("w1", 7), at_hour("w2", 9)]),
        json!({"cursor": "a1"}),
    );
    let told = pass_with(
        &w,
        "phone-a",
        json!([]),
        json!({"gone": ["local:w1", "local:never-seen"], "cursor": "a2"}),
    );
    assert_eq!(told["forgotten"], 1);
    assert_eq!(
        w.count("SELECT COUNT(*) FROM entity WHERE kind = 'workout' AND deleted_at IS NULL"),
        2
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM source WHERE system = 'health'"),
        1
    );
    assert_eq!(cursor(&w, "phone-a").as_deref(), Some("a2"));
    w.ok(
        "follow.advance_cursor",
        json!({"system": "health", "ref": STORE, "device_id": "phone-a", "cursor": "a3"}),
    );
    assert_eq!(cursor(&w, "phone-a").as_deref(), Some("a3"));
}

#[test]
fn health_followed_again_after_a_stop_starts_with_no_cursor_and_finds_its_rows() {
    let w = World::new("health_cursor_again");
    pass_with(
        &w,
        "phone-a",
        json!([at_hour("w1", 7)]),
        json!({"cursor": "a1"}),
    );
    let origin: String = w.one("SELECT id FROM origin WHERE system = 'health'", &[]);
    w.ok("follow.stop", json!({"system": "health", "ref": STORE}));
    assert_eq!(cursor(&w, "phone-a"), None);
    // a stray batch of totals does not write a cursor back to a stopped store
    let stray = w.run("measurement.record", json!({"origin": {"system": "health", "ref": STORE, "device_id": "phone-a", "cursor": "a9"}, "days": []}));
    assert_eq!(stray.status, centraid_vault::CommandStatus::Failed);
    let again = pass_with(&w, "phone-a", json!([at_hour("w1", 7)]), json!({}));
    assert_eq!(again["added"], 0);
    assert_eq!(
        w.one::<String>("SELECT id FROM origin WHERE system = 'health'", &[]),
        origin
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM workout"), 1);
}

#[test]
fn taking_what_the_phone_says_of_a_workout_figure_follows_it_again() {
    let w = World::new("health_take");
    pass(
        &w,
        "follow.health",
        "phone-a",
        &[run("w:1", "run", "2026-03-04T07:00:00Z", 5_234.5)],
        false,
    );
    let id = source_of(&w, "w:1");
    w.raw_result(&format!(
        "UPDATE workout SET distance_m = 6000.0, heart_bpm = 150 WHERE id = '{id}'"
    ))
    .expect("a hand edit");
    let says = || {
        w.vault()
            .read(|c| differences(c, &id))
            .expect("differences")
    };
    assert_eq!(says().len(), 2);
    w.ok(
        "follow.take_stated",
        json!({"entity": id, "field": "distance_m"}),
    );
    assert_eq!(
        w.maybe::<f64>("SELECT distance_m FROM workout WHERE id = ?1", &[&id]),
        Some(5_234.5)
    );
    assert_eq!(says().len(), 1, "only the heart rate still differs");
    w.ok(
        "follow.take_stated",
        json!({"entity": id, "field": "heart_bpm"}),
    );
    assert!(says().is_empty());
    pass(
        &w,
        "follow.health",
        "phone-a",
        &[run("w:1", "run", "2026-03-04T07:00:00Z", 7_000.0)],
        false,
    );
    assert_eq!(
        w.maybe::<f64>("SELECT distance_m FROM workout WHERE id = ?1", &[&id]),
        Some(7_000.0)
    );
}

#[test]
fn another_install_following_a_stopped_store_takes_the_origin_over_and_a_stray_cursor_does_not_revive_it()
 {
    let w = World::new("health_again_other");
    pass_with(
        &w,
        "phone-a",
        json!([at_hour("w1", 7)]),
        json!({"cursor": "anchor-1"}),
    );
    w.ok("follow.stop", json!({"system": "health", "ref": STORE}));
    w.ok(
        "follow.advance_cursor",
        json!({"system": "health", "ref": STORE, "device_id": "phone-a", "cursor": "anchor-9"}),
    );
    assert_eq!(cursor(&w, "phone-a"), None);
    assert!(
        w.one::<bool>(
            "SELECT retired_at IS NOT NULL FROM origin WHERE system = 'health'",
            &[]
        ),
        "still retired"
    );
    // the other install's pass revives it as its own, with no cursor and on the rows already there
    let again = pass_with(&w, "phone-b", json!([at_hour("w1", 7)]), json!({}));
    assert_eq!(again["added"], 0);
    assert_eq!(
        w.one::<String>("SELECT device_id FROM origin WHERE system = 'health'", &[]),
        "phone-b"
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM origin WHERE system = 'health'"),
        1
    );
}
