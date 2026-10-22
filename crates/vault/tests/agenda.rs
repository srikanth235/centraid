//! An event's and a task's own verbs, against a vault the product founds: the
//! times a command states, a series and the days it skips, a guest's answer, the
//! one completion and the successor that carries what belongs to the series, the
//! trash, and the calendar follower's three-way merge of a series' days.

mod common;

use std::collections::BTreeSet;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use rusqlite::OptionalExtension;
use serde_json::json;

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("agenda").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn refused(&self, name: &str, input: serde_json::Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} was not refused"
        );
        outcome.reason.expect("a sentence")
    }

    fn id(&self, name: &str, input: serde_json::Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn count(&self, sql: &str, params: &[&str]) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn text(&self, sql: &str, params: &[&str]) -> Option<String> {
        self.scratch
            .vault
            .read(|c| {
                Ok(
                    c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))
                        .optional()?
                        .flatten(),
                )
            })
            .expect("a row")
    }

    fn days(&self, series: &str) -> Vec<(String, i64, Option<String>)> {
        self.scratch
            .vault
            .read(|c| {
                Ok(c.prepare(
                    "SELECT original_start, cancelled, starts FROM occurrence
                      WHERE series_id = ?1 AND scope = 'occurrence' ORDER BY 1",
                )?
                .query_map([series], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?)
            })
            .expect("rows")
    }
}

fn weekly(world: &World) -> String {
    world.id(
        "event.propose",
        json!({ "title": "Standup", "starts": "2026-03-02T09:00", "ends": "2026-03-02T09:30",
                "zone": "Europe/Paris", "rule": "FREQ=WEEKLY" }),
    )
}

#[test]
fn a_zoned_time_is_the_instant_its_wall_clock_is_and_a_skipped_clock_is_refused() {
    let world = World::new();
    let id = weekly(&world);
    assert_eq!(
        world
            .text("SELECT starts FROM event WHERE id = ?1", &[&id])
            .as_deref(),
        Some("2026-03-02T08:00:00.000Z")
    );
    assert_eq!(
        world
            .text("SELECT timing FROM event WHERE id = ?1", &[&id])
            .as_deref(),
        Some("zoned")
    );
    let sentence = world.refused(
        "event.propose",
        json!({ "title": "Gap", "starts": "2026-03-29T02:30", "zone": "Europe/Paris" }),
    );
    assert!(sentence.contains("does not exist"), "{sentence}");
    // A floating time and an all-day date keep their spelling and take no zone.
    let day = world.id(
        "event.propose",
        json!({ "title": "Holiday", "starts": "2026-03-05", "ends": "2026-03-06", "busy": false }),
    );
    assert_eq!(
        world
            .text("SELECT timing FROM event WHERE id = ?1", &[&day])
            .as_deref(),
        Some("all-day")
    );
    let sentence = world.refused(
        "event.propose",
        json!({ "title": "Backwards", "starts": "2026-03-05T10:00", "ends": "2026-03-05T09:00" }),
    );
    assert!(sentence.contains("end after it starts"), "{sentence}");
}

#[test]
fn a_busy_event_does_not_land_on_a_busy_one_and_a_free_one_blocks_nothing() {
    let world = World::new();
    world.ok(
        "event.propose",
        json!({ "title": "Dentist", "starts": "2026-03-02T10:00", "ends": "2026-03-02T11:00" }),
    );
    let sentence = world.refused(
        "event.propose",
        json!({ "title": "Clash", "starts": "2026-03-02T10:30", "ends": "2026-03-02T11:30" }),
    );
    assert!(sentence.contains("conflicts"), "{sentence}");
    world.ok(
        "event.propose",
        json!({ "title": "Lunch", "starts": "2026-03-02T10:30", "ends": "2026-03-02T11:30",
                "busy": false }),
    );
}

#[test]
fn guests_answer_on_the_edge_and_an_edit_keeps_the_answers_it_does_not_change() {
    let world = World::new();
    let ada = world.id("person.add", json!({ "title": "Ada" }));
    let bob = world.id("person.add", json!({ "title": "Bob" }));
    let id = world.id(
        "event.propose",
        json!({ "title": "Party", "starts": "2026-03-07T18:00", "attendees": [ada, bob] }),
    );
    world.ok(
        "event.respond",
        json!({ "id": id, "person_id": ada, "state": "accepted" }),
    );
    // Bob is taken off, Ada keeps her answer.
    world.ok("event.edit", json!({ "id": id, "attendees": [ada] }));
    let state = |person: &str| {
        world.text(
            "SELECT state FROM edge WHERE from_id = ?1 AND rel = 'attendee' AND to_id = ?2",
            &[&id, person],
        )
    };
    assert_eq!(state(&ada).as_deref(), Some("accepted"));
    assert_eq!(state(&bob), None);
    let sentence = world.refused(
        "event.respond",
        json!({ "id": id, "person_id": bob, "state": "declined" }),
    );
    assert!(sentence.contains("not invited"), "{sentence}");
    world.ok("event.cancel", json!({ "id": id }));
    let sentence = world.refused(
        "event.respond",
        json!({ "id": id, "person_id": ada, "state": "declined" }),
    );
    assert!(sentence.contains("cancelled"), "{sentence}");
}

#[test]
fn a_day_of_a_series_is_skipped_moved_and_put_back_by_its_wall_clock() {
    let world = World::new();
    let id = weekly(&world);
    let key = "2026-03-09T09:00:00";
    world.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": key, "scope": "occurrence", "action": "skip" }),
    );
    assert_eq!(world.days(&id), [(key.to_owned(), 1, None)]);
    world.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": key, "scope": "occurrence", "action": "override",
                "starts": "2026-03-09T11:00", "ends": "2026-03-09T11:30", "title": "Late standup" }),
    );
    assert_eq!(
        world.days(&id),
        [(
            key.to_owned(),
            0,
            Some("2026-03-09T10:00:00.000Z".to_owned())
        )]
    );
    world.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": key, "scope": "occurrence", "action": "restore" }),
    );
    assert!(world.days(&id).is_empty());
    let sentence = world.refused(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-10T09:00:00", "scope": "occurrence",
                "action": "skip" }),
    );
    assert!(
        sentence.contains("not one the event lands on"),
        "{sentence}"
    );
    // Skipping the whole series is cancelling it.
    world.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": key, "scope": "series", "action": "skip" }),
    );
    assert_eq!(
        world
            .text("SELECT status FROM event WHERE id = ?1", &[&id])
            .as_deref(),
        Some("cancelled")
    );
}

#[test]
fn a_change_that_strands_a_skipped_day_is_refused() {
    let world = World::new();
    let id = weekly(&world);
    world.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09T09:00:00", "scope": "occurrence",
                "action": "skip" }),
    );
    let sentence = world.refused(
        "event.edit",
        json!({ "id": id, "starts": "2026-03-02T10:00", "ends": "2026-03-02T10:30" }),
    );
    assert!(sentence.contains("matching nothing"), "{sentence}");
    let sentence = world.refused("event.edit", json!({ "id": id, "rule": "FREQ=BANANA" }));
    assert!(sentence.contains("FREQ=BANANA"), "{sentence}");
    // A title is no change to the series' days.
    world.ok("event.edit", json!({ "id": id, "title": "Daily" }));
}

fn task(world: &World, input: serde_json::Value) -> String {
    world.id("task.add", input)
}

#[test]
fn completion_is_one_operation_and_its_successor_carries_the_series() {
    let world = World::new();
    let mum = world.id("person.add", json!({ "title": "Mum" }));
    let project = world.id(
        "container.create",
        json!({ "kind": "project", "title": "Home" }),
    );
    let id = task(
        &world,
        json!({ "title": "Call Mum", "due": "2026-03-02", "rule": "FREQ=WEEKLY",
                "project_id": project, "priority": 3 }),
    );
    world.ok("edge.add", json!({ "from": id, "rel": "about", "to": mum }));
    world.ok("tag.add", json!({ "id": id, "label": "family" }));
    let done = world.ok("task.complete", json!({ "id": id }));
    let next = done["next_id"].as_str().expect("a successor").to_owned();
    assert_eq!(done["next_due"], "2026-03-09");
    assert_eq!(done["series_id"], id.as_str());
    // Completing it again is the same answer and no second successor.
    let again = world.ok("task.complete", json!({ "id": id }));
    assert!(again["next_id"].is_null());
    assert_eq!(
        world.count("SELECT COUNT(*) FROM task WHERE series_id = ?1", &[&id]),
        2
    );
    // The successor is still about Mum, tagged, filed and as urgent.
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel IN ('about', 'tagged')",
            &[&next]
        ),
        2
    );
    assert_eq!(
        world
            .text("SELECT project_id FROM task WHERE id = ?1", &[&next])
            .as_deref(),
        Some(project.as_str())
    );
    assert_eq!(
        world.count("SELECT priority FROM task WHERE id = ?1", &[&next]),
        3
    );
    // Reopening makes it open again and spawns nothing; cancelling ends it so.
    world.ok("task.reopen", json!({ "id": id }));
    assert_eq!(
        world.count("SELECT COUNT(*) FROM task WHERE series_id = ?1", &[&id]),
        2
    );
    world.ok("task.cancel", json!({ "id": next }));
    assert_eq!(
        world.count("SELECT COUNT(*) FROM task WHERE series_id = ?1", &[&id]),
        2
    );
    assert_eq!(
        world
            .text("SELECT status FROM task WHERE id = ?1", &[&next])
            .as_deref(),
        Some("cancelled")
    );
}

#[test]
fn a_completion_measured_from_the_completion_and_a_series_that_ran_out() {
    let world = World::new();
    let once = task(
        &world,
        json!({ "title": "Water", "due": "2026-03-02", "rule": "FREQ=DAILY;COUNT=1" }),
    );
    let done = world.ok("task.complete", json!({ "id": once }));
    assert!(done["next_id"].is_null(), "{done}");
}

#[test]
fn a_task_is_refused_what_the_model_refuses_and_a_section_follows_its_project() {
    let world = World::new();
    let sentence = world.refused("task.add", json!({ "title": "x", "due": "banana" }));
    assert!(sentence.contains("due"), "{sentence}");
    let sentence = world.refused("task.add", json!({ "title": "x", "rule": "FREQ=DAILY" }));
    assert!(sentence.contains("needs a due date"), "{sentence}");
    let a = world.id(
        "container.create",
        json!({ "kind": "project", "title": "A" }),
    );
    let b = world.id(
        "container.create",
        json!({ "kind": "project", "title": "B" }),
    );
    let section = world.id(
        "container.create",
        json!({ "kind": "section", "title": "Later", "parent": a }),
    );
    let id = task(
        &world,
        json!({ "title": "File it", "project_id": a, "section_id": section }),
    );
    let sentence = world.refused(
        "task.add",
        json!({ "title": "y", "project_id": b, "section_id": section }),
    );
    assert!(sentence.contains("different project"), "{sentence}");
    // Moving to another project leaves the section behind.
    world.ok("task.organize", json!({ "id": id, "project_id": b }));
    assert!(
        world
            .text("SELECT section_id FROM task WHERE id = ?1", &[&id])
            .is_none()
    );
    let parent = task(&world, json!({ "title": "Parent" }));
    let child = task(&world, json!({ "title": "Child", "parent_id": parent }));
    let sentence = world.refused(
        "task.add",
        json!({ "title": "Grandchild", "parent_id": child }),
    );
    assert!(sentence.contains("top-level"), "{sentence}");
}

#[test]
fn trashing_a_task_takes_its_subtasks_and_a_restore_brings_them_back() {
    let world = World::new();
    let parent = task(&world, json!({ "title": "Move house" }));
    let child = task(
        &world,
        json!({ "title": "Box up books", "parent_id": parent }),
    );
    world.ok("entity.trash", json!({ "id": parent }));
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM entity WHERE id IN (?1, ?2) AND deleted_at IS NOT NULL",
            &[&parent, &child]
        ),
        2
    );
    world.ok("entity.restore", json!({ "id": parent }));
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM entity WHERE id IN (?1, ?2) AND deleted_at IS NOT NULL",
            &[&parent, &child]
        ),
        0
    );
    world.ok("entity.trash", json!({ "id": parent }));
    world.ok("entity.purge", json!({ "id": parent }));
    assert_eq!(world.count("SELECT COUNT(*) FROM task", &[]), 0);
}

#[test]
fn a_task_is_found_by_its_project_and_a_rename_reaches_it() {
    let world = World::new();
    let project = world.id(
        "container.create",
        json!({ "kind": "project", "title": "Garden" }),
    );
    let id = task(
        &world,
        json!({ "title": "Prune", "project_id": project, "description": "roses" }),
    );
    let found = |term: &str| {
        world.count(
            "SELECT COUNT(*) FROM search s JOIN entity e ON e.n = s.rowid
              WHERE search MATCH ?1 AND e.id = ?2",
            &[term, &id],
        ) == 1
    };
    assert!(found("garden") && found("roses"));
    world.ok(
        "entity.retitle",
        json!({ "id": project, "title": "Allotment" }),
    );
    assert!(found("allotment") && !found("garden"));
}

#[test]
fn the_words_the_code_reads_are_the_checks_the_file_holds() {
    let world = World::new();
    let ddl = |table: &str| -> String {
        world
            .scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT sql FROM sqlite_master WHERE name = ?1",
                    [table],
                    |r| r.get(0),
                )?)
            })
            .expect("a table")
    };
    let words = |sql: &str, column: &str| -> BTreeSet<String> {
        let at = sql.find(&format!("{column} ")).expect("a column");
        let rest = &sql[at..];
        let open = rest.find("IN (").expect("a list") + 4;
        let close = rest[open..].find(')').expect("a close") + open;
        rest[open..close]
            .split(',')
            .map(|word| word.trim().trim_matches('\'').to_owned())
            .collect()
    };
    let set =
        |words: &[&str]| -> BTreeSet<String> { words.iter().map(|w| (*w).to_owned()).collect() };
    let event = ddl("event");
    assert_eq!(
        words(&event, "timing"),
        centraid_vault::commands::event::TIMINGS
            .iter()
            .map(|timing| timing.as_str().to_owned())
            .collect()
    );
    assert_eq!(
        words(&event, "status"),
        set(&centraid_vault::commands::event::STATUSES)
    );
    let task = ddl("task");
    assert_eq!(
        words(&task, "status"),
        set(&centraid_vault::commands::task::STATUSES)
    );
    assert_eq!(
        words(&task, "anchor"),
        centraid_vault::commands::task::ANCHORS
            .iter()
            .map(|anchor| anchor.as_str().to_owned())
            .collect()
    );
    assert_eq!(
        words(&ddl("edge"), "state"),
        set(&centraid_vault::commands::event::ANSWERS)
    );
    assert_eq!(
        words(&ddl("occurrence"), "scope"),
        set(&["occurrence", "future"])
    );
}

// ---------------------------------------------------------------------------
// The calendar follower
// ---------------------------------------------------------------------------

fn record(
    world: &World,
    external: &str,
    fields: serde_json::Value,
    complete: bool,
) -> serde_json::Value {
    world.ok(
        "follow.calendar",
        json!({
            "origin": { "ref": "calendar:work", "label": "Gmail: Work", "device_id": "phone-1" },
            "records": [{ "external_id": external, "fields": fields }],
            "complete": complete,
        }),
    )
}

fn series_fields(overrides: serde_json::Value) -> serde_json::Value {
    json!({
        "title": "Standup", "starts": "2026-03-02T09:00:00", "ends": "2026-03-02T09:30:00",
        "zone": "Europe/Paris", "rule": "FREQ=WEEKLY", "overrides": overrides,
    })
}

fn window(shown: &[&str], moved: serde_json::Value) -> serde_json::Value {
    json!({ "from": "2026-03-01T00:00:00Z", "to": "2026-04-01T00:00:00Z",
            "shown": shown, "moved": moved })
}

const WEEKS: [&str; 5] = [
    "2026-03-02T09:00:00",
    "2026-03-09T09:00:00",
    "2026-03-16T09:00:00",
    "2026-03-23T09:00:00",
    "2026-03-30T09:00:00",
];

fn series_of(world: &World) -> String {
    world
        .text("SELECT entity_id FROM source", &[])
        .expect("followed")
}

#[test]
fn a_followed_series_skips_what_the_phone_does_not_show_and_moves_what_it_moved() {
    let world = World::new();
    let shown: Vec<&str> = WEEKS
        .iter()
        .copied()
        .filter(|k| *k != "2026-03-09T09:00:00")
        .collect();
    let moved = json!([{ "original_start": "2026-03-16T09:00:00", "starts": "2026-03-16T14:00:00",
                          "ends": "2026-03-16T14:30:00", "title": "Standup" }]);
    let told = record(
        &world,
        "uid:standup",
        series_fields(window(&shown, moved)),
        true,
    );
    assert_eq!(told["added"], 1, "{told}");
    let id = series_of(&world);
    // Zoned: the wall clock became its instant, the rule is supported.
    assert_eq!(
        world
            .text("SELECT starts FROM event WHERE id = ?1", &[&id])
            .as_deref(),
        Some("2026-03-02T08:00:00.000Z")
    );
    assert_eq!(
        world.count("SELECT rule_supported FROM event WHERE id = ?1", &[&id]),
        1
    );
    // The skipped week is a skip; the moved one is moved; the title it shares is not copied.
    assert_eq!(
        world.days(&id),
        [
            ("2026-03-09T09:00:00".to_owned(), 1, None),
            (
                "2026-03-16T09:00:00".to_owned(),
                0,
                Some("2026-03-16T13:00:00.000Z".to_owned())
            ),
        ]
    );
    assert_eq!(
        world.text(
            "SELECT title FROM occurrence WHERE series_id = ?1 AND cancelled = 0",
            &[&id]
        ),
        None
    );
}

#[test]
fn the_phone_does_not_undo_a_day_the_member_changed_and_a_slid_window_forgets_nothing() {
    let world = World::new();
    let shown: Vec<&str> = WEEKS
        .iter()
        .copied()
        .filter(|k| *k != "2026-03-09T09:00:00")
        .collect();
    record(
        &world,
        "uid:standup",
        series_fields(window(&shown, json!([]))),
        true,
    );
    let id = series_of(&world);
    // The member brings the skipped week back, and skips another.
    world.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-09T09:00:00", "scope": "occurrence",
                "action": "restore" }),
    );
    world.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-03-23T09:00:00", "scope": "occurrence",
                "action": "skip" }),
    );
    // The phone says the same again: the member's days stand.
    record(
        &world,
        "uid:standup",
        series_fields(window(&shown, json!([]))),
        true,
    );
    assert_eq!(
        world.days(&id),
        [("2026-03-23T09:00:00".to_owned(), 1, None)]
    );
    // The phone now drops the 30th over a window that slid past the 2nd: the day the member
    // brought back and the day the member skipped stand, and the one nobody touched follows.
    let shown_now = [
        "2026-03-09T09:00:00",
        "2026-03-16T09:00:00",
        "2026-03-23T09:00:00",
    ];
    let slid = json!({ "from": "2026-03-08T00:00:00Z", "to": "2026-04-01T00:00:00Z",
                       "shown": shown_now, "moved": [] });
    record(&world, "uid:standup", series_fields(slid), true);
    assert_eq!(
        world.days(&id),
        [
            ("2026-03-23T09:00:00".to_owned(), 1, None),
            ("2026-03-30T09:00:00".to_owned(), 1, None),
        ]
    );
}
