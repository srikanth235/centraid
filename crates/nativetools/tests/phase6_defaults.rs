//! Phase 6, slices P2.1 and P2.2 of #1044: the `next` default by the shape of the call, and what
//! an else/other/after cue leaves out.
//!
//! - a read written as `order: date asc`, `limit: 1` and a `when` from today is a next-query
//!   however it is spelled, and a cancelled row is never the next one (`ground.rs`);
//! - "what else", "the one after", "besides X" leave out what the previous answer showed
//!   (`follow.rs`, D-1044-8).

mod common;

use centraid_nativetools::Flags;
use centraid_nativetools::ground::Defaults;
use common::{World, call, ids, seeded_with};
use serde_json::{Value, json};

const TODAY: &str = common::TODAY;

fn said(response: &Value) -> &str {
    response["text"].as_str().unwrap_or_default()
}

fn rows_of(response: &Value) -> Vec<String> {
    let mut out = ids(&response["effect"]["rows"]);
    if out.is_empty() {
        out = ids(&response["effect"]["answer"]["rows"]);
    }
    out.sort();
    out
}

fn sorted(world: &World, keys: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = keys.iter().map(|key| world.id(key)).collect();
    out.sort();
    out
}

/// Standups: a cancelled one first, then three upcoming; a past one and a cancelled past one.
/// Chores: a cancelled, a completed and an open one, in that order.
fn world() -> World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).unwrap();
    let events = world["events"].as_array_mut().unwrap();
    for (key, start, cancelled) in [
        ("sb_old", "2026-09-20T09:00", false),
        ("sb_old_off", "2026-09-25T09:00", true),
        ("sb_off", "2026-09-28T09:00", true),
        ("sb1", "2026-10-04T09:00", false),
        ("sb2", "2026-10-05T09:00", false),
        ("sb3", "2026-10-06T09:00", false),
    ] {
        events.push(json!({"key": key, "name": "Standup", "start": start, "cancelled": cancelled}));
    }
    let tasks = world["tasks"].as_array_mut().unwrap();
    tasks.push(
        json!({"key": "ch_off", "name": "Chore", "due": "2026-09-28", "status": "cancelled"}),
    );
    tasks.push(
        json!({"key": "ch_done", "name": "Chore", "due": "2026-09-29", "status": "completed"}),
    );
    tasks.push(json!({"key": "ch_open", "name": "Chore", "due": "2026-10-01"}));
    seeded_with(&world)
}

fn session_with(world: &World, defaults: Defaults) -> centraid_nativetools::Session {
    world.session_with(
        TODAY,
        Flags {
            defaults,
            ..Flags::default()
        },
    )
}

/// The next-query a model writes with order, limit and `when`.
fn next_call(kind: &str, name: &str, when: Value) -> Value {
    json!({"kind": kind, "name": name, "order": "date asc", "limit": 1, "when": when})
}

fn from_today() -> Value {
    json!({"from": {"unit": "day", "rel": 0}})
}

// ---------------------------------------------------------------------------------------------
// P2.1 next, by call shape

#[test]
fn a_next_written_as_order_limit_and_when_skips_a_cancelled_event() {
    let world = world();
    let mut session = world.session();
    session.user("when's the next standup");
    let reply = call(
        &mut session,
        "answer",
        next_call("event", "Standup", from_today()),
    );
    assert_eq!(rows_of(&reply), sorted(&world, &["sb1"]), "{reply}");
    assert!(
        said(&reply).contains(
            "next: the call reads the next one; left out cancelled rows (status != cancelled)."
        ),
        "{reply}"
    );
}

#[test]
fn every_spelling_of_from_today_is_a_next_query() {
    let world = world();
    for when in [
        from_today(),
        json!({"from": {"date": "2026-09-27"}}),
        json!({"from": {"date": "2026-09-27"}, "to": {"unit": "month", "rel": 3}}),
        json!({"from": {"unit": "week", "rel": 0, "weekday": 7}}),
        json!({"date": "2026-09-27"}),
    ] {
        let mut session = world.session();
        session.user("when's the next standup");
        let compiled = session.compile(&json!({
            "intent": "read", "kind": "event", "name": "Standup",
            "order": "date asc", "limit": 1, "when": when,
        }));
        assert_eq!(
            compiled["call"]["args"]["where"], "status != cancelled",
            "{when}: {compiled}"
        );
    }
}

#[test]
fn a_next_by_the_slot_skips_a_cancelled_event_too() {
    let world = world();
    let mut session = world.session();
    session.user("when's the next standup");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "event", "name": "Standup"}),
    );
    assert_eq!(rows_of(&reply), sorted(&world, &["sb1"]), "{reply}");
    assert!(said(&reply).contains("next:"), "{reply}");
}

#[test]
fn the_next_task_is_an_active_one() {
    let world = world();
    let mut session = world.session();
    session.user("what's the next chore due");
    let reply = call(
        &mut session,
        "answer",
        next_call("task", "Chore", from_today()),
    );
    // the open one is the earliest of those left; the cancelled and the completed are not
    let compiled = session.compile(&json!({
        "intent": "read", "kind": "task", "name": "Chore",
        "order": "date asc", "limit": 1, "when": {"from": {"date": "2026-09-27"}},
    }));
    assert_eq!(
        compiled["call"]["args"]["where"], "status != completed and status != cancelled",
        "{compiled}"
    );
    assert!(
        said(&reply).contains("left out completed and cancelled rows"),
        "{reply}"
    );
    assert_eq!(rows_of(&reply), sorted(&world, &["ch_open"]), "{reply}");
}

#[test]
fn a_last_written_as_order_limit_and_when_skips_a_cancelled_event() {
    let world = world();
    let mut session = world.session();
    session.user("when was the last standup");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "event", "name": "Standup", "order": "date desc", "limit": 1,
               "when": {"to": {"unit": "day", "rel": 0}}}),
    );
    assert_eq!(rows_of(&reply), sorted(&world, &["sb_old"]), "{reply}");
    assert!(
        said(&reply).contains("last: the call reads the last one; left out cancelled rows"),
        "{reply}"
    );
}

#[test]
fn a_status_of_its_own_or_a_word_that_asks_for_cancelled_rows_stands() {
    let world = world();
    let mut session = world.session();
    session.user("when's the next standup");
    let own = call(
        &mut session,
        "answer",
        json!({"kind": "event", "name": "Standup", "order": "date asc", "limit": 1,
               "when": from_today(), "where": "status = cancelled"}),
    );
    assert_eq!(rows_of(&own), sorted(&world, &["sb_off"]), "{own}");
    session.user("what's the next cancelled standup");
    let asked = call(
        &mut session,
        "answer",
        next_call("event", "Standup", from_today()),
    );
    assert_eq!(rows_of(&asked), sorted(&world, &["sb_off"]), "{asked}");
    assert!(!said(&asked).contains("left out"), "{asked}");
}

#[test]
fn a_read_that_is_not_the_next_shape_is_unchanged() {
    let world = world();
    let mut session = world.session();
    session.user("show the standups");
    // limit 2, a span that starts in the past, an order by name: none is a next-query
    for args in [
        json!({"kind": "event", "name": "Standup", "order": "date asc", "limit": 2,
               "when": from_today()}),
        json!({"kind": "event", "name": "Standup", "order": "date asc", "limit": 1,
               "when": {"from": {"date": "2026-09-01"}}}),
        json!({"kind": "event", "name": "Standup", "order": "name asc", "limit": 1,
               "when": from_today()}),
    ] {
        let compiled = session.compile(&json!({
            "intent": "read", "kind": args["kind"], "name": args["name"],
            "order": args["order"], "limit": args["limit"], "when": args["when"],
        }));
        assert!(
            compiled["call"]["args"].get("where").is_none(),
            "{args}: {compiled}"
        );
    }
}

#[test]
fn the_switches_turn_the_shape_default_off() {
    let world = world();
    let mut session = session_with(
        &world,
        Defaults {
            next: false,
            ..Defaults::default()
        },
    );
    session.user("when's the next standup");
    let reply = call(
        &mut session,
        "answer",
        next_call("event", "Standup", from_today()),
    );
    assert_eq!(rows_of(&reply), sorted(&world, &["sb_off"]), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// P2.2 exclude what was shown

/// Turn 1 reads the next standup; turn 2 says `message`; the call of turn 2 is `args`.
fn follow_up(world: &World, message: &str, args: Value) -> Value {
    let mut session = world.session();
    session.user("when's the next standup");
    call(
        &mut session,
        "answer",
        next_call("event", "Standup", from_today()),
    );
    session.user(message);
    call(&mut session, "answer", args)
}

#[test]
fn the_one_after_leaves_out_the_row_just_shown_and_keeps_limit_1() {
    let world = world();
    let reply = follow_up(
        &world,
        "and the one after that",
        next_call("event", "Standup", from_today()),
    );
    assert_eq!(rows_of(&reply), sorted(&world, &["sb2"]), "{reply}");
    assert!(said(&reply).contains("(excluding @1)"), "{reply}");
}

#[test]
fn the_next_one_after_that_is_the_next_by_the_slot_without_the_one_shown() {
    let world = world();
    let reply = follow_up(
        &world,
        "next one after that",
        json!({"kind": "event", "name": "Standup"}),
    );
    assert_eq!(rows_of(&reply), sorted(&world, &["sb2"]), "{reply}");
    assert!(said(&reply).contains("(excluding @1)"), "{reply}");
}

#[test]
fn what_else_leaves_out_the_previous_result() {
    let world = world();
    for message in ["what else is there", "anything else", "the other ones"] {
        let reply = follow_up(
            &world,
            message,
            json!({"kind": "event", "name": "Standup", "when": from_today()}),
        );
        // the cancelled standup is no "next" one, but it is one the person has not been shown
        assert_eq!(
            rows_of(&reply),
            sorted(&world, &["sb_off", "sb2", "sb3"]),
            "{message}: {reply}"
        );
        assert!(
            said(&reply).contains("(excluding @1)"),
            "{message}: {reply}"
        );
    }
}

#[test]
fn a_message_without_a_cue_is_unchanged() {
    let world = world();
    let reply = follow_up(
        &world,
        "show the standups again",
        json!({"kind": "event", "name": "Standup", "when": from_today()}),
    );
    assert_eq!(
        rows_of(&reply),
        sorted(&world, &["sb_off", "sb1", "sb2", "sb3"]),
        "{reply}"
    );
    assert!(!said(&reply).contains("excluding"), "{reply}");
    // a date is no cue: "after friday", "the other day"
    for message in ["what's on after friday", "what did i do the other day"] {
        let reply = follow_up(
            &world,
            message,
            json!({"kind": "event", "name": "Standup", "when": from_today()}),
        );
        assert!(!said(&reply).contains("excluding"), "{message}: {reply}");
    }
}

#[test]
fn an_exclude_of_its_own_stands() {
    let world = world();
    let mut session = world.session();
    session.user("when's the next standup");
    call(
        &mut session,
        "answer",
        next_call("event", "Standup", from_today()),
    );
    session.user("what else is there");
    // an `exclude` the call states is the call's: the cancelled standup is left out, not @1
    let found = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Standup", "when": from_today()}),
    );
    let cancelled = found["effect"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == world.id("sb_off"))
        .map(|row| format!("#{}", row["n"]))
        .expect("the cancelled standup is listed");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "event", "name": "Standup", "when": from_today(), "exclude": cancelled}),
    );
    assert!(!said(&reply).contains("(excluding @"), "{reply}");
    assert_eq!(
        rows_of(&reply),
        sorted(&world, &["sb1", "sb2", "sb3"]),
        "{reply}"
    );
}

#[test]
fn besides_a_named_row_leaves_out_that_row() {
    let world = world();
    let mut session = world.session();
    session.user("what events do i have");
    let shown = call(&mut session, "answer", json!({"kind": "event"}));
    let dentist = shown["effect"]["answer"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == world.id("dentist"))
        .map(|row| format!("#{}", row["n"]))
        .expect("the dentist is shown");
    session.user("anything besides the dentist");
    let reply = call(&mut session, "answer", json!({"kind": "event"}));
    assert!(
        said(&reply).contains(&format!("(excluding {dentist})")),
        "{reply}"
    );
    assert!(!rows_of(&reply).contains(&world.id("dentist")), "{reply}");
    assert_eq!(
        rows_of(&reply).len(),
        shown["effect"]["answer"]["rows"].as_array().unwrap().len() - 1,
        "{reply}"
    );
    // a name that fits no row of the focus: what was shown
    session.user("what events do i have");
    call(&mut session, "answer", json!({"kind": "event"}));
    session.user("apart from the yoga retreat");
    let reply = call(&mut session, "answer", json!({"kind": "event"}));
    assert!(said(&reply).contains("(excluding @"), "{reply}");
    // "not the X" needs the row
    session.user("what events do i have");
    call(&mut session, "answer", json!({"kind": "event"}));
    session.user("not the yoga retreat");
    let reply = call(&mut session, "answer", json!({"kind": "event"}));
    assert!(!said(&reply).contains("excluding"), "{reply}");
}

#[test]
fn a_cue_over_another_kind_or_a_count_leaves_nothing_out() {
    let world = world();
    let mut session = world.session();
    session.user("when's the next standup");
    call(
        &mut session,
        "answer",
        next_call("event", "Standup", from_today()),
    );
    session.user("what else is on my chore list");
    let tasks = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "Chore"}),
    );
    assert!(!said(&tasks).contains("excluding"), "{tasks}");
    session.user("how many other standups");
    let count = call(
        &mut session,
        "answer",
        json!({"kind": "event", "name": "Standup", "op": "count"}),
    );
    assert!(!said(&count).contains("excluding"), "{count}");
}

#[test]
fn the_switch_turns_the_exclusion_off() {
    let world = world();
    let mut session = session_with(
        &world,
        Defaults {
            exclude: false,
            ..Defaults::default()
        },
    );
    session.user("when's the next standup");
    call(
        &mut session,
        "answer",
        next_call("event", "Standup", from_today()),
    );
    session.user("what else is there");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "event", "name": "Standup", "when": from_today()}),
    );
    assert_eq!(
        rows_of(&reply),
        sorted(&world, &["sb_off", "sb1", "sb2", "sb3"]),
        "{reply}"
    );
}

#[test]
fn compile_records_the_exclusion_as_a_default_and_the_run_says_so() {
    let world = world();
    let mut session = world.session();
    session.user("when's the next standup");
    call(
        &mut session,
        "answer",
        next_call("event", "Standup", from_today()),
    );
    session.user("what else is there");
    let compiled = session.compile(&json!({
        "intent": "read", "kind": "event", "name": "Standup",
        "when": {"from": {"unit": "day", "rel": 0}},
    }));
    assert!(compiled.get("refused").is_none(), "{compiled}");
    assert!(
        compiled["stated"]["args"].get("exclude").is_none(),
        "{compiled}"
    );
    assert_eq!(
        compiled["call"]["args"]["exclude"],
        json!(["@1"]),
        "{compiled}"
    );
    assert!(
        compiled["normalized"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["rule"] == "default" && entry["default"] == "exclude"),
        "{compiled}"
    );
    let executed = &compiled["call"];
    let reply = session.call(executed["tool"].as_str().unwrap(), &executed["args"]);
    assert_eq!(
        rows_of(&reply),
        sorted(&world, &["sb_off", "sb2", "sb3"]),
        "{reply}"
    );
    assert!(said(&reply).contains("(excluding @1)"), "{reply}");
    assert!(
        reply["effect"]["normalized"]
            .as_array()
            .is_some_and(|entries| entries
                .iter()
                .any(|entry| entry["rule"] == "default" && entry["default"] == "exclude")),
        "{reply}"
    );
}

#[test]
fn a_cue_after_a_write_leaves_the_written_row_out() {
    // "move the dentist", then "what else is on": the previous turn wrote, it did not answer, so
    // no result is left out, but the row the write changed is what the person has just dealt
    // with (B1, #1044 r3: this replaces "any message after a turn that wrote is unchanged")
    let world = world();
    let mut session = world.session();
    session.user("move the dentist to tuesday");
    call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Dentist",
               "args": "to: {\"date\":\"2026-09-29\"}"}),
    );
    session.user("what else is on");
    let reply = call(&mut session, "answer", json!({"kind": "event"}));
    assert!(said(&reply).contains("(excluding #"), "{reply}");
    assert!(!said(&reply).contains("(excluding @"), "{reply}");
    assert!(
        !rows_of(&reply).contains(&world.id("dentist")),
        "the written row is left out: {reply}"
    );
    // the same words after a read do leave the shown rows out
    session.user("what events do i have");
    call(&mut session, "answer", json!({"kind": "event"}));
    session.user("what else is on");
    let reply = call(&mut session, "answer", json!({"kind": "event"}));
    assert!(said(&reply).contains("(excluding @"), "{reply}");
}
