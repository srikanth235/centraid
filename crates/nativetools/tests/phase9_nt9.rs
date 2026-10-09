//! Part A of nt9 (#1044, iteration 1): six runtime rules read off the model's failures on its own
//! train data (`tfread`): ordinals over a shown list (`picks:`), a time-only reschedule keeps the
//! row's day, a bare hour settles from the row's own time, search matches word forms, "latest" is
//! the last one, and a restore over several rows does not depend on their order.

mod common;

use common::{World, call, ids, seeded, seeded_with};
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
// Rule 6: a restore over several rows is the same whatever order the rows come in

/// Three trashed photos; "Old garage door" went to the trash past the vault's window.
fn trashed_photos() -> World {
    world_with(|world| {
        for (key, name, when) in [
            ("garage", "Old garage door", "2026-02-01T12:00"),
            ("selfie", "Selfie with Abu Fadi", "2026-04-30T10:30"),
            ("menu", "Cafe menu", "2026-06-05T12:00"),
        ] {
            let trashed = if key == "garage" {
                "2026-08-01T09:00"
            } else {
                "2026-09-25T09:00"
            };
            push(
                world,
                "photos",
                json!({"key": key, "name": name, "taken": when, "trashed": trashed}),
            );
        }
    })
}

fn restore_in_order(order: [&str; 3]) -> (Value, Vec<String>) {
    let world = trashed_photos();
    let mut session = world.session();
    session.user("restore all of them");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "photo", "trashed": true}),
    );
    let listing = text(&found).to_owned();
    let number_of = |name: &str| -> String {
        let line = listing
            .lines()
            .find(|line| line.contains(&format!("\"{name}")))
            .unwrap_or_else(|| panic!("{name} in {listing}"));
        line.split_whitespace().next().expect("a #n").to_owned()
    };
    let handles: Vec<String> = order.iter().map(|name| number_of(name)).collect();
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "restore", "rows": handles.join(", ")}),
    );
    let mut restored: Vec<String> = reply["effect"]["diff"]["rows"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
        .collect();
    restored.sort();
    (reply, restored)
}

#[test]
fn a_restore_over_several_rows_restores_the_two_that_can_come_back_whatever_the_order() {
    let mut seen = Vec::new();
    for order in [
        ["Old garage", "Selfie", "Cafe"],
        ["Selfie", "Cafe", "Old garage"],
        ["Selfie", "Old garage", "Cafe"],
    ] {
        let (reply, restored) = restore_in_order(order);
        assert_eq!(restored.len(), 2, "{order:?}: {reply}");
        assert_ne!(tool_of(&reply), "decline", "{order:?}: {reply}");
        let said = text(&reply);
        assert!(said.contains("restored:"), "{order:?}: {said}");
        assert!(
            said.contains("Old garage door")
                && said.contains("past the vault's restore window, so it cannot come back"),
            "{order:?}: the refused row is reported: {said}"
        );
        seen.push(restored);
    }
    assert!(
        seen.windows(2).all(|pair| pair[0] == pair[1]),
        "the same two rows come back in every order: {seen:?}"
    );
}

#[test]
fn a_restore_of_rows_that_are_all_past_the_window_is_still_the_decline() {
    let world = world_with(|world| {
        for (key, name) in [("one", "Old one"), ("two", "Old two")] {
            push(
                world,
                "photos",
                json!({"key": key, "name": name, "taken": "2026-02-01T12:00", "trashed": "2026-08-01T09:00"}),
            );
        }
    });
    let mut session = world.session();
    session.user("restore both");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "photo", "trashed": true}),
    );
    let rows: Vec<String> = found["effect"]["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| format!("#{}", row["n"]))
        .collect();
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "restore", "rows": rows.join(", ")}),
    );
    assert_eq!(tool_of(&reply), "decline", "{reply}");
    assert_eq!(reply["effect"]["decline"]["reason"], "not_found", "{reply}");
}

// ---------------------------------------------------------------------------------------------
// Rule 4: search matches word forms

fn sitter_world() -> World {
    world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "date_night", "name": "Date night, Rina babysits", "start": "2026-12-19T19:00"}),
        );
        push(
            world,
            "notes",
            json!({"key": "sitter_note", "name": "Babysitter numbers", "body": "rates", "created": "2026-09-10T08:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "paint", "name": "Painting class", "start": "2026-11-02T18:00"}),
        );
    })
}

fn searched(text: &str) -> Value {
    let world = sitter_world();
    let mut session = world.session();
    session.user("when's the babysitter coming");
    call(&mut session, "search", json!({"text": text}))
}

#[test]
fn a_search_for_a_word_reaches_the_row_that_says_another_form_of_it() {
    let reply = searched("babysitter");
    let said = text(&reply);
    assert!(said.contains("Date night, Rina babysits"), "{said}");
    // the exact match ranks first, the other form after it
    let exact = said.find("Babysitter numbers").expect("the exact row");
    let form = said
        .find("Date night, Rina babysits")
        .expect("the form row");
    assert!(exact < form, "{said}");
}

#[test]
fn a_search_for_the_other_forms_reaches_it_too() {
    for query in ["babysits", "babysitting", "babysat"] {
        let said = text(&searched(query)).to_owned();
        assert!(
            said.contains("Date night, Rina babysits"),
            "{query}: {said}"
        );
    }
}

#[test]
fn a_search_word_form_is_not_a_loose_match() {
    // "painter" and "painting" are forms of "paint"
    let said = text(&searched("painter")).to_owned();
    assert!(said.contains("Painting class"), "{said}");
    // a word that merely starts or ends alike is not a form
    let other = text(&searched("sitting")).to_owned();
    assert!(!other.contains("babysits"), "{other}");
}

#[test]
fn a_find_by_name_is_not_widened_to_word_forms() {
    let world = sitter_world();
    let mut session = world.session();
    session.user("when's the babysitter coming");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "babysitter"}),
    );
    assert!(!text(&reply).contains("Date night"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// Rule 5: "latest" and "newest" are the last one by the kind's date

fn diary() -> World {
    world_with(|world| {
        push(
            world,
            "notes",
            json!({"key": "ride", "name": "Diary entry - good ride", "body": "Karura", "created": "2026-09-19T10:30"}),
        );
        push(
            world,
            "notes",
            json!({"key": "site", "name": "Diary entry - rough site day", "body": "rain", "created": "2026-09-08T21:30"}),
        );
    })
}

fn read_as(message: &str, tool: &str, args: Value) -> (World, Value) {
    let world = diary();
    let mut session = world.session();
    session.user(message);
    let reply = call(&mut session, tool, args);
    (world, reply)
}

#[test]
fn latest_reads_as_the_last_one_by_the_kinds_date() {
    for tool in ["find", "answer"] {
        let (world, reply) = read_as(
            "my latest diary entry",
            tool,
            json!({"kind": "note", "name": "diary entry"}),
        );
        let rows = if tool == "find" {
            &reply["effect"]["rows"]
        } else {
            &reply["effect"]["answer"]["rows"]
        };
        assert_eq!(ids(rows), vec![world.id("journal")], "{tool}: {reply}");
        assert!(
            text(&reply).contains(
                "last: the message asks for the latest one; used order date desc, limit 1."
            ),
            "{tool}: {reply}"
        );
        // no span of its own: a future-dated row is still the latest
        assert!(!text(&reply).contains("up to today"), "{tool}: {reply}");
    }
}

#[test]
fn a_latest_call_that_is_already_ordered_and_limited_is_left_as_it_is() {
    let (world, reply) = read_as(
        "my latest diary entry",
        "find",
        json!({"kind": "note", "name": "diary entry", "order": "date desc", "limit": 1}),
    );
    assert_eq!(
        ids(&reply["effect"]["rows"]),
        vec![world.id("journal")],
        "{reply}"
    );
    assert!(!text(&reply).contains("last:"), "{reply}");
}

#[test]
fn newest_reads_the_same_way() {
    let (world, reply) = read_as(
        "show the newest diary entry",
        "find",
        json!({"kind": "note", "name": "diary entry"}),
    );
    assert_eq!(ids(&reply["effect"]["rows"]), vec![world.id("journal")]);
}

#[test]
fn latest_that_is_no_superlative_changes_nothing() {
    // an order, a count or a figure of speech: the call stands
    for message in [
        "diary entries, latest first",
        "my 3 latest diary entries",
        "what's the latest on the diary entries",
        "the latest ones in my diary entries",
    ] {
        let (_, reply) = read_as(message, "find", json!({"kind": "note", "name": "diary"}));
        assert!(
            !text(&reply).contains("last: the message asks"),
            "{message}: {reply}"
        );
        assert!(
            ids(&reply["effect"]["rows"]).len() >= 2,
            "{message}: {reply}"
        );
    }
}

#[test]
fn a_call_that_states_its_own_order_or_limit_is_not_changed_by_latest() {
    let (world, reply) = read_as(
        "my latest diary entry",
        "find",
        json!({"kind": "note", "name": "diary entry", "order": "date desc", "limit": 2}),
    );
    assert_eq!(ids(&reply["effect"]["rows"]).len(), 2, "{reply}");
    let _ = world;
}

// ---------------------------------------------------------------------------------------------
// Rules 2 and 3: a time-only reschedule keeps the row's day, and a bare hour settles from the
// row's own clock

fn calls_world() -> World {
    world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "wcall", "name": "Wedding planning call", "start": "2026-10-22T19:00", "end": "2026-10-22T19:30"}),
        );
        push(
            world,
            "events",
            json!({"key": "turkey", "name": "Thanksgiving dinner", "start": "2026-10-12T17:00", "end": "2026-10-12T19:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "standup", "name": "Team standup", "start": "2026-10-14T09:00", "end": "2026-10-14T10:00"}),
        );
    })
}

fn moved_to(message: &str, name: &str, to: &str) -> Value {
    let world = calls_world();
    let mut session = world.session();
    session.user(message);
    call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": name, "args": format!("to: {to}")}),
    )
}

fn start_of(reply: &Value) -> &str {
    reply["effect"]["diff"]["rows"][0]["fields"]["date"][1]
        .as_str()
        .unwrap_or_default()
}

#[test]
fn a_reschedule_that_names_a_time_and_no_day_keeps_the_rows_day() {
    // the model wrote today for "to 5:30"; the row is on the 12th
    let reply = moved_to(
        "move thanksgiving dinner to 5:30",
        "Thanksgiving dinner",
        r#"{"date":"2026-09-27","time":"17:30"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-12T17:30:00", "{reply}");
    assert!(
        text(&reply).contains("date: \"to 5:30\" names no day; kept the row's day (2026-10-12)."),
        "{reply}"
    );
}

#[test]
fn a_time_only_reschedule_by_a_day_relative_to_today_keeps_the_rows_day_too() {
    let reply = moved_to(
        "push thanksgiving dinner to 6pm",
        "Thanksgiving dinner",
        r#"{"unit":"day","rel":0,"time":"18:00"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-12T18:00:00", "{reply}");
}

#[test]
fn a_day_the_message_states_is_the_models_day() {
    for message in [
        "move thanksgiving dinner to tomorrow at 5:30",
        "move thanksgiving dinner to the 28th at 5:30",
        "move thanksgiving dinner to 5:30 next week",
    ] {
        let reply = moved_to(
            message,
            "Thanksgiving dinner",
            r#"{"date":"2026-09-28","time":"17:30"}"#,
        );
        assert_eq!(
            start_of(&reply),
            "2026-09-28T17:30:00",
            "{message}: {reply}"
        );
    }
}

#[test]
fn a_day_the_call_takes_from_the_row_or_a_shift_is_not_pulled_back() {
    // anchored on the row: the model already moves from the row's day
    let reply = moved_to(
        "move thanksgiving dinner to 5:30",
        "Thanksgiving dinner",
        r#"{"unit":"day","rel":0,"anchor":"row","time":"17:30"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-12T17:30:00", "{reply}");
    // a shift of days with a time is a day the person said
    let reply = moved_to(
        "move thanksgiving dinner a day later at 5:30",
        "Thanksgiving dinner",
        r#"{"unit":"day","rel":1,"anchor":"row","time":"17:30"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-13T17:30:00", "{reply}");
}

#[test]
fn a_time_only_reschedule_of_a_task_keeps_its_due_day() {
    let world = seeded_with(&serde_json::from_str(common::FIXTURE).expect("the fixture"));
    let mut session = world.session();
    session.user("move pay rent to 5pm");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "task", "name": "Pay rent",
               "args": r#"to: {"date":"2026-09-27","time":"17:00"}"#}),
    );
    assert!(text(&reply).contains("→ Thu 2026-10-01 17:00"), "{reply}");
}

#[test]
fn a_bare_hour_from_1_to_8_of_an_evening_row_is_the_evening_reading() {
    // the wedding call is at 19:00: "to 8" is 20:00, whichever reading the call wrote
    for time in ["08:00", "20:00"] {
        let reply = moved_to(
            "move the wedding planning call to 8",
            "Wedding planning call",
            &format!(r#"{{"unit":"day","rel":0,"anchor":"row","time":"{time}"}}"#),
        );
        assert_eq!(start_of(&reply), "2026-10-22T20:00:00", "{time}: {reply}");
    }
    let reply = moved_to(
        "move the wedding planning call to 8",
        "Wedding planning call",
        r#"{"unit":"day","rel":0,"anchor":"row","time":"08:00"}"#,
    );
    assert!(
        text(&reply).contains("date: \"to 8\" is 20:00 or 08:00; the row is at 19:00; used 20:00 (the row's own time decides"),
        "{reply}"
    );
}

#[test]
fn a_bare_hour_from_9_to_11_of_an_evening_row_is_the_models_as_at_n_says() {
    // 9 to 11 read as the morning (SPEC at_n); the row's clock does not turn a stated time
    let reply = moved_to(
        "move the wedding planning call to 9",
        "Wedding planning call",
        r#"{"unit":"day","rel":0,"anchor":"row","time":"09:00"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-22T09:00:00", "{reply}");
    let reply = moved_to(
        "move the wedding planning call to 9",
        "Wedding planning call",
        r#"{"unit":"day","rel":0,"anchor":"row","time":"21:00"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-22T21:00:00", "{reply}");
}

#[test]
fn a_bare_hour_of_a_morning_row_is_the_models_and_the_afternoon_default() {
    // the team standup is at 09:00: nothing of its clock settles the hour (SPEC at_n)
    let reply = moved_to(
        "move the team standup to 8",
        "Team standup",
        r#"{"unit":"day","rel":0,"anchor":"row","time":"08:00"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-14T08:00:00", "{reply}");
    let reply = moved_to(
        "move the team standup to tuesday at 3",
        "Team standup",
        r#"{"date":"2026-09-29"}"#,
    );
    assert_eq!(start_of(&reply), "2026-09-29T15:00:00", "{reply}");
}

#[test]
fn a_time_the_message_settles_is_not_a_bare_hour_for_the_row() {
    let reply = moved_to(
        "move the wedding planning call to 8am",
        "Wedding planning call",
        r#"{"unit":"day","rel":0,"anchor":"row","time":"08:00"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-22T08:00:00", "{reply}");
}

#[test]
fn a_bare_hour_said_before_an_ask_settles_the_answers_reschedule() {
    // "to 8", the ask, then "the 22nd": the hour is from the first message
    let world = calls_world();
    let mut session = world.session();
    session.user("move the wedding planning call to 8");
    call(&mut session, "ask", json!({"question": "Which one?"}));
    session.user("the 22nd");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Wedding planning call",
               "args": r#"to: {"unit":"day","rel":0,"anchor":"row","time":"08:00"}"#}),
    );
    assert_eq!(start_of(&reply), "2026-10-22T20:00:00", "{reply}");
}

// ---------------------------------------------------------------------------------------------
// Rule 1: `picks:`, the rows an ordinal of the message names in the list in focus

/// A turn that reads the five people (or the open tasks), then the message of the next turn.
fn picks_after_a_list(kind: &str, message: &str) -> (Value, Vec<String>) {
    let world = seeded();
    let mut session = world.session();
    session.user("who do i know");
    let found = call(&mut session, "find", json!({"kind": kind}));
    let rows: Vec<String> = found["effect"]["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| format!("#{}", row["n"]))
        .collect();
    (session.user(message), rows)
}

fn picks_of(reply: &Value) -> Option<&str> {
    reply["picks"].as_str()
}

#[test]
fn an_ordinal_over_the_list_in_focus_prints_the_rows_it_names() {
    let (reply, rows) = picks_after_a_list("person", "delete the last two");
    assert_eq!(
        picks_of(&reply),
        Some(format!("picks: the last two = {}, {}", rows[3], rows[4]).as_str()),
        "{reply}"
    );
    // the line is part of the block, after the dates line when there is one
    assert!(
        reply["block"]
            .as_str()
            .unwrap()
            .contains("picks: the last two"),
        "{reply}"
    );
    for (message, want) in [
        (
            "star the first two",
            format!("picks: the first two = {}, {}", rows[0], rows[1]),
        ),
        (
            "the third one should go to friday",
            format!("picks: the third one = {}", rows[2]),
        ),
        (
            "and the last one to the 22nd",
            format!("picks: the last one = {}", rows[4]),
        ),
        (
            "open the second person",
            format!("picks: the second person = {}", rows[1]),
        ),
        (
            "star the last 3",
            format!("picks: the last 3 = {}, {}, {}", rows[2], rows[3], rows[4]),
        ),
        (
            "swap the first one and the last one",
            format!(
                "picks: the first one = {} · the last one = {}",
                rows[0], rows[4]
            ),
        ),
    ] {
        let (reply, _) = picks_after_a_list("person", message);
        assert_eq!(picks_of(&reply), Some(want.as_str()), "{message}: {reply}");
    }
}

#[test]
fn no_picks_line_when_the_message_holds_no_ordinal_of_a_list() {
    for message in [
        "delete them",
        "what happened last week",
        "move it to the first of may",
        "the first two weeks of june",
        "last night was fun",
        "i did it the first time",
        "what was the last thing i said",
        "wait a second",
    ] {
        let (reply, _) = picks_after_a_list("person", message);
        assert_eq!(picks_of(&reply), None, "{message}: {reply}");
    }
}

#[test]
fn no_picks_line_without_a_list_in_focus_or_past_its_end() {
    let world = seeded();
    let mut session = world.session();
    let reply = session.user("delete the last two");
    assert_eq!(picks_of(&reply), None, "{reply}");
    // a seventh of five rows names nothing
    let (reply, _) = picks_after_a_list("person", "star the seventh one");
    assert_eq!(picks_of(&reply), None, "{reply}");
    let (reply, _) = picks_after_a_list("person", "star the last 9");
    assert_eq!(picks_of(&reply), None, "{reply}");
}

#[test]
fn the_ordinals_of_an_ask_are_over_its_options() {
    let world = seeded();
    let mut session = world.session();
    session.user("log a call with neha");
    let asked = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "neha", "args": "kind: call"}),
    );
    assert_eq!(tool_of(&asked), "ask", "{asked}");
    let rows: Vec<String> = asked["effect"]["ask"]["options"]
        .as_array()
        .expect("options")
        .iter()
        .map(|row| format!("#{}", row["n"]))
        .collect();
    assert!(rows.len() >= 2, "{asked}");
    let reply = session.user("the second one");
    assert_eq!(
        picks_of(&reply),
        Some(format!("picks: the second one = {}", rows[1]).as_str()),
        "{reply}"
    );
}

#[test]
fn the_other_one_is_the_row_of_two_the_last_write_left() {
    let world = seeded();
    let mut session = world.session();
    session.user("who are the nehas");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "neha"}),
    );
    let rows: Vec<String> = found["effect"]["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| format!("#{}", row["n"]))
        .collect();
    assert_eq!(rows.len(), 2, "{found}");
    // nothing written yet: the other of what?
    let reply = session.user("and the other one");
    assert_eq!(picks_of(&reply), None, "{reply}");
    call(
        &mut session,
        "act",
        json!({"verb": "log", "rows": rows[1], "args": "kind: call"}),
    );
    let reply = session.user("and the other one");
    assert_eq!(
        picks_of(&reply),
        Some(format!("picks: the other one = {}", rows[0]).as_str()),
        "{reply}"
    );
}
