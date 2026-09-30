//! AN EVENT'S TIMES AS A COMMAND STATES THEM (#1029, the phone-shell port):
//! the one-day all-day event whose inclusive end equals its start, and the
//! wall clock plus IANA `tz` the phone sends because `commonMain` has no zone
//! engine. The shapes are `centraid_vault::commands::event_time`'s header.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus};
use serde_json::{Value, json};

struct Bench {
    scratch: common::Scratch,
    registry: Registry,
}

impl Bench {
    fn new(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        Self { scratch, registry }
    }

    fn attempt(&self, name: &str, input: Value) -> Result<Value, String> {
        match self.scratch.vault.execute(
            &self.registry,
            &Principal::owner("phone"),
            &Command::new(name, input),
        ) {
            Ok(outcome) if outcome.status == CommandStatus::Executed => Ok(outcome.output),
            Ok(outcome) => Err(outcome.reason.unwrap_or_default()),
            Err(error) => Err(error.to_string()),
        }
    }

    fn run(&self, name: &str, input: Value) -> Value {
        self.attempt(name, input)
            .unwrap_or_else(|reason| panic!("{name} refused: {reason}"))
    }

    fn denied(&self, name: &str, input: Value) -> String {
        self.attempt(name, input)
            .expect_err("the command should have been refused")
    }

    fn row(&self, event_id: &str) -> (String, String, Option<String>, Option<String>, String) {
        self.scratch
            .vault
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT dtstart, dtend, start_tz, end_tz, recurrence_semantics
                       FROM core_event WHERE event_id = ?1",
                    [event_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )?)
            })
            .expect("the event row")
    }

    fn calendar(&self) -> String {
        let vault = &self.scratch.vault;
        let calendar_id = vault.ids().next();
        let owner = common::owner_party(vault).expect("an owner");
        let now = vault.clock().now_text();
        let id = calendar_id.clone();
        vault
            .commit(|tx| {
                tx.set_producer("test.calendar");
                tx.connection().execute(
                    "INSERT INTO schedule_calendar
                       (calendar_id, owner_party_id, name, color, default_tz, visibility,
                        external_uri, created_at)
                     VALUES (?1, ?2, 'Home', NULL, 'Etc/UTC', 'private', NULL, ?3)",
                    rusqlite::params![id, owner, now],
                )?;
                Ok(())
            })
            .expect("the calendar is written");
        calendar_id
    }
}

fn id_of(output: &Value) -> String {
    output["event_id"].as_str().expect("an event id").to_owned()
}

#[test]
fn a_one_day_all_day_event_stores_its_inclusive_end_equal_to_its_start() {
    let bench = Bench::new("all-day-one");
    let calendar_id = bench.calendar();
    let event_id = id_of(&bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Holiday",
            "dtstart": "2026-10-02",
            "dtend": "2026-10-02",
            "recurrence_semantics": "all-day",
            "calendar_id": calendar_id,
        }),
    ));
    assert_eq!(bench.row(&event_id).1, "2026-10-02");
    // An edit that restates a one-day range, and one that moves only the end
    // back onto the start, both hold.
    bench.run(
        "schedule.edit_event",
        json!({ "event_id": event_id, "dtstart": "2026-10-05", "dtend": "2026-10-05" }),
    );
    bench.run(
        "schedule.edit_event",
        json!({ "event_id": event_id, "dtend": "2026-10-06" }),
    );
    bench.run(
        "schedule.edit_event",
        json!({ "event_id": event_id, "dtend": "2026-10-05" }),
    );
    let backwards = bench.denied(
        "schedule.edit_event",
        json!({ "event_id": event_id, "dtend": "2026-10-04" }),
    );
    assert!(backwards.contains("on or after"), "{backwards}");
    // A TIMED end is still exclusive.
    let timed = bench.denied(
        "schedule.propose_event",
        json!({
            "summary": "Zero",
            "dtstart": "2026-10-09T09:00:00",
            "dtend": "2026-10-09T09:00:00",
            "calendar_id": calendar_id,
        }),
    );
    assert!(timed.contains("end after it starts"), "{timed}");
}

#[test]
fn a_one_day_all_day_series_takes_equal_ends_on_its_occurrence_and_series_paths() {
    let bench = Bench::new("all-day-series");
    let calendar_id = bench.calendar();
    let event_id = id_of(&bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Bin day",
            "dtstart": "2026-10-01",
            "dtend": "2026-10-01",
            "recurrence_semantics": "all-day",
            "rrule": "FREQ=WEEKLY",
            "calendar_id": calendar_id,
        }),
    ));
    bench.run(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "2026-10-08",
            "scope": "occurrence",
            "action": "override",
            "dtstart": "2026-10-09",
            "dtend": "2026-10-09",
        }),
    );
    let backwards = bench.denied(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "2026-10-15",
            "scope": "occurrence",
            "action": "override",
            "dtstart": "2026-10-16",
            "dtend": "2026-10-15",
        }),
    );
    assert!(backwards.contains("on or after"), "{backwards}");
    bench.run(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "2026-10-01",
            "scope": "series",
            "action": "override",
            "dtend": "2026-10-01",
        }),
    );
}

#[test]
fn a_wall_clock_in_a_named_zone_is_stored_as_its_instant_and_zone() {
    let bench = Bench::new("zoned-wall");
    let calendar_id = bench.calendar();
    let event_id = id_of(&bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Design review",
            "dtstart": "2026-03-02T09:00:00",
            "dtend": "2026-03-02T10:00",
            "tz": "Asia/Kolkata",
            "calendar_id": calendar_id,
        }),
    ));
    assert_eq!(
        bench.row(&event_id),
        (
            "2026-03-02T03:30:00.000Z".to_owned(),
            "2026-03-02T04:30:00.000Z".to_owned(),
            Some("Asia/Kolkata".to_owned()),
            Some("Asia/Kolkata".to_owned()),
            "zoned".to_owned(),
        )
    );
    // The instant form keeps working beside it.
    let instant_id = id_of(&bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Instant",
            "dtstart": "2026-03-03T03:30:00.000Z",
            "dtend": "2026-03-03T04:30:00.000Z",
            "start_tz": "Asia/Kolkata",
            "calendar_id": calendar_id,
        }),
    ));
    assert_eq!(bench.row(&instant_id).4, "zoned");

    bench.run(
        "schedule.edit_event",
        json!({
            "event_id": event_id,
            "dtstart": "2026-03-04T08:00:00",
            "dtend": "2026-03-04T09:15:00",
            "tz": "Europe/London",
        }),
    );
    let (start, end, start_tz, _, semantics) = bench.row(&event_id);
    assert_eq!(
        (
            start.as_str(),
            end.as_str(),
            start_tz.as_deref(),
            semantics.as_str()
        ),
        (
            "2026-03-04T08:00:00.000Z",
            "2026-03-04T09:15:00.000Z",
            Some("Europe/London"),
            "zoned"
        )
    );
}

#[test]
fn a_wall_clock_the_zone_skips_or_a_mixed_shape_is_refused() {
    let bench = Bench::new("zoned-refusals");
    let calendar_id = bench.calendar();
    let base = |start: &str, extra: Value| {
        let mut input = json!({
            "summary": "Early",
            "dtstart": start,
            "dtend": "2026-03-08T04:00:00",
            "tz": "America/New_York",
            "calendar_id": calendar_id,
        });
        for (key, value) in extra.as_object().expect("an object") {
            input[key] = value.clone();
        }
        input
    };
    let gap = bench.denied(
        "schedule.propose_event",
        base("2026-03-08T02:30:00", json!({})),
    );
    assert!(gap.contains("does not exist"), "{gap}");
    let offset = bench.denied(
        "schedule.propose_event",
        base("2026-03-08T01:00:00Z", json!({})),
    );
    assert!(offset.contains("wall clock"), "{offset}");
    let both = bench.denied(
        "schedule.propose_event",
        base("2026-03-08T01:00:00", json!({ "start_tz": "Etc/UTC" })),
    );
    assert!(both.contains("not both"), "{both}");
    let unknown = bench.denied(
        "schedule.propose_event",
        base("2026-03-08T01:00:00", json!({ "tz": "Mars/Olympus" })),
    );
    assert!(unknown.contains("not a time zone"), "{unknown}");
}

#[test]
fn an_occurrence_override_in_a_named_zone_stores_its_instants() {
    let bench = Bench::new("zoned-occurrence");
    let calendar_id = bench.calendar();
    let event_id = id_of(&bench.run(
        "schedule.propose_event",
        json!({
            "summary": "Standup",
            "dtstart": "2026-03-02T09:00:00",
            "dtend": "2026-03-02T09:30:00",
            "tz": "Asia/Kolkata",
            "rrule": "FREQ=DAILY",
            "calendar_id": calendar_id,
        }),
    ));
    bench.run(
        "schedule.edit_event_occurrence",
        json!({
            "event_id": event_id,
            "original_start_local": "2026-03-05T09:00:00",
            "scope": "occurrence",
            "action": "override",
            "dtstart": "2026-03-05T10:00:00",
            "dtend": "2026-03-05T10:30:00",
            "tz": "Asia/Kolkata",
        }),
    );
    let payload: String = bench
        .scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT override_json FROM schedule_recurrence_exception WHERE target_id = ?1",
                [&event_id],
                |row| row.get(0),
            )?)
        })
        .expect("the exception");
    let payload: Value = serde_json::from_str(&payload).expect("json");
    assert_eq!(payload["start"], json!("2026-03-05T04:30:00.000Z"));
    assert_eq!(payload["end"], json!("2026-03-05T05:00:00.000Z"));
    assert!(
        payload.get("tz").is_none(),
        "the zone is the series', not a field"
    );
}
