//! Round 3 of #1044, the runtime slice: C1 to C3 (the defects of the r2 audit) and the runtime
//! halves of B1, B2, B7 and B8. C4 (undo of an event's `cancel`) needs a vault command that does
//! not exist; its test is the one that pins the refusal (`undo_of_a_cancel_...`).

mod common;

use common::{World, call, find_in_turn, ids, seeded_with};
use serde_json::{Value, json};

fn text(response: &Value) -> &str {
    response["text"].as_str().unwrap_or_default()
}

fn tool_of(response: &Value) -> &str {
    response["effect"]["tool"].as_str().unwrap_or_default()
}

fn world_with(edit: impl FnOnce(&mut Value)) -> World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).expect("the fixture");
    edit(&mut world);
    seeded_with(&world)
}

fn push(world: &mut Value, section: &str, row: Value) {
    world[section].as_array_mut().expect("a section").push(row);
}

// ---------------------------------------------------------------------------------------------
// C1: a message that states a row's whole nickname singles that row out

/// World B's Dans: a person with a nickname, a task that names it, a namesake.
fn dans() -> World {
    world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "dan_k", "name": "Dan Kowalski", "role": "neighbor", "nickname": "Big Dan"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "drill", "name": "Return Big Dan's drill"}),
        );
        push(
            world,
            "people",
            json!({"key": "dan_o", "name": "Dan O'Brien", "role": "colleague"}),
        );
    })
}

#[test]
fn a_message_that_states_a_whole_nickname_singles_the_row_out() {
    let world = dans();
    let mut session = world.session();
    session.user("log a coffee with big dan, we got talking about the fence");
    let dan = find_in_turn(&mut session, "person", "Dan Kowalski");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "rows": dan, "args": "kind: coffee"}),
    );
    assert_ne!(tool_of(&reply), "ask", "no ask: {reply}");
    assert!(text(&reply).starts_with("logged:"), "{reply}");
    assert!(text(&reply).contains("Dan Kowalski"), "{reply}");
}

#[test]
fn a_nickname_that_is_not_stated_whole_singles_nothing_out() {
    // "dan" alone fits both Dans; the nickname is not said, so the pick is still asked about
    let world = dans();
    let mut session = world.session();
    session.user("log a coffee with dan, we got talking about the fence");
    let dan = find_in_turn(&mut session, "person", "Dan Kowalski");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "rows": dan, "args": "kind: coffee"}),
    );
    assert_eq!(tool_of(&reply), "ask", "{reply}");
    let options = ids(&reply["effect"]["ask"]["options"]);
    assert_eq!(options.len(), 2, "{reply}");
}

#[test]
fn the_other_dan_is_still_asked_about_when_the_message_states_the_nickname() {
    // the nickname singles out Dan Kowalski; a pick of the other Dan is the model's guess
    let world = dans();
    let mut session = world.session();
    session.user("log a coffee with big dan, we got talking about the fence");
    let dan = find_in_turn(&mut session, "person", "Dan O'Brien");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "rows": dan, "args": "kind: coffee"}),
    );
    assert_eq!(tool_of(&reply), "ask", "{reply}");
}

#[test]
fn a_by_name_act_by_the_nickname_is_not_asked_about() {
    let world = dans();
    let mut session = world.session();
    session.user("log a coffee with big dan, we got talking about the fence");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Big Dan", "args": "kind: coffee"}),
    );
    assert_ne!(tool_of(&reply), "ask", "no ask: {reply}");
    assert!(text(&reply).starts_with("logged:"), "{reply}");
}

#[test]
fn a_by_name_act_that_resolves_to_one_row_by_the_persons_own_words_is_not_rechecked() {
    // the nickname is "Big Fence Dan" and the message says "dan" and "fence" only: the whole
    // nickname is not stated, "dan" fits two rows by name, but the call's own name (the person's
    // word "fence") reached one row: a by-name act takes none of the pick's steps (SPEC 3.3 (c))
    let world = world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "dan_k", "name": "Dan Kowalski", "nickname": "Big Fence Dan"}),
        );
        push(
            world,
            "people",
            json!({"key": "dan_o", "name": "Dan O'Brien"}),
        );
    });
    let mut session = world.session();
    session.user("log a coffee with dan, the fence guy");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Fence", "args": "kind: coffee"}),
    );
    assert_ne!(tool_of(&reply), "ask", "no ask: {reply}");
    assert!(text(&reply).starts_with("logged:"), "{reply}");
}

#[test]
fn a_by_name_act_by_an_over_specific_name_is_still_asked_about() {
    // the model added a word the person did not say ("almeida"): its lookup bears nothing out
    let world = world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "pedro_a", "name": "Pedro Almeida"}),
        );
        push(
            world,
            "people",
            json!({"key": "pedro_c", "name": "Pedro Costa"}),
        );
    });
    let mut session = world.session();
    session.user("star pedro");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Pedro Almeida"}),
    );
    assert_eq!(tool_of(&reply), "ask", "{reply}");
}

// ---------------------------------------------------------------------------------------------
// C2: "one" settles the row only when it stands for one

fn mark_tests() -> World {
    world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "m9b", "name": "Mark 9B tests", "priority": 2}),
        );
        push(
            world,
            "tasks",
            json!({"key": "m9c", "name": "Mark 9C tests", "priority": 2}),
        );
    })
}

fn bump(message: &str) -> Value {
    let world = mark_tests();
    let mut session = world.session();
    session.user(message);
    let row = find_in_turn(&mut session, "task", "Mark 9B tests");
    call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": row, "args": "priority: 1"}),
    )
}

#[test]
fn a_number_after_a_number_noun_settles_no_row() {
    for message in [
        "bump the mark 9 tests to priority one",
        "bump the mark 9 tests to level one",
        "bump the mark 9 tests to step one",
        "bump the mark 9 tests to day one",
    ] {
        let reply = bump(message);
        assert_eq!(tool_of(&reply), "ask", "{message}: {reply}");
    }
}

#[test]
fn one_that_stands_for_a_row_settles_it() {
    for message in [
        "bump the mark 9 one to priority 1",
        "bump one of the mark 9 tests to priority 1",
        "bump the other one of the mark 9 tests to priority 1",
        "bump the mark 9 ones to priority 1",
    ] {
        let reply = bump(message);
        assert_ne!(tool_of(&reply), "ask", "{message}: {reply}");
        assert!(text(&reply).starts_with("edited:"), "{message}: {reply}");
    }
}

// ---------------------------------------------------------------------------------------------
// C3: `within` over a result of trashed rows keeps them

#[test]
fn within_a_result_of_trashed_rows_keeps_those_rows() {
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "lb1", "name": "Return library books", "trashed": true, "effort": 10}),
        );
        push(
            world,
            "tasks",
            json!({"key": "lb2", "name": "Return library books", "trashed": true}),
        );
    });
    let mut session = world.session();
    session.user("which of the deleted library book tasks have an effort");
    let first = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "return library books", "trashed": true}),
    );
    assert_eq!(
        first["effect"]["rows"].as_array().map(Vec::len),
        Some(2),
        "{first}"
    );
    let narrowed = call(
        &mut session,
        "answer",
        json!({"kind": "task", "within": "@1", "where": "effort is set"}),
    );
    assert_eq!(
        ids(&narrowed["effect"]["answer"]["rows"]),
        vec![world.id("lb1")],
        "{narrowed}"
    );
}

// ---------------------------------------------------------------------------------------------
// B2: "due" is a status word of a readout

fn due_world() -> World {
    world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "invoice", "name": "Send invoice", "due": "2026-09-28"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "flights", "name": "Book flights", "due": "2026-09-28",
                   "status": "completed", "completed": "2026-09-26T10:00"}),
        );
    })
}

fn due_rows(world: &World, message: &str, tool: &str, extra: Value) -> Value {
    let mut session = world.session();
    session.user(message);
    let mut args = json!({"kind": "task", "when": {"unit": "day", "rel": 1}});
    for (key, value) in extra.as_object().expect("an object") {
        args[key] = value.clone();
    }
    call(&mut session, tool, args)
}

fn rows_in(reply: &Value) -> Vec<String> {
    let mut out = ids(&reply["effect"]["answer"]["rows"]);
    out.sort();
    out
}

#[test]
fn due_asks_for_the_open_tasks_and_says_so() {
    let world = due_world();
    for message in [
        "what's due tomorrow",
        "anything due tomorrow",
        "how many are due tomorrow",
    ] {
        let reply = due_rows(&world, message, "answer", json!({}));
        assert_eq!(
            rows_in(&reply),
            vec![world.id("invoice")],
            "{message}: {reply}"
        );
        assert!(text(&reply).contains("status = open"), "{message}: {reply}");
    }
    let count = due_rows(
        &world,
        "how many are due tomorrow",
        "compute",
        json!({"op": "count"}),
    );
    assert_eq!(
        count["effect"]["value"]["values"][0]["amount"],
        json!(1),
        "{count}"
    );
}

#[test]
fn due_with_a_word_that_asks_for_every_status_stays_as_written() {
    let world = due_world();
    for message in [
        "what's due tomorrow, done or not",
        "everything due tomorrow",
        "all the tasks due tomorrow",
        "what was due tomorrow that is completed",
    ] {
        let reply = due_rows(&world, message, "answer", json!({}));
        assert_eq!(rows_in(&reply).len(), 2, "{message}: {reply}");
    }
}

#[test]
fn due_with_a_negated_done_is_still_open() {
    let world = due_world();
    let reply = due_rows(
        &world,
        "what's due tomorrow that i haven't done",
        "answer",
        json!({}),
    );
    assert_eq!(rows_in(&reply), vec![world.id("invoice")], "{reply}");
}

#[test]
fn due_does_not_touch_a_find_or_a_status_the_call_states() {
    let world = due_world();
    let found = due_rows(&world, "what's due tomorrow", "find", json!({}));
    assert_eq!(
        found["effect"]["rows"].as_array().map(Vec::len),
        Some(2),
        "{found}"
    );
    let stated = due_rows(
        &world,
        "what's due tomorrow",
        "answer",
        json!({"where": "status = completed"}),
    );
    assert_eq!(rows_in(&stated), vec![world.id("flights")], "{stated}");
}

// ---------------------------------------------------------------------------------------------
// B1: "what else" leaves out every row the conversation put in play

fn garlic() -> World {
    world_with(|world| {
        for (key, name) in [
            ("g_bread", "Garlic bread"),
            ("g_soup", "Garlic soup"),
            ("g_naan", "Garlic naan"),
        ] {
            push(
                world,
                "notes",
                json!({"key": key, "name": name, "body": "x"}),
            );
        }
        // Duarte is starred already: "star pedro" asks over the other two only
        for (key, name, starred) in [
            ("p_a", "Pedro Almeida", false),
            ("p_c", "Pedro Costa", false),
            ("p_d", "Pedro Duarte", true),
        ] {
            push(
                world,
                "people",
                json!({"key": key, "name": name, "starred": starred}),
            );
        }
    })
}

fn found(reply: &Value) -> Vec<String> {
    let mut out = ids(&reply["effect"]["rows"]);
    out.sort();
    out
}

fn sorted_ids(world: &World, keys: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = keys.iter().map(|key| world.id(key)).collect();
    out.sort();
    out
}

#[test]
fn what_else_leaves_out_the_row_the_previous_turns_write_changed() {
    let world = garlic();
    let mut session = world.session();
    session.user("add toasted to that note");
    let bread = find_in_turn(&mut session, "note", "Garlic bread");
    let wrote = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": bread, "args": "body: toasted"}),
    );
    assert!(text(&wrote).starts_with("edited:"), "{wrote}");
    session.user("any other notes with garlic");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "note", "name": "garlic"}),
    );
    assert_eq!(
        found(&reply),
        sorted_ids(&world, &["g_soup", "g_naan"]),
        "{reply}"
    );
    assert!(text(&reply).contains("(excluding "), "{reply}");
}

#[test]
fn what_else_leaves_out_the_options_of_the_ask_that_ended_the_previous_turn() {
    let world = garlic();
    let mut session = world.session();
    session.user("star pedro");
    let asked = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Pedro"}),
    );
    assert_eq!(tool_of(&asked), "ask", "{asked}");
    assert_eq!(
        asked["effect"]["ask"]["options"].as_array().map(Vec::len),
        Some(2)
    );
    session.user("any other pedros");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "pedro"}),
    );
    assert_eq!(found(&reply), sorted_ids(&world, &["p_d"]), "{reply}");
    assert!(text(&reply).contains("(excluding "), "{reply}");
}

#[test]
fn what_else_leaves_out_the_row_the_message_before_it_names() {
    let world = garlic();
    let mut session = world.session();
    session.user("what does the garlic soup note say");
    session.user("what other notes are there with garlic");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "note", "name": "garlic"}),
    );
    assert_eq!(
        found(&reply),
        sorted_ids(&world, &["g_bread", "g_naan"]),
        "{reply}"
    );
}

#[test]
fn besides_leaves_out_the_written_row_and_the_row_it_names() {
    let world = garlic();
    let mut session = world.session();
    session.user("add toasted to that note");
    let bread = find_in_turn(&mut session, "note", "Garlic bread");
    call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": bread, "args": "body: toasted"}),
    );
    session.user("which notes with garlic besides garlic soup");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "note", "name": "garlic"}),
    );
    assert_eq!(found(&reply), sorted_ids(&world, &["g_naan"]), "{reply}");
}

#[test]
fn rows_of_another_kind_are_never_left_out() {
    let world = garlic();
    let mut session = world.session();
    session.user("star pedro");
    call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Pedro"}),
    );
    session.user("what else is there with garlic");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "note", "name": "garlic"}),
    );
    assert_eq!(
        found(&reply),
        sorted_ids(&world, &["g_bread", "g_soup", "g_naan"]),
        "{reply}"
    );
}

#[test]
fn a_re_ask_without_a_cue_leaves_out_nothing() {
    let world = garlic();
    let mut session = world.session();
    session.user("add toasted to that note");
    let bread = find_in_turn(&mut session, "note", "Garlic bread");
    call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": bread, "args": "body: toasted"}),
    );
    session.user("which notes have garlic");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "note", "name": "garlic"}),
    );
    assert_eq!(found(&reply).len(), 3, "{reply}");
}

// ---------------------------------------------------------------------------------------------
// B7 and B8: the `dates:` line of a span

fn entries_on(today: &str, message: &str) -> Vec<String> {
    centraid_nativetools::phrases::read_dates(
        message,
        centraid_nativetools::dates::parse_now(today).expect("a date"),
    )
    .into_iter()
    .map(|reading| format!("{} = {}", reading.phrase, reading.resolution))
    .collect()
}

/// A Wednesday.
const WEDNESDAY: &str = "2026-08-05T10:00";

fn has(entries: &[String], wanted: &str) -> bool {
    entries.iter().any(|entry| entry == wanted)
}

#[test]
fn a_weekday_that_ends_a_span_counts_from_the_spans_start() {
    for (message, wanted) in [
        (
            "starred pics from last saturday till sunday 6pm",
            "sunday = 2026-08-02",
        ),
        (
            "from saturday last week up to sunday",
            "sunday = 2026-08-02",
        ),
        ("from last saturday through sunday", "sunday = 2026-08-02"),
        ("from tomorrow to sunday", "sunday = 2026-08-09"),
        ("from last monday until friday", "friday = 2026-07-31"),
        ("sunday till tuesday", "tuesday = 2026-08-11"),
    ] {
        let read = entries_on(WEDNESDAY, message);
        assert!(has(&read, wanted), "{message}: {read:?}");
    }
    // a lone Sunday today reads as today: the span's end counts from its start, tomorrow
    let read = entries_on("2026-10-04T10:00", "from tomorrow to sunday");
    assert!(has(&read, "sunday = 2026-10-11"), "{read:?}");
}

#[test]
fn a_weekday_that_ends_a_span_that_starts_with_a_week_keeps_this_weeks_reading() {
    let read = entries_on(WEDNESDAY, "from last week up to tuesday");
    assert!(
        has(&read, "tuesday = 2026-08-04 (past) / 2026-08-11 (upcoming)"),
        "{read:?}"
    );
}

#[test]
fn other_weekday_phrases_are_read_as_before() {
    for (message, wanted) in [
        ("what's on sunday", "sunday = 2026-08-09"),
        ("from monday to friday", "friday = 2026-08-07"),
        ("what's on friday and sunday", "sunday = 2026-08-09"),
    ] {
        let read = entries_on(WEDNESDAY, message);
        assert!(has(&read, wanted), "{message}: {read:?}");
    }
}

#[test]
fn a_bare_ordinal_that_ends_a_span_takes_the_month_the_span_starts_in() {
    for (message, wanted) in [
        (
            "starred pics from august up to the sixth",
            "the sixth = 2026-08-06",
        ),
        (
            "notes from the start of july up to the twenty-fifth",
            "the twenty-fifth = 2026-07-25 (past) / 2027-07-25 (upcoming)",
        ),
        (
            "events from march the 3rd to the 9th",
            "the 9th = 2026-03-09 (past) / 2027-03-09 (upcoming)",
        ),
    ] {
        let read = entries_on(WEDNESDAY, message);
        assert!(has(&read, wanted), "{message}: {read:?}");
    }
}

#[test]
fn a_bare_ordinal_with_no_month_in_its_clause_is_the_nearest_one() {
    for message in [
        "show me the sixth",
        "from tomorrow up to the sixth",
        "from august up to september the sixth is not it",
    ] {
        let read = entries_on(WEDNESDAY, message);
        if message.starts_with("from august") {
            // a month of its own in the clause: read as a month and day
            assert!(
                !read.iter().any(|entry| entry.starts_with("the sixth")),
                "{read:?}"
            );
        } else {
            assert!(
                has(
                    &read,
                    "the sixth = 2026-07-06 (past) / 2026-08-06 (upcoming)"
                ),
                "{message}: {read:?}"
            );
        }
    }
}
