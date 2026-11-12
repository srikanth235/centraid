//! STOP FOLLOWING RETIRES, FOLLOWING AGAIN REVIVES (#1185): `follow.stop` keeps the origin, the home
//! it filled (`fills`) and its sources, and clears its cursor; the same `ref` followed again finds all
//! of them, so no second calendar, folder or project is made and no record is added twice. A retired
//! origin is followed by nobody: the reads that ask what a phone follows leave it out. Docs' folder is
//! in `docs_photos.rs`, which stages the bytes it needs.

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
            scratch: common::Scratch::founded("follow-retire").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self
            .scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn count(&self, sql: &str) -> i64 {
        self.one(sql, &[])
    }

    fn stop(&self, system: &str, reference: &str) -> Value {
        self.ok("follow.stop", json!({ "system": system, "ref": reference }))
    }

    /// The one origin of `system`: its id, whether it is retired, and what it fills.
    fn origin(&self, system: &str) -> (String, bool, Option<String>) {
        self.scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT id, retired_at IS NOT NULL, fills FROM origin WHERE system = ?1",
                    [system],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?)
            })
            .expect("one origin")
    }
}

// ---- contacts ----------------------------------------------------------------------------------

fn contacts(w: &World, device: &str, records: Value) -> Value {
    w.ok(
        "follow.contacts",
        json!({ "origin": { "ref": "phone", "label": "Phone", "device_id": device },
                "complete": true, "records": records }),
    )
}

fn ada(title: &str) -> Value {
    json!([{ "external_id": "c1", "fields": { "title": title, "role": "Analyst", "points": [] } }])
}

#[test]
fn contacts_followed_again_find_their_people_and_add_none_twice() {
    let w = World::new();
    contacts(&w, "phone-a", ada("Ada Lovelace"));
    let (origin, retired, _) = w.origin("contacts");
    assert!(!retired);
    let person = w.one::<String>("SELECT id FROM entity WHERE title = 'Ada Lovelace'", &[]);

    let stopped = w.stop("contacts", "phone");
    assert_eq!(stopped["stopped"], json!(true));
    // THE ORIGIN IS RETIRED, NOT DELETED: its row and its sources stay, and nothing reads it as followed.
    assert_eq!(w.origin("contacts"), (origin.clone(), true, None));
    assert_eq!(w.count("SELECT COUNT(*) FROM source"), 1);
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&person])
            .is_none(),
        "the person is the member's own, not trashed"
    );
    // Stopping what is not followed is nothing.
    assert_eq!(w.stop("contacts", "phone")["stopped"], json!(false));

    // Followed again: the same origin, the same person, nobody added.
    let again = contacts(&w, "phone-a", ada("Ada Lovelace"));
    assert_eq!(
        (again["added"].clone(), again["unchanged"].clone()),
        (json!(0), json!(1))
    );
    assert_eq!(w.origin("contacts"), (origin, false, None));
    assert_eq!(
        w.count("SELECT COUNT(*) FROM origin WHERE system = 'contacts'"),
        1
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM entity WHERE title = 'Ada Lovelace'"),
        1
    );
}

#[test]
fn a_person_the_member_trashed_or_renamed_while_stopped_stays_as_they_left_them() {
    let w = World::new();
    contacts(
        &w,
        "phone-a",
        json!([
            { "external_id": "c1", "fields": { "title": "Ada Lovelace", "role": "Analyst", "points": [] } },
            { "external_id": "c2", "fields": { "title": "Grace Hopper", "role": "Admiral", "points": [] } }
        ]),
    );
    let ada = w.one::<String>("SELECT id FROM entity WHERE title = 'Ada Lovelace'", &[]);
    let grace = w.one::<String>("SELECT id FROM entity WHERE title = 'Grace Hopper'", &[]);
    w.stop("contacts", "phone");
    w.ok("entity.trash", json!({ "id": ada }));
    w.ok(
        "entity.retitle",
        json!({ "id": grace, "title": "Rear Admiral Hopper" }),
    );

    contacts(
        &w,
        "phone-a",
        json!([
            { "external_id": "c1", "fields": { "title": "Ada Lovelace", "role": "Analyst", "points": [] } },
            { "external_id": "c2", "fields": { "title": "Grace Hopper", "role": "Admiral", "points": [] } }
        ]),
    );
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&ada])
            .is_some(),
        "what the member trashed while stopped stays trashed"
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&grace]),
        "Rear Admiral Hopper",
        "what the member renamed while stopped stands"
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM entity WHERE kind = 'person' AND title LIKE '%Hopper'"),
        1
    );
}

// ---- calendar ----------------------------------------------------------------------------------

fn meeting(uid: &str, title: &str) -> Value {
    json!({ "external_id": uid, "device_id": "phone-1", "fields": {
        "title": title, "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
        "timing": "floating", "description": "agenda", "rule": null, "busy": 1 } })
}

fn read_calendar(w: &World, device: &str, records: Vec<Value>) -> Value {
    w.ok(
        "follow.calendar",
        json!({ "origin": { "ref": "calendar:work", "label": "Work", "device_id": device },
                 "complete": true, "records": records }),
    )
}

#[test]
fn a_calendar_followed_again_keeps_its_calendar_and_adds_no_event_twice() {
    let w = World::new();
    read_calendar(&w, "phone-1", vec![meeting("uid:1", "Standup")]);
    let (origin, _, home) = w.origin("calendar");
    let home = home.expect("the calendar the origin filled");
    let calendars = w.count("SELECT COUNT(*) FROM entity WHERE kind = 'calendar'");

    w.stop("calendar", "calendar:work");
    // The calendar and the event stay, and the event shows no "Phone says" while nothing follows it.
    assert_eq!(
        w.origin("calendar"),
        (origin.clone(), true, Some(home.clone()))
    );
    let event = w.one::<String>("SELECT entity_id FROM source", &[]);
    assert!(
        w.scratch
            .vault
            .read(|c| Ok(centraid_vault::commands::follow::differences(c, &event)?.is_empty()))
            .expect("differences"),
        "a stopped calendar's event is not followed"
    );

    let again = read_calendar(&w, "phone-1", vec![meeting("uid:1", "Standup")]);
    assert_eq!(
        (again["added"].clone(), again["unchanged"].clone()),
        (json!(0), json!(1))
    );
    assert_eq!(w.origin("calendar"), (origin, false, Some(home)));
    assert_eq!(
        w.count("SELECT COUNT(*) FROM entity WHERE kind = 'calendar'"),
        calendars
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM event"), 1);
}

#[test]
fn an_event_the_member_trashed_or_edited_while_the_calendar_was_stopped_stays_that_way() {
    let w = World::new();
    read_calendar(
        &w,
        "phone-1",
        vec![meeting("uid:1", "Standup"), meeting("uid:2", "Retro")],
    );
    let standup = w.one::<String>(
        "SELECT entity_id FROM source WHERE external_id = 'uid:1'",
        &[],
    );
    let retro = w.one::<String>(
        "SELECT entity_id FROM source WHERE external_id = 'uid:2'",
        &[],
    );
    w.stop("calendar", "calendar:work");
    w.ok("entity.trash", json!({ "id": standup }));
    w.ok(
        "entity.retitle",
        json!({ "id": retro, "title": "Retrospective" }),
    );

    read_calendar(
        &w,
        "phone-1",
        vec![meeting("uid:1", "Standup"), meeting("uid:2", "Retro")],
    );
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&standup])
            .is_some(),
        "the event the member trashed stays trashed, not added again"
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&retro]),
        "Retrospective"
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM event"), 2);
}

// ---- reminders ---------------------------------------------------------------------------------

#[test]
fn reminders_followed_again_find_their_project_and_add_no_task_twice() {
    let w = World::new();
    let follow = |w: &World| {
        w.ok(
            "follow.reminders",
            json!({ "origin": { "ref": "list:1", "label": "Groceries" }, "complete": true,
                     "records": [{ "external_id": "r1", "fields": { "title": "Milk", "status": "open", "done_at": null } }] }),
        )
    };
    follow(&w);
    let projects = w.count("SELECT COUNT(*) FROM entity WHERE kind = 'project'");
    let (origin, _, home) = w.origin("phone_reminders");
    w.stop("phone_reminders", "list:1");
    assert_eq!(
        w.origin("phone_reminders"),
        (origin.clone(), true, home.clone())
    );
    let again = follow(&w);
    assert_eq!(
        (again["added"].clone(), again["unchanged"].clone()),
        (json!(0), json!(1))
    );
    assert_eq!(w.origin("phone_reminders"), (origin, false, home));
    assert_eq!(w.count("SELECT COUNT(*) FROM task"), 1);
    assert_eq!(
        w.count("SELECT COUNT(*) FROM entity WHERE kind = 'project'"),
        projects
    );
}

// ---- health ------------------------------------------------------------------------------------

fn run(external: &str) -> Value {
    json!({ "external_id": external, "fields": { "kind": "run", "starts": "2026-03-04T07:00:00Z",
        "ends": "2026-03-04T07:45:00Z",
        "workout": { "recorded_by": "Watch", "moving_s": 2_700, "distance_m": 5_000.0, "heart_bpm": 148 } } })
}

fn health(w: &World, device: &str, cursor: Option<&str>) -> Value {
    let mut origin =
        json!({ "ref": "store:apple-health", "label": "Apple Health", "device_id": device });
    if let Some(cursor) = cursor {
        origin["cursor"] = json!(cursor);
    }
    let mut record = run("local:1");
    record["device_id"] = json!(device);
    w.ok(
        "follow.health",
        json!({ "origin": origin, "records": [record], "complete": true }),
    )
}

fn cursor(w: &World) -> Option<String> {
    w.one::<Option<String>>(
        "SELECT json_extract(config, '$.cursor') FROM origin WHERE system = 'health'",
        &[],
    )
}

#[test]
fn health_followed_again_starts_with_no_cursor_and_adds_no_workout_twice() {
    let w = World::new();
    health(&w, "phone-a", Some("anchor-1"));
    assert_eq!(cursor(&w).as_deref(), Some("anchor-1"));
    let (origin, _, _) = w.origin("health");

    w.stop("health", "store:apple-health");
    assert!(w.origin("health").1);
    // STOP CLEARS THE CURSOR: a store followed again reads in full.
    assert_eq!(cursor(&w), None);

    let again = health(&w, "phone-a", None);
    assert_eq!(
        (again["added"].clone(), again["unchanged"].clone()),
        (json!(0), json!(1))
    );
    assert_eq!(w.origin("health").0, origin);
    assert!(!w.origin("health").1);
    assert_eq!(w.count("SELECT COUNT(*) FROM workout"), 1);
}

#[test]
fn a_store_followed_again_by_another_install_takes_the_origin_over_with_no_cursor() {
    let w = World::new();
    health(&w, "phone-a", Some("anchor-1"));
    w.stop("health", "store:apple-health");
    // Another install follows the same store: the origin is its own now, the word of the last one is
    // gone, and its records land on the rows already there.
    health(&w, "phone-b", None);
    let device: Option<String> = w.one("SELECT device_id FROM origin WHERE system = 'health'", &[]);
    assert_eq!(device.as_deref(), Some("phone-b"));
    assert_eq!(cursor(&w), None);
    assert_eq!(
        w.count("SELECT COUNT(*) FROM origin WHERE system = 'health'"),
        1
    );
}

#[test]
fn a_stray_batch_after_stop_writes_no_cursor_back_and_does_not_revive_the_origin() {
    let w = World::new();
    health(&w, "phone-a", Some("anchor-1"));
    w.stop("health", "store:apple-health");
    w.ok(
        "follow.advance_cursor",
        json!({ "system": "health", "ref": "store:apple-health", "device_id": "phone-a", "cursor": "anchor-9" }),
    );
    assert_eq!(cursor(&w), None);
    assert!(w.origin("health").1, "still retired");
}

// ---- what a phone follows ----------------------------------------------------------------------

#[test]
fn a_retired_origin_is_left_out_of_what_the_vault_says_it_follows() {
    let w = World::new();
    health(&w, "phone-a", None);
    let line = w.one::<String>("SELECT entity_id FROM source", &[]);
    let from = |w: &World| {
        w.scratch
            .vault
            .read(|c| centraid_vault::commands::arrival::origin_of(c, &line))
            .expect("origin_of")
    };
    assert_eq!(
        from(&w).map(|(system, _)| system).as_deref(),
        Some("health")
    );
    w.stop("health", "store:apple-health");
    assert_eq!(from(&w), None, "the From line goes with the follow");
    // A hand-logged figure is allowed again: the store states nothing now.
    w.ok(
        "measurement.log",
        json!({"day": "2026-03-05", "metric": "steps", "value": 9_000}),
    );
}
