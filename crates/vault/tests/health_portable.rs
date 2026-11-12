//! Health as a spreadsheet file (#1185): `health.export_csv` writes RFC 4180 text a spreadsheet
//! reads back, the daily totals with their unit in their own column and the workouts with the
//! figures as the vault keeps them, names the file for what it holds, leaves the trash out and
//! writes nothing.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("health-csv").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: Value) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("runs")
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn workout(&self, input: Value) -> String {
        self.ok("workout.log", input)["workout_id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn file(&self, input: Value) -> (Value, String) {
        let out = self.ok("health.export_csv", input);
        let text = String::from_utf8(
            base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                out["content"].as_str().expect("content"),
            )
            .expect("base64"),
        )
        .expect("utf-8");
        (out, text)
    }

    fn writes(&self) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row("SELECT writes FROM vault", [], |r| r.get(0))?))
            .expect("a row")
    }

    fn days(&self) {
        self.ok(
            "measurement.record",
            json!({ "days": [
                { "day": "2026-03-02", "metric": "steps", "value": 9100 },
                { "day": "2026-03-01", "metric": "steps", "value": 7500 },
                { "day": "2026-03-01", "metric": "weight_kg", "value": 72.45 },
            ]}),
        );
    }
}

/// The records of a CSV file the way a spreadsheet reads it: CRLF between records, quotes
/// honoured (a doubled quote is one), a quoted field may hold commas and line breaks.
fn records(text: &str) -> Vec<Vec<String>> {
    assert!(text.ends_with("\r\n"), "every record ends in CRLF");
    let mut out = Vec::new();
    let mut row = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => {
                chars.next();
                cell.push('"');
            }
            (true, '"') => quoted = false,
            (true, other) => cell.push(other),
            (false, '"') => quoted = true,
            (false, ',') => row.push(std::mem::take(&mut cell)),
            (false, '\r') => {
                assert_eq!(chars.next(), Some('\n'), "a bare CR");
                row.push(std::mem::take(&mut cell));
                out.push(std::mem::take(&mut row));
            }
            (false, '\n') => panic!("a bare LF outside quotes"),
            (false, other) => cell.push(other),
        }
    }
    out
}

#[test]
fn daily_totals_are_one_row_a_day_and_metric_with_the_stored_value_and_its_unit() {
    let w = World::new();
    w.days();
    let (out, text) = w.file(json!({ "what": "measurements" }));
    assert_eq!(out["name"], "Daily totals.csv");
    assert_eq!(out["media_type"], "text/csv");
    assert_eq!(out["count"], 3);
    let rows = records(&text);
    assert_eq!(rows[0], ["Date", "Metric", "Value", "Unit"]);
    assert_eq!(rows[1], ["2026-03-01", "steps", "7500", "count"]);
    assert_eq!(rows[2], ["2026-03-01", "weight_kg", "72.45", "kg"]);
    assert_eq!(rows[3], ["2026-03-02", "steps", "9100", "count"]);
}

#[test]
fn one_metric_is_its_own_file_named_for_it() {
    let w = World::new();
    w.days();
    let (out, text) = w.file(json!({ "what": "measurements", "metric": "weight_kg" }));
    assert_eq!(out["name"], "Weight by day.csv");
    assert_eq!(out["count"], 1);
    assert!(text.contains("72.45") && !text.contains("steps"));
}

#[test]
fn workouts_carry_the_figures_as_stored_and_leave_the_trash_out() {
    let w = World::new();
    let kept = w.workout(json!({
        "type": "run", "title": "Morning, \"easy\" run", "starts": "2026-03-04T07:10:00Z",
        "ends": "2026-03-04T07:41:00Z", "moving_s": 1800, "distance_m": 5000.5,
        "energy_kcal": 338, "heart_bpm": 148, "climb_m": 40
    }));
    let gone = w.workout(json!({ "type": "walk", "title": "GONE", "starts": "2026-03-05" }));
    w.ok("entity.trash", json!({ "id": gone }));
    let (out, text) = w.file(json!({ "what": "workouts" }));
    assert_eq!(out["name"], "Workouts.csv");
    assert_eq!(out["count"], 1);
    assert!(!text.contains("GONE"));
    let rows = records(&text);
    assert_eq!(rows[0].len(), 10);
    assert_eq!(
        rows[1],
        [
            "2026-03-04T07:10:00+00:00",
            "2026-03-04T07:41:00+00:00",
            "Run",
            "Morning, \"easy\" run",
            "1800",
            "5000.5",
            "338",
            "148",
            "40",
            ""
        ]
    );
    let (one, _) = w.file(json!({ "what": "workouts", "id": kept }));
    assert_eq!(one["count"], 1);
    let (none, _) = w.file(json!({ "what": "workouts", "id": gone }));
    assert_eq!(none["count"], 0);
}

#[test]
fn a_workouts_times_are_the_members_own_with_their_offset() {
    let w = World::new();
    w.scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.set_zone");
            tx.connection()
                .execute("UPDATE vault SET zone = 'Asia/Kolkata'", [])?;
            Ok(())
        })
        .expect("a zone");
    w.workout(json!({
        "type": "run", "title": "Dawn", "starts": "2026-11-11T02:00:00Z",
        "ends": "2026-11-11T02:45:00Z"
    }));
    let (_, text) = w.file(json!({ "what": "workouts" }));
    let rows = records(&text);
    assert_eq!(
        rows[1][..2],
        ["2026-11-11T07:30:00+05:30", "2026-11-11T08:15:00+05:30"]
    );
}

#[test]
fn one_workout_is_named_for_its_title_and_day_and_writes_nothing() {
    let w = World::new();
    w.workout(json!({ "type": "walk", "title": "OTHER", "starts": "2026-03-01" }));
    let id = w.workout(json!({
        "type": "cycle", "title": "Hills / Loop", "starts": "2026-03-09T18:00:00Z"
    }));
    let before = w.writes();
    let (out, text) = w.file(json!({ "what": "workouts", "id": id }));
    assert_eq!(out["name"], "Hills - Loop 2026-03-09.csv");
    assert_eq!(out["count"], 1);
    assert_eq!(records(&text).len(), 2);
    assert!(!text.contains("OTHER"));
    assert_eq!(w.writes(), before, "an export writes nothing");
}

#[test]
fn a_word_that_is_not_a_choice_is_refused_with_a_sentence() {
    let w = World::new();
    for input in [
        json!({}),
        json!({ "what": "everything" }),
        json!({ "what": "measurements", "metric": "mood" }),
    ] {
        let outcome = w.run("health.export_csv", input.clone());
        assert_ne!(outcome.status, CommandStatus::Executed, "{input}");
    }
}
