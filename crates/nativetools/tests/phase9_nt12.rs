//! nt12 (#1044, iteration 2): resolve, don't reject. The runtime fixes what it can fix without a
//! guess and runs the call fixed, with one `note:` line; a guess still asks or errors. B1 to B6
//! are bugs of the readings, R1 to R5 are resolutions, R6 is the write rule of the name tiers.

mod common;

use centraid_nativetools::phrases::at_hour;
use common::{World, call, find_in_turn, ids, seeded, seeded_with};
use jiff::civil::Time;
use serde_json::{Value, json};

fn text(response: &Value) -> &str {
    response["text"].as_str().unwrap_or_default()
}

fn world_with(edit: impl FnOnce(&mut Value)) -> World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).expect("the fixture");
    edit(&mut world);
    seeded_with(&world)
}

fn push(world: &mut Value, section: &str, row: Value) {
    world[section].as_array_mut().expect("a section").push(row);
}

fn options(response: &Value) -> Vec<String> {
    ids(&response["effect"]["ask"]["options"])
}

fn diff_ids(response: &Value) -> Vec<String> {
    common::diff_rows(response)
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// B1: a name is no month

#[test]
fn nt12_b1_a_first_name_that_is_a_month_asks_which_one() {
    let world = world_with(|world| {
        push(world, "people", json!({"key": "j1", "name": "June Park"}));
        push(world, "people", json!({"key": "j2", "name": "June Lee"}));
    });
    let mut session = world.session();
    session.user("star june");
    let handle = find_in_turn(&mut session, "person", "june park");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "star", "rows": [handle]}),
    );
    assert_eq!(options(&reply).len(), 2, "{reply}");
}

#[test]
fn nt12_b1_a_year_inside_a_name_is_no_period() {
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "y1", "name": "Year-end report 2025"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "y2", "name": "Year-end report 2026"}),
        );
    });
    let mut session = world.session();
    session.user("complete the year-end report");
    let handle = find_in_turn(&mut session, "task", "year end report 2025");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": [handle]}),
    );
    assert_eq!(options(&reply).len(), 2, "{reply}");
}

#[test]
fn nt12_b1_a_month_the_message_means_still_settles_the_pick() {
    // "in june" is the month: the message states a date, so the pick is the model's
    let world = world_with(|world| {
        push(world, "people", json!({"key": "j1", "name": "June Park"}));
        push(world, "people", json!({"key": "j2", "name": "June Lee"}));
    });
    let mut session = world.session();
    session.user("star june park in june");
    let handle = find_in_turn(&mut session, "person", "june park");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "star", "rows": [handle]}),
    );
    assert_eq!(diff_ids(&reply), vec![world.id("j1")], "{reply}");
}

// ---------------------------------------------------------------------------------------------
// B2: one bool parser

#[test]
fn nt12_b2_on_and_off_are_booleans_and_anything_else_names_the_values() {
    let world = seeded();
    let mut session = world.session();
    session.user("pin the dal note");
    let on = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "note", "name": "Dal", "args": "pinned: on"}),
    );
    assert_eq!(diff_ids(&on), vec![world.id("dal")], "{on}");
    assert!(text(&on).contains("pinned"), "{on}");
    let mut session = world.session();
    session.user("pin the dal note");
    let maybe = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "note", "name": "Dal", "args": "pinned: maybe"}),
    );
    assert!(text(&maybe).starts_with("error:"), "{maybe}");
    assert!(text(&maybe).contains("yes, true, 1, on"), "{maybe}");
    assert!(text(&maybe).contains("no, false, 0, off"), "{maybe}");
}

#[test]
fn nt12_b2_where_and_trashed_read_the_same_values() {
    let world = seeded();
    let mut session = world.session();
    session.user("pinned notes");
    let pinned = call(
        &mut session,
        "find",
        json!({"kind": "note", "where": "pinned = on"}),
    );
    assert_eq!(
        ids(&pinned["effect"]["rows"]),
        vec![world.id("journal")],
        "{pinned}"
    );
    let bad = call(
        &mut session,
        "find",
        json!({"kind": "note", "where": "pinned = maybe"}),
    );
    assert!(text(&bad).contains("yes, true, 1, on"), "{bad}");
    session.user("what is in the trash");
    let trashed = call(
        &mut session,
        "find",
        json!({"kind": "task", "trashed": "on"}),
    );
    assert_eq!(
        ids(&trashed["effect"]["rows"]),
        vec![world.id("library")],
        "{trashed}"
    );
}

// ---------------------------------------------------------------------------------------------
// B3: complete on a cancelled task: one applicability

fn cancelled_world() -> World {
    world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "cake1", "name": "Order cake"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "cake2", "name": "Order cake again", "status": "cancelled"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "solo", "name": "Call the plumber", "status": "cancelled"}),
        );
    })
}

#[test]
fn nt12_b3_a_named_open_row_is_taken_over_a_cancelled_one() {
    let world = cancelled_world();
    let mut session = world.session();
    session.user("tick off order cake");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "order cake"}),
    );
    assert_eq!(diff_ids(&done), vec![world.id("cake1")], "{done}");
}

#[test]
fn nt12_b3_a_lone_cancelled_row_is_completed() {
    let world = cancelled_world();
    let mut session = world.session();
    session.user("tick off call the plumber");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "call the plumber"}),
    );
    assert_eq!(diff_ids(&done), vec![world.id("solo")], "{done}");
}

#[test]
fn nt12_b3_reopen_applies_to_a_cancelled_task_and_not_to_an_open_one() {
    let world = cancelled_world();
    let mut session = world.session();
    session.user("reopen order cake");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "reopen", "kind": "task", "name": "order cake"}),
    );
    assert_eq!(diff_ids(&done), vec![world.id("cake2")], "{done}");
}

// ---------------------------------------------------------------------------------------------
// B4: one at_hour

fn time(hour: i8, minute: i8) -> Time {
    Time::new(hour, minute, 0, 0).expect("a time")
}

#[test]
fn nt12_b4_at_hour_is_one_function() {
    // a word of the message decides first
    assert_eq!(at_hour(8, Some(true), None), (20, None));
    assert_eq!(at_hour(8, Some(false), None), (8, None));
    // then the row's own clock
    assert_eq!(at_hour(8, None, Some(time(19, 0))), (20, None));
    assert_eq!(at_hour(8, None, Some(time(9, 0))), (8, None));
    // with neither, the reading the line and the repair always gave: the evening first
    assert_eq!(at_hour(8, None, None), (20, Some(8)));
    assert_eq!(at_hour(3, None, None), (15, Some(3)));
    assert_eq!(at_hour(7, None, None), (19, Some(7)));
    assert_eq!(at_hour(9, None, None), (9, Some(21)));
    assert_eq!(at_hour(11, None, None), (11, Some(23)));
    assert_eq!(at_hour(12, None, None), (12, None));
    // a 24-hour clock is no bare hour
    assert_eq!(at_hour(15, None, None), (15, None));
}

#[test]
fn nt12_b4_the_dates_line_lists_eight_the_way_it_decides_it() {
    let line = centraid_nativetools::phrases::dates_line(
        "move it to 8",
        centraid_nativetools::dates::parse_now(common::TODAY).expect("a date"),
    )
    .expect("a line");
    assert!(line.contains("20:00 (pm) / 08:00 (am)"), "{line}");
}

#[test]
fn nt12_b4_an_evening_row_moved_to_eight_is_eight_in_the_evening() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "supper", "name": "Book club", "start": "2026-10-04T19:00"}),
        );
    });
    let mut session = world.session();
    session.user("move book club to 8");
    let moved = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "book club",
               "args": r#"to: {"unit":"day","rel":7,"time":"08:00"}"#}),
    );
    assert!(text(&moved).contains("20:00"), "{moved}");
}

#[test]
fn nt12_b4_a_morning_row_moved_to_eight_stays_in_the_morning() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "run", "name": "Park run", "start": "2026-10-04T09:00"}),
        );
    });
    let mut session = world.session();
    session.user("move park run to 8");
    let moved = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "park run",
               "args": r#"to: {"unit":"day","rel":7,"time":"08:00"}"#}),
    );
    assert!(text(&moved).contains("08:00"), "{moved}");
    assert!(!text(&moved).contains("20:00"), "{moved}");
}

// ---------------------------------------------------------------------------------------------
// B5: a currency symbol names a currency

#[test]
fn nt12_b5_a_euro_amount_is_not_read_as_dollars() {
    let world = seeded();
    let mut session = world.session();
    session.user("debts over 20");
    let dollars = call(
        &mut session,
        "find",
        json!({"kind": "debt", "where": "amount >= $20"}),
    );
    assert_eq!(
        ids(&dollars["effect"]["rows"]),
        vec![world.id("tickets")],
        "{dollars}"
    );
    let euros = call(
        &mut session,
        "find",
        json!({"kind": "debt", "where": "amount >= €20"}),
    );
    assert!(ids(&euros["effect"]["rows"]).is_empty(), "{euros}");
}

#[test]
fn nt12_b5_a_symbol_two_codes_share_is_an_error() {
    let world = world_with(|world| {
        push(
            world,
            "groups",
            json!({"key": "maple", "name": "Maple", "currency": "CAD", "members": []}),
        );
    });
    let mut session = world.session();
    session.user("debts over 20");
    let both = call(
        &mut session,
        "find",
        json!({"kind": "debt", "where": "amount >= $20"}),
    );
    assert!(text(&both).starts_with("error:"), "{both}");
    assert!(
        text(&both).contains("USD") && text(&both).contains("CAD"),
        "{both}"
    );
}

// ---------------------------------------------------------------------------------------------
// B6: a past weekday is labelled past

#[test]
fn nt12_b6_a_past_weekday_in_a_note_is_labelled_past() {
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist to friday");
    let handle = find_in_turn(&mut session, "event", "dentist");
    let moved = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": [handle],
               "args": r#"to: {"date":"2026-09-25","time":"09:00"}"#}),
    );
    assert!(text(&moved).contains("this Friday (past)"), "{moved}");
}

// ---------------------------------------------------------------------------------------------
// R1: run the decidable "Send <call>"

#[test]
fn nt12_r1_a_field_the_kind_names_otherwise_is_read_as_that_field_and_run() {
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "tent", "name": "Pack the car", "description": "bring the tent"}),
        );
    });
    let mut session = world.session();
    session.user("which tasks mention the tent");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "notes contains \"tent\""}),
    );
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("tent")],
        "{found}"
    );
    assert!(
        text(&found).contains("note: read notes as description"),
        "{found}"
    );
    assert!(!text(&found).contains("error:"), "{found}");
}

#[test]
fn nt12_r1_a_follow_up_selector_without_a_kind_runs_within_the_one_list() {
    let world = seeded();
    let mut session = world.session();
    session.user("my tasks");
    let list = call(&mut session, "find", json!({"kind": "task"}));
    assert!(!ids(&list["effect"]["rows"]).is_empty(), "{list}");
    session.user("only the ones with a priority");
    let narrowed = call(&mut session, "find", json!({"where": "priority = 2"}));
    assert!(!text(&narrowed).contains("error:"), "{narrowed}");
    assert!(text(&narrowed).contains("note: used find"), "{narrowed}");
    assert_eq!(
        ids(&narrowed["effect"]["rows"]),
        vec![world.id("pay")],
        "{narrowed}"
    );
}

#[test]
fn nt12_r1_a_balance_for_the_person_the_message_names_runs() {
    let world = seeded();
    let mut session = world.session();
    session.user("what does ray owe in tahoe trip");
    let balance = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "Tahoe Trip"}),
    );
    assert!(!text(&balance).contains("error:"), "{balance}");
    assert!(text(&balance).contains("note: used compute"), "{balance}");
    assert!(text(&balance).contains("Ray Ochoa"), "{balance}");
}

#[test]
fn nt12_r1_a_secret_the_item_lacks_is_still_an_error_with_the_call() {
    // a reveal is egress: the runtime does not run the fix for the model
    let world = seeded();
    let mut session = world.session();
    session.user("show the cvv of the home wifi");
    let handle = find_in_turn(&mut session, "locker_item", "home wifi");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": [handle], "args": "field: cvv"}),
    );
    assert!(text(&reply).starts_with("error:"), "{reply}");
    assert!(text(&reply).contains("Send"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// R2: one field resolver

#[test]
fn nt12_r2_order_and_compute_field_read_a_synonym() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks by due date");
    let ordered = call(
        &mut session,
        "find",
        json!({"kind": "task", "order": "due desc"}),
    );
    assert!(!text(&ordered).contains("error:"), "{ordered}");
    assert!(
        text(&ordered).contains("note: read due as date"),
        "{ordered}"
    );
    session.user("how many minutes of tasks");
    let sum = call(
        &mut session,
        "compute",
        json!({"op": "sum", "kind": "task", "field": "minutes"}),
    );
    assert!(!text(&sum).contains("error:"), "{sum}");
    assert!(text(&sum).contains("note: read minutes as effort"), "{sum}");
}

#[test]
fn nt12_r2_an_edit_and_a_create_arg_read_a_synonym() {
    let world = seeded();
    let mut session = world.session();
    session.user("add a note to the cabin task");
    let edited = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Book the cabin", "args": "notes: ask for the lake side"}),
    );
    assert_eq!(diff_ids(&edited), vec![world.id("cabin")], "{edited}");
    assert!(
        text(&edited).contains("note: read notes as description"),
        "{edited}"
    );
}

#[test]
fn nt12_r2_a_word_that_is_no_field_stays_the_error() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks by mood");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "task", "order": "mood asc"}),
    );
    assert!(text(&reply).starts_with("error:"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// R3: lexical leniency

fn reschedule(session: &mut centraid_nativetools::Session, to: &str) -> Value {
    call(
        session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "dentist",
               "args": format!("to: {to}")}),
    )
}

#[test]
fn nt12_r3_a_time_written_9pm_or_9_30_is_read() {
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist to saturday evening");
    let evening = reschedule(&mut session, r#"{"date":"2026-10-03","time":"9pm"}"#);
    assert!(!text(&evening).contains("error:"), "{evening}");
    assert!(text(&evening).contains("21:00"), "{evening}");
    assert!(
        text(&evening).contains("note: read time 9pm as 21:00"),
        "{evening}"
    );
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist to saturday morning");
    let half = reschedule(&mut session, r#"{"date":"2026-10-03","time":"9:30"}"#);
    assert!(text(&half).contains("09:30"), "{half}");
    assert!(
        text(&half).contains("note: read time 9:30 as 09:30"),
        "{half}"
    );
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist to saturday night");
    let seconds = reschedule(&mut session, r#"{"date":"2026-10-03","time":"21:00:00"}"#);
    assert!(text(&seconds).contains("21:00"), "{seconds}");
    assert!(!text(&seconds).contains("error:"), "{seconds}");
}

#[test]
fn nt12_r3_a_date_written_as_its_text_is_the_absolute_expression() {
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist to the 4th");
    let moved = reschedule(&mut session, "2026-10-04T10:30");
    assert!(!text(&moved).contains("error:"), "{moved}");
    assert!(text(&moved).contains("2026-10-04 10:30"), "{moved}");
    assert!(
        text(&moved).contains("note: read 2026-10-04T10:30 as"),
        "{moved}"
    );
}

#[test]
fn nt12_r3_a_bare_hour_stays_malformed() {
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist to saturday at 9");
    let bare = reschedule(&mut session, r#"{"date":"2026-10-03","time":"9"}"#);
    assert!(text(&bare).starts_with("error:"), "{bare}");
}

#[test]
fn nt12_r3_rel_weekday_and_month_given_as_words_are_numbers() {
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist to tomorrow");
    let rel = reschedule(&mut session, r#"{"unit":"day","rel":"1"}"#);
    assert!(!text(&rel).contains("error:"), "{rel}");
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist to friday");
    let weekday = reschedule(
        &mut session,
        r#"{"unit":"week","rel":1,"weekday":"friday"}"#,
    );
    assert!(!text(&weekday).contains("error:"), "{weekday}");
    assert!(
        text(&weekday).contains("2026-10-02") || text(&weekday).contains("Fri"),
        "{weekday}"
    );
    let world = seeded();
    let mut session = world.session();
    session.user("what was on last november");
    let month = call(
        &mut session,
        "find",
        json!({"kind": "event", "when": {"unit":"month","name":"november","rel":-1}}),
    );
    assert!(!text(&month).contains("error:"), "{month}");
}

#[test]
fn nt12_r3_a_unit_with_a_fixed_conversion_is_converted() {
    let world = seeded();
    let mut session = world.session();
    session.user("make the cabin task two hours");
    let edited = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Book the cabin", "args": "effort: 2 hours"}),
    );
    assert_eq!(diff_ids(&edited), vec![world.id("cabin")], "{edited}");
    assert!(text(&edited).contains("120"), "{edited}");
    assert!(
        text(&edited).contains("note: read 2 hours as 120"),
        "{edited}"
    );
    session.user("tasks over an hour");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "effort > 1 hour"}),
    );
    assert!(!text(&found).contains("error:"), "{found}");
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("cabin")],
        "{found}"
    );
    session.user("people to contact every two weeks");
    let weeks = call(
        &mut session,
        "find",
        json!({"kind": "person", "where": "cadence = 2 weeks"}),
    );
    assert!(!text(&weeks).contains("error:"), "{weeks}");
    assert_eq!(
        ids(&weeks["effect"]["rows"]),
        vec![world.id("neha_k")],
        "{weeks}"
    );
}

#[test]
fn nt12_r3_one_field_joined_by_or_is_in() {
    let world = seeded();
    let mut session = world.session();
    session.user("open or completed tasks");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status = open or status = completed"}),
    );
    assert!(!text(&found).contains("error:"), "{found}");
    assert!(text(&found).contains("note: read"), "{found}");
    assert!(ids(&found["effect"]["rows"]).len() >= 4, "{found}");
    // two fields joined by or is not one field: still the error
    let mixed = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status = open or priority = 2"}),
    );
    assert!(text(&mixed).starts_with("error:"), "{mixed}");
}

#[test]
fn nt12_r3_a_date_rejection_quotes_only_the_example_for_the_key_that_failed() {
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist");
    let bad = reschedule(&mut session, r#"{"date":"2026-10-03","time":"nine"}"#);
    assert!(text(&bad).starts_with("error:"), "{bad}");
    assert!(text(&bad).contains("a date with a time"), "{bad}");
    assert!(!text(&bad).contains("last november"), "{bad}");
    assert!(!text(&bad).contains("a span"), "{bad}");
}

// ---------------------------------------------------------------------------------------------
// R4: verb redirects

#[test]
fn nt12_r4_edit_date_is_the_reschedule_it_names() {
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist to saturday 9am");
    let moved = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "event", "name": "dentist",
               "args": r#"date: {"date":"2026-10-03","time":"09:00"}"#}),
    );
    assert!(!text(&moved).starts_with("error:"), "{moved}");
    assert_eq!(diff_ids(&moved), vec![world.id("dentist")], "{moved}");
    assert!(text(&moved).contains("note: used reschedule"), "{moved}");
}

#[test]
fn nt12_r4_an_edit_of_a_date_that_is_no_expression_keeps_the_edits_own_refusal() {
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist to friday");
    let refused = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "event", "name": "dentist", "args": "date: friday"}),
    );
    assert!(
        text(&refused).starts_with("error: a date changes with reschedule"),
        "{refused}"
    );
}

#[test]
fn nt12_r4_edit_starred_status_and_completed_are_the_verbs() {
    let world = seeded();
    let mut session = world.session();
    session.user("star ray");
    let starred = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "person", "name": "ray ochoa", "args": "starred: yes"}),
    );
    assert_eq!(diff_ids(&starred), vec![world.id("ray")], "{starred}");
    assert!(text(&starred).contains("note: used star"), "{starred}");
    session.user("call off the dentist");
    let cancelled = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "event", "name": "dentist", "args": "status: cancelled"}),
    );
    assert_eq!(
        diff_ids(&cancelled),
        vec![world.id("dentist")],
        "{cancelled}"
    );
    assert!(
        text(&cancelled).contains("note: used cancel"),
        "{cancelled}"
    );
    session.user("tick off the cabin");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Book the cabin", "args": "completed: yes"}),
    );
    assert_eq!(diff_ids(&done), vec![world.id("cabin")], "{done}");
    assert!(text(&done).contains("note: used complete"), "{done}");
}

#[test]
fn nt12_r4_args_on_a_verb_that_takes_none_are_dropped_with_a_note() {
    let world = seeded();
    let mut session = world.session();
    session.user("tick off the cabin");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Book the cabin", "args": "status: completed"}),
    );
    assert_eq!(diff_ids(&done), vec![world.id("cabin")], "{done}");
    assert!(text(&done).contains("note: ignored"), "{done}");
}

#[test]
fn nt12_r4_settle_up_without_a_group_takes_the_one_group_that_holds_a_balance() {
    let world = seeded();
    let mut session = world.session();
    session.user("neha rao paid me back");
    let handle = find_in_turn(&mut session, "person", "neha rao");
    let settled = call(
        &mut session,
        "act",
        json!({"verb": "settle_up", "rows": [handle]}),
    );
    assert!(!text(&settled).starts_with("error:"), "{settled}");
    assert!(text(&settled).contains("Tahoe Trip"), "{settled}");
    assert!(text(&settled).contains("note: used group"), "{settled}");
}

#[test]
fn nt12_r4_settle_up_without_a_group_stays_an_error_when_several_hold_a_balance() {
    let world = world_with(|world| {
        push(
            world,
            "expenses",
            json!({"group": "flat", "name": "Rent", "amount": 100, "paid_by": "me",
                   "split": ["me", "neha_r"], "date": "2026-08-03"}),
        );
        world["groups"][1]["members"] = json!(["benedikt", "neha_r"]);
    });
    let mut session = world.session();
    session.user("neha rao paid me back");
    let handle = find_in_turn(&mut session, "person", "neha rao");
    let settled = call(
        &mut session,
        "act",
        json!({"verb": "settle_up", "rows": [handle]}),
    );
    assert!(text(&settled).starts_with("error:"), "{settled}");
}

#[test]
fn nt12_r4_remove_from_without_from_takes_the_one_container_the_row_is_in() {
    let world = seeded();
    let mut session = world.session();
    session.user("take the beach photo out of its album");
    let handle = find_in_turn(&mut session, "photo", "beach day");
    let removed = call(
        &mut session,
        "act",
        json!({"verb": "remove_from", "rows": [handle]}),
    );
    assert!(!text(&removed).starts_with("error:"), "{removed}");
    assert!(text(&removed).contains("note: used from"), "{removed}");
    assert!(text(&removed).contains("Summer"), "{removed}");
}

// ---------------------------------------------------------------------------------------------
// R5: two calls in one message

fn block(verb: &str, name: &str) -> String {
    format!(
        "<tool_call>\n<function=act>\n<parameter=verb>\n{verb}\n</parameter>\n<parameter=kind>\ntask\n</parameter>\n<parameter=name>\n{name}\n</parameter>\n</function>\n</tool_call>"
    )
}

#[test]
fn nt12_r5_the_first_of_two_calls_runs_and_the_reply_says_so() {
    let world = seeded();
    let mut session = world.session();
    session.user("finish the cabin task");
    let message = format!(
        "{}\n{}",
        block("complete", "cabin"),
        block("delete", "cabin")
    );
    let reply = session.call_text(&message);
    assert_eq!(diff_ids(&reply), vec![world.id("cabin")], "{reply}");
    assert!(
        text(&reply)
            .trim_end()
            .ends_with("note: only the first call ran"),
        "{reply}"
    );
    // the delete did not run
    session.user("is it done");
    let cabin = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    );
    assert!(text(&cabin).contains("status completed"), "{cabin}");
}

#[test]
fn nt12_r5_one_call_has_no_such_note() {
    let world = seeded();
    let mut session = world.session();
    session.user("finish the cabin task");
    let reply = session.call_text(&block("complete", "cabin"));
    assert!(!text(&reply).contains("only the first call ran"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// R6: a write by name acts on exactly one row of tiers 1 to 3

#[test]
fn nt12_r6_an_exact_name_other_rows_also_reach_is_the_ask_over_all_of_them() {
    let world = world_with(|world| {
        push(world, "tasks", json!({"key": "flan", "name": "Flan"}));
        push(world, "tasks", json!({"key": "flan2", "name": "Flan 2"}));
    });
    let mut session = world.session();
    session.user("finish the flan");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "flan"}),
    );
    assert_eq!(reply["effect"]["ask"]["question"], "Which one?", "{reply}");
    let mut got = options(&reply);
    got.sort();
    let mut want = vec![world.id("flan"), world.id("flan2")];
    want.sort();
    assert_eq!(got, want, "{reply}");
}

#[test]
fn nt12_r6_a_read_of_the_same_name_is_unchanged() {
    let world = world_with(|world| {
        push(world, "tasks", json!({"key": "flan", "name": "Flan"}));
        push(world, "tasks", json!({"key": "flan2", "name": "Flan 2"}));
    });
    let mut session = world.session();
    session.user("the flan tasks");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "flan"}),
    );
    assert_eq!(ids(&reply["effect"]["rows"]).len(), 2, "{reply}");
}

#[test]
fn nt12_r6_a_typo_with_one_candidate_acts_and_says_what_it_matched() {
    let world = world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "far", "name": "Farrukh Kasimov"}),
        );
    });
    let mut session = world.session();
    session.user("star farukh kasimov");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "farukh kasimov"}),
    );
    assert_eq!(diff_ids(&reply), vec![world.id("far")], "{reply}");
    assert!(
        text(&reply).contains("matched \"Farrukh Kasimov\" for \"farukh kasimov\""),
        "{reply}"
    );
}

#[test]
fn nt12_r6_a_typo_with_several_candidates_is_the_ask() {
    let world = world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "far", "name": "Farrukh Kasimov"}),
        );
        push(
            world,
            "people",
            json!({"key": "far2", "name": "Farrukh Kasimova"}),
        );
    });
    let mut session = world.session();
    session.user("star farukh kasimov");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "farukh kasimov"}),
    );
    assert_eq!(reply["effect"]["ask"]["question"], "Which one?", "{reply}");
}

// ---------------------------------------------------------------------------------------------
// the repairs are best-effort and off with `--no-normalize` (the replay of an author's bad steps)

#[test]
fn nt12_without_normalize_a_fixable_call_is_the_error_it_was() {
    let world = seeded();
    let flags = centraid_nativetools::Flags {
        normalize: false,
        ..centraid_nativetools::Flags::default()
    };
    let mut session = world.session_with(common::TODAY, flags);
    session.user("tasks that mention the cabin");
    let swapped = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "notes contains \"cabin\""}),
    );
    assert!(
        text(&swapped).starts_with("error: tasks have no field \"notes\""),
        "{swapped}"
    );
    assert!(text(&swapped).contains("Send find"), "{swapped}");
    session.user("move the dentist");
    let edit = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "event", "name": "dentist",
               "args": r#"date: {"date":"2026-10-03"}"#}),
    );
    assert!(
        text(&edit).starts_with("error: a date changes with reschedule"),
        "{edit}"
    );
    let lenient = reschedule(&mut session, r#"{"date":"2026-10-03","time":"9pm"}"#);
    assert!(text(&lenient).starts_with("error:"), "{lenient}");
}
