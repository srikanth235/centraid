//! The status convention (D-1044-7): in a `where`, `status = open` selects the
//! active rows. A task had a started state beside open; the model of #1135 has none (a task is
//! open, done or cancelled), so the rule widens nothing and these tests hold what is left of it:
//! the status words select exactly themselves, `!=` and `in` agree with them, and a word the
//! task no longer has is an error that names the three.
//!
//! The fixture has one cancelled task fewer than these tests want, so each test builds a world
//! with two more open tasks and one cancelled task beside the fixture's open, completed and
//! trashed ones.

mod common;

use centraid_nativetools::meta::Kind;
use centraid_nativetools::whr;
use common::{call, diff_rows, ids, seeded_with, text};
use serde_json::{Value, json};

/// The fixture plus `survey` and `plumber` (open) and `parked` (cancelled). Tasks that are not
/// trashed: open `cabin`, `reed`, `outline`, `pay`, `survey`, `plumber`; completed `report`;
/// cancelled `parked`.
fn world_in_progress() -> common::World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).unwrap();
    let tasks = world["tasks"].as_array_mut().unwrap();
    tasks.push(json!({"key": "survey", "name": "Survey the garden"}));
    tasks.push(json!({"key": "plumber", "name": "Call the plumber", "effort": 15}));
    tasks.push(json!({"key": "parked", "name": "Park the car", "status": "cancelled"}));
    seeded_with(&world)
}

const OPEN: [&str; 6] = ["cabin", "reed", "outline", "pay", "survey", "plumber"];
const COMPLETED: [&str; 1] = ["report"];
const CANCELLED: [&str; 1] = ["parked"];

/// The sorted ids of the keys of every group given.
fn keys(world: &common::World, groups: &[&[&str]]) -> Vec<String> {
    let mut out: Vec<String> = groups
        .iter()
        .flat_map(|group| group.iter())
        .map(|key| world.id(key))
        .collect();
    out.sort();
    out
}

/// The sorted ids a `find` over `kind` with `clause` selects.
fn selected(world: &common::World, kind: &str, clause: &str) -> Vec<String> {
    let mut session = world.session();
    session.user("");
    let response = call(&mut session, "find", json!({"kind": kind, "where": clause}));
    assert!(
        response["effect"]["rows"].is_array(),
        "{clause}: {}",
        response["text"]
    );
    let mut out = ids(&response["effect"]["rows"]);
    out.sort();
    out
}

fn tasks(world: &common::World, clause: &str) -> Vec<String> {
    selected(world, "task", clause)
}

#[test]
fn open_selects_the_open_rows_and_nothing_finished() {
    let world = world_in_progress();
    let active = keys(&world, &[&OPEN]);
    // the bare word, quoted, and in any case: all one reading
    for clause in [
        "status = open",
        "status = \"open\"",
        "status = Open",
        "status=open",
        "STATUS = OPEN",
    ] {
        assert_eq!(tasks(&world, clause), active, "{clause}");
    }
    let rows = tasks(&world, "status = open");
    for key in OPEN {
        assert!(rows.contains(&world.id(key)), "{key} is active");
    }
    for key in COMPLETED.iter().chain(CANCELLED.iter()) {
        assert!(!rows.contains(&world.id(key)), "{key} is finished");
    }
}

#[test]
fn in_with_open_reads_open_the_same_way() {
    let world = world_in_progress();
    let active = keys(&world, &[&OPEN]);
    for clause in [
        "status in (\"open\")",
        "status in (open)",
        "status in(\"open\")",
        "status in (\"Open\")",
    ] {
        assert_eq!(tasks(&world, clause), active, "{clause}");
    }
    // `open` beside another status adds the open rows to it
    assert_eq!(
        tasks(&world, "status in (\"open\", \"completed\")"),
        keys(&world, &[&OPEN, &COMPLETED])
    );
    assert_eq!(
        tasks(&world, "status in (\"open\", \"cancelled\")"),
        keys(&world, &[&OPEN, &CANCELLED])
    );
}

#[test]
fn every_other_status_keeps_its_own_meaning() {
    let world = world_in_progress();
    assert_eq!(
        tasks(&world, "status = completed"),
        keys(&world, &[&COMPLETED])
    );
    assert_eq!(
        tasks(&world, "status = cancelled"),
        keys(&world, &[&CANCELLED])
    );
    assert_eq!(
        tasks(&world, "status in (\"completed\", \"cancelled\")"),
        keys(&world, &[&COMPLETED, &CANCELLED])
    );
    assert_eq!(
        tasks(&world, "status != completed"),
        keys(&world, &[&OPEN, &CANCELLED])
    );
    assert_eq!(
        tasks(&world, "status != cancelled"),
        keys(&world, &[&OPEN, &COMPLETED])
    );
}

#[test]
fn not_open_leaves_out_every_open_row() {
    let world = world_in_progress();
    assert_eq!(
        tasks(&world, "status != open"),
        keys(&world, &[&COMPLETED, &CANCELLED])
    );
}

#[test]
fn the_rule_composes_with_the_other_conditions() {
    let world = world_in_progress();
    // plumber, cabin and reed are open with an effort
    assert_eq!(
        tasks(&world, "status = open and effort is set"),
        keys(&world, &[&["cabin", "reed", "plumber"]])
    );
    assert_eq!(
        tasks(&world, "status = open and effort < 20"),
        keys(&world, &[&["plumber"]])
    );
    assert_eq!(
        tasks(&world, "effort is empty and status = open"),
        keys(&world, &[&["outline", "pay", "survey"]])
    );
}

#[test]
fn an_events_status_words_select_themselves() {
    // An event is confirmed, tentative or cancelled.
    let world = world_in_progress();
    assert_eq!(
        selected(&world, "event", "status = cancelled"),
        keys(&world, &[&["party"]])
    );
    assert_eq!(
        selected(&world, "event", "status = tentative"),
        keys(&world, &[&["tabla", "dentist", "mallaig"]])
    );
    assert_eq!(
        selected(&world, "event", "status != cancelled"),
        keys(&world, &[&["tabla", "dentist", "mallaig"]])
    );
}

#[test]
fn a_count_and_a_bulk_write_read_the_same_rows() {
    let world = world_in_progress();
    let mut session = world.session();
    session.user("how many tasks are open");
    let count = call(
        &mut session,
        "answer",
        json!({"op": "count", "kind": "task", "where": "status = open"}),
    );
    assert_eq!(count["effect"]["value"]["values"][0]["amount"], 6);

    // a write over several rows names them through the result of a find (a
    // selector that fits several is `ambiguous:`)
    session.user("tick off everything open with an effort");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status = open and effort is set"}),
    );
    let result = found["effect"]["result"].as_str().unwrap().to_owned();
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": result}),
    );
    let changed: Vec<(String, Value)> = diff_rows(&done)
        .iter()
        .map(|row| {
            (
                row["id"].as_str().unwrap_or_default().to_owned(),
                row["fields"]["status"].clone(),
            )
        })
        .collect();
    let mut got: Vec<String> = changed.iter().map(|(id, _)| id.clone()).collect();
    got.sort();
    assert_eq!(
        got,
        keys(&world, &[&["cabin", "reed", "plumber"]]),
        "{}",
        done["text"]
    );
    let plumber = changed
        .iter()
        .find(|(id, _)| *id == world.id("plumber"))
        .expect("the plumber is completed with the open ones");
    assert_eq!(plumber.1, json!(["open", "completed"]));
}

#[test]
fn a_narrowing_follow_up_reads_the_rule_too() {
    // "just the open ones" over an earlier result: `within` plus the condition
    let world = world_in_progress();
    let mut session = world.session();
    session.user("what tasks are there");
    let all = call(&mut session, "find", json!({"kind": "task"}));
    let result = all["effect"]["result"].as_str().unwrap().to_owned();
    session.user("just the open ones");
    let open = call(
        &mut session,
        "find",
        json!({"within": result, "where": "status = open"}),
    );
    let mut got = ids(&open["effect"]["rows"]);
    got.sort();
    assert_eq!(got, keys(&world, &[&OPEN]), "{}", open["text"]);
}

#[test]
fn an_edit_writes_the_status_it_is_given() {
    // A status is three commands of the vault, one for each word; an edit of it is the command of
    // the word it is given, and a later selection finds the row where the word puts it.
    let world = world_in_progress();
    let mut session = world.session();
    session.user("call off the garden survey");
    let edited = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Survey the garden",
               "args": "status: cancelled"}),
    );
    let change = diff_rows(&edited)
        .iter()
        .find_map(|row| row["fields"].get("status").cloned())
        .unwrap_or_default();
    assert_eq!(change, json!(["open", "cancelled"]), "{}", edited["text"]);
    assert_eq!(
        tasks(&world, "status = cancelled"),
        keys(&world, &[&CANCELLED, &["survey"]])
    );
}

#[test]
fn an_unknown_status_still_names_every_value() {
    // `active` is not a status, and nor is `in_progress` any more: the error says which are
    let world = world_in_progress();
    let mut session = world.session();
    session.user("");
    let refused = text(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status = active"}),
    );
    assert!(
        refused.starts_with("error: status has no value \"active\"."),
        "{refused}"
    );
    assert!(refused.contains("open, completed, cancelled"), "{refused}");
    session.user("");
    let started = text(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status = in_progress"}),
    );
    assert!(
        started.starts_with("error: status has no value \"in_progress\"."),
        "{started}"
    );
}

#[test]
fn the_status_condition_parses_as_it_always_did() {
    // The rule is in matching, not in parsing: one condition per clause, and
    // `in` keeps the members as written.
    for clause in [
        "status = open",
        "status != open",
        "status in (\"open\")",
        "status in (\"open\", \"completed\")",
    ] {
        assert_eq!(whr::parse(Kind::Task, clause).unwrap().len(), 1, "{clause}");
    }
    assert!(whr::parse(Kind::Task, "status = open or status = completed").is_err());
}

#[test]
fn in_is_the_union_of_its_members() {
    // `in (a, b, …)` selects exactly the rows some `= a`, `= b`, … selects,
    // the one `or` the language has is still the union of its members. Every non-empty subset of
    // the three statuses.
    let world = world_in_progress();
    let statuses = ["open", "completed", "cancelled"];
    for mask in 1_u32..(1 << statuses.len()) {
        let pick: Vec<&str> = statuses
            .iter()
            .enumerate()
            .filter(|(at, _)| mask & (1 << at) != 0)
            .map(|(_, status)| *status)
            .collect();
        let list = pick
            .iter()
            .map(|status| format!("\"{status}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let together = tasks(&world, &format!("status in ({list})"));
        let mut union: Vec<String> = pick
            .iter()
            .flat_map(|status| tasks(&world, &format!("status = {status}")))
            .collect();
        union.sort();
        union.dedup();
        assert_eq!(together, union, "in ({list})");
    }
}
