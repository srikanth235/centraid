//! Phase 6, slice P2.3 of #1044: the gaps of the `dates:` line.
//!
//! - a bare hour lists both readings, and an event's write takes the afternoon for 1 to 6 and the
//!   morning for 7 to 11;
//! - "that day", "the day before that", "before berlin" read the conversation (`Session::dates_line`);
//! - "the rest of the week", "the day before <date>", "sunday night" on a read, a weekday after
//!   another phrase, "friday same time".

mod common;

use centraid_nativetools::dates;
use centraid_nativetools::phrases::{dates_line, read_dates};
use common::{World, call, find_in_turn, seeded};
use serde_json::{Value, json};

/// A Friday.
const FRIDAY: &str = "2026-10-02";

fn line_on(today: &str, message: &str) -> String {
    dates_line(message, dates::parse_now(today).expect("a date")).unwrap_or_default()
}

fn line(message: &str) -> String {
    line_on(FRIDAY, message)
}

fn entries(message: &str) -> Vec<String> {
    read_dates(message, dates::parse_now(FRIDAY).expect("a date"))
        .into_iter()
        .map(|reading| format!("{} = {}", reading.phrase, reading.resolution))
        .collect()
}

fn said(response: &Value) -> &str {
    response["text"].as_str().unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// a bare hour

#[test]
fn a_bare_hour_after_at_to_or_a_day_lists_both_readings() {
    assert_eq!(
        line("saturday at 3"),
        "dates: saturday = 2026-10-03 · at 3 = 15:00 (pm) / 03:00 (am)"
    );
    // a weekday that has gone by this week is two readings of its own
    assert_eq!(
        line("tuesday at 3"),
        "dates: tuesday = 2026-09-29 (past) / 2026-10-06 (upcoming) · at 3 = 15:00 (pm) / 03:00 (am)"
    );
    assert_eq!(
        line("sunday 11"),
        "dates: sunday = 2026-10-04 · 11 = 11:00 (am) / 23:00 (pm)"
    );
    assert_eq!(line("to 4"), "dates: to 4 = 16:00 (pm) / 04:00 (am)");
    assert_eq!(
        line("tomorrow 4"),
        "dates: tomorrow = 2026-10-03 · 4 = 16:00 (pm) / 04:00 (am)"
    );
    // twelve is noon, and a count of things is no hour
    assert_eq!(line("at 12"), "dates: at 12 = 12:00");
    assert_eq!(line("sunday 3 people"), "dates: sunday = 2026-10-04");
    assert_eq!(
        line("friday 11 dec"),
        "dates: friday 11 dec = 2025-12-11 (past) / 2026-12-11 (upcoming)"
    );
}

#[test]
fn a_word_that_settles_the_hour_leaves_one_reading() {
    for (message, clock) in [
        ("saturday at 3pm", "at 3pm = 15:00"),
        ("saturday at 3 am", "at 3 am = 03:00"),
        ("saturday afternoon at 3", "at 3 = 15:00"),
        ("saturday at 3 in the morning", "at 3 = 03:00"),
        ("saturday at 3 tonight", "at 3 = 15:00"),
    ] {
        let line = line(message);
        assert!(line.contains(&format!(" {clock}")), "{message}: {line}");
        assert!(!line.contains(" / "), "{message}: {line}");
    }
}

/// A reschedule of the dentist to `time`, in a session that heard `message`.
fn dentist_to(world: &World, message: &str, to: &str) -> Value {
    let mut session = world.session();
    session.user(message);
    call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Dentist",
               "args": format!("to: {to}")}),
    )
}

/// The start the dentist ends at, as the diff shows it.
fn started(reply: &Value) -> &str {
    reply["effect"]["diff"]["rows"][0]["fields"]["date"][1]
        .as_str()
        .unwrap_or_default()
}

#[test]
fn a_time_the_call_states_is_never_changed_by_a_bare_hour() {
    let world = seeded();
    // the model judges the hour: the reference calls state 19:00, 20:00, 21:00 and 03:00 and keep them
    for (message, time, start) in [
        (
            "move the dentist to tuesday at 3",
            "03:00",
            "2026-09-29T03:00:00",
        ),
        (
            "move the dentist to tuesday at 7",
            "19:00",
            "2026-09-29T19:00:00",
        ),
        (
            "move the dentist to tuesday at 8",
            "20:00",
            "2026-09-29T20:00:00",
        ),
        (
            "move the dentist to tuesday at 9",
            "21:00",
            "2026-09-29T21:00:00",
        ),
        (
            "move the dentist to tuesday at 3",
            "15:00",
            "2026-09-29T15:00:00",
        ),
        (
            "move the dentist to tuesday at 3",
            "14:00",
            "2026-09-29T14:00:00",
        ),
    ] {
        let reply = dentist_to(
            &world,
            message,
            &format!(r#"{{"date":"2026-09-29","time":"{time}"}}"#),
        );
        assert_eq!(started(&reply), start, "{message} {time}: {reply}");
        assert!(!said(&reply).contains("the call had no time"), "{reply}");
        assert!(reply["ends_turn"].as_bool().unwrap_or(false), "{reply}");
    }
}

#[test]
fn a_reschedule_to_the_time_the_row_has_ends_the_turn_whatever_the_hour_reads_as() {
    // the dentist is at 09:00; "ok make it 9 then" with the evening time stated moves it, once:
    // no "already" reply that leaves the turn open and no `then` entry on the line
    let world = seeded();
    let reply = dentist_to(
        &world,
        "ok make it 9 then",
        r#"{"date":"2026-10-02","time":"21:00"}"#,
    );
    assert_eq!(started(&reply), "2026-10-02T21:00:00", "{reply}");
    assert!(reply["ends_turn"].as_bool().unwrap_or(false), "{reply}");
    assert_eq!(
        line("ok make it 7 then"),
        "dates: make it 7 = 19:00 (pm) / 07:00 (am)"
    );
}

#[test]
fn an_event_day_with_no_time_takes_the_hour_the_way_an_appointment_is_booked() {
    let world = seeded();
    for (message, time) in [
        ("move the dentist to tuesday at 3", "15:00"),
        ("move the dentist to tuesday at 6", "18:00"),
        ("move the dentist to tuesday at 7", "19:00"),
        ("move the dentist to tuesday at 8", "20:00"),
        ("move the dentist to tuesday at 9", "09:00"),
        ("move the dentist to tuesday at 11", "11:00"),
    ] {
        let reply = dentist_to(&world, message, r#"{"date":"2026-09-29"}"#);
        assert_eq!(
            started(&reply),
            format!("2026-09-29T{time}:00"),
            "{message}: {reply}"
        );
        assert!(
            said(&reply).contains("the call had no time; used "),
            "{message}: {reply}"
        );
    }
    // the note, in full
    let reply = dentist_to(
        &world,
        "move the dentist to tuesday at 3",
        r#"{"date":"2026-09-29"}"#,
    );
    assert!(
        said(&reply).contains(
            "date: \"at 3\" is 15:00 or 03:00; the call had no time; used 15:00 (an hour from 1 to 8 is the afternoon or evening, from 9 to 11 the morning)."
        ),
        "{reply}"
    );
    // a weekday written relative takes it too
    let reply = dentist_to(
        &world,
        "move the dentist to next tuesday at 4",
        r#"{"unit":"week","rel":1,"weekday":2}"#,
    );
    assert_eq!(started(&reply), "2026-09-29T16:00:00", "{reply}");
}

#[test]
fn the_hour_the_words_settle_and_another_clock_are_left_alone() {
    let world = seeded();
    // "pm" says it: no bare hour, nothing is filled
    let reply = dentist_to(
        &world,
        "move the dentist to tuesday at 3pm",
        r#"{"date":"2026-09-29"}"#,
    );
    assert!(!said(&reply).contains("the call had no time"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// the rest of a period

#[test]
fn the_rest_of_the_week_the_month_and_today() {
    // a Friday: tomorrow to Sunday
    assert_eq!(
        line("what's left for the rest of the week"),
        "dates: the rest of the week = 2026-10-03..2026-10-04"
    );
    assert_eq!(
        line("rest of this week"),
        "dates: rest of this week = 2026-10-03..2026-10-04"
    );
    assert_eq!(
        line("the rest of the month"),
        "dates: the rest of the month = 2026-10-03..2026-10-31"
    );
    assert_eq!(
        line("rest of today"),
        "dates: rest of today = 2026-10-02 09:00..2026-10-02 23:59"
    );
    assert_eq!(
        line("the rest of the day"),
        "dates: the rest of the day = 2026-10-02 09:00..2026-10-02 23:59"
    );
    // a message about today starts it today
    assert_eq!(
        entries("what's left today and the rest of the week"),
        [
            "today = 2026-10-02",
            "the rest of the week = 2026-10-02..2026-10-04"
        ]
    );
    // on the last day of the period there is only that day
    assert_eq!(
        line_on("2026-10-04", "the rest of the week"),
        "dates: the rest of the week = 2026-10-04"
    );
    assert_eq!(
        line_on("2026-10-31", "the rest of the month"),
        "dates: the rest of the month = 2026-10-31"
    );
}

// ---------------------------------------------------------------------------------------------
// the day before and after

#[test]
fn the_day_before_or_after_a_date_and_n_days_before_one() {
    assert_eq!(
        line("the day before friday"),
        "dates: the day before friday = 2026-10-01"
    );
    assert_eq!(
        line("the day after next monday"),
        "dates: the day after next monday = 2026-10-06"
    );
    assert_eq!(
        line("3 days before the 15th"),
        "dates: 3 days before the 15th = 2026-09-12 (past) / 2026-10-12 (upcoming)"
    );
    assert_eq!(
        line("a week after next monday"),
        "dates: a week after next monday = 2026-10-12"
    );
    assert_eq!(
        line("two days before dec 11"),
        "dates: two days before dec 11 = 2025-12-09 (past) / 2026-12-09 (upcoming)"
    );
    assert_eq!(
        line("two days before dec 11 2026"),
        "dates: two days before dec 11 2026 = 2026-12-09"
    );
    // the old readings stay
    assert_eq!(
        line("the day before yesterday"),
        "dates: the day before yesterday = 2026-09-30"
    );
    // with nothing the talk resolved, "that" has no date
    assert_eq!(line("the day before that"), "");
}

#[test]
fn a_weekday_after_another_phrase_still_resolves() {
    assert_eq!(
        line("what's left on friday after that"),
        "dates: friday = 2026-10-02"
    );
    assert_eq!(
        line("anything on sunday after this"),
        "dates: sunday = 2026-10-04"
    );
    // "the friday after that" points back at the talk, as before
    assert_eq!(line("the friday after that"), "");
    assert_eq!(line("the monday before"), "");
}

#[test]
fn friday_same_time_is_the_friday() {
    assert_eq!(
        line("move it to friday same time"),
        "dates: friday = 2026-10-02"
    );
}

// ---------------------------------------------------------------------------------------------
// a time of day on a read

#[test]
fn a_part_of_the_day_on_a_read_is_a_span_never_an_instant() {
    assert_eq!(
        line("what's on sunday night"),
        "dates: sunday night = 2026-10-04 17:00..2026-10-04 23:59"
    );
    assert_eq!(
        line("anything saturday evening"),
        "dates: saturday evening = 2026-10-03 17:00..2026-10-03 23:59"
    );
    assert_eq!(
        line("what do i have tomorrow afternoon"),
        "dates: tomorrow afternoon = 2026-10-03 12:00..2026-10-03 16:59"
    );
    assert_eq!(
        line("what's on next friday morning"),
        "dates: next friday morning = 2026-10-09 06:00..2026-10-09 11:59"
    );
    // monday has gone by this week: the past one and the upcoming one
    assert_eq!(
        line("monday morning"),
        "dates: monday morning = 2026-09-28 06:00..2026-09-28 11:59 (past) / 2026-10-05 06:00..2026-10-05 11:59 (upcoming)"
    );
}

#[test]
fn a_part_of_the_day_on_a_write_stays_a_time() {
    assert_eq!(
        line("move the dentist to sunday morning"),
        "dates: sunday morning = 2026-10-04 09:00"
    );
    assert_eq!(
        line("add yoga saturday afternoon"),
        "dates: saturday afternoon = 2026-10-03 15:00"
    );
    assert_eq!(
        line("add yoga tuesday afternoon"),
        "dates: tuesday afternoon = 2026-09-29 15:00 (past) / 2026-10-06 15:00 (upcoming)"
    );
    assert_eq!(
        line("book the sitter for sunday evening"),
        "dates: sunday evening = 2026-10-04 18:00"
    );
    assert_eq!(
        line("schedule a call tomorrow night"),
        "dates: tomorrow night = 2026-10-03 20:00"
    );
    // a clock of its own is its own entry, and the day is the day
    assert_eq!(
        line("add drinks sunday night at 9"),
        "dates: sunday = 2026-10-04 · at 9 = 21:00"
    );
}

// ---------------------------------------------------------------------------------------------
// the conversation: that day, before <event>

#[test]
fn that_day_is_the_date_the_previous_message_said() {
    let world = seeded();
    let mut session = world.session();
    session.user("what's on next friday");
    // no talk yet: nothing to point at
    assert_eq!(session.dates_line("what about that day"), None);
    session.user("what about that day");
    assert_eq!(
        session.dates_line("what about that day").as_deref(),
        Some("dates: that day = 2026-10-02 (the second, turn 1)")
    );
    assert_eq!(
        session.dates_line("and the same day").as_deref(),
        Some("dates: the same day = 2026-10-02 (the second, turn 1)")
    );
    assert_eq!(
        session.dates_line("what about then").as_deref(),
        Some("dates: then = 2026-10-02 (the second, turn 1)")
    );
    // "and then add milk" is no time
    assert_eq!(session.dates_line("and then add milk"), None);
}

#[test]
fn that_day_is_the_date_a_write_set() {
    let world = seeded();
    let mut session = world.session();
    session.user("move the dentist to monday");
    call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Dentist",
               "args": "to: {\"date\":\"2026-09-28\"}"}),
    );
    session.user("what else is on that day");
    assert_eq!(
        session.dates_line("what else is on that day").as_deref(),
        Some("dates: that day = 2026-09-28 (the twenty-eighth, turn 1)")
    );
}

#[test]
fn that_day_is_the_one_day_the_previous_result_showed() {
    let world = seeded();
    let mut session = world.session();
    session.user("when's the dentist");
    find_in_turn(&mut session, "event", "Dentist");
    session.user("and that day");
    assert_eq!(
        session.dates_line("and that day").as_deref(),
        Some("dates: that day = 2026-10-02 (the second, turn 1)")
    );
}

#[test]
fn the_day_before_or_after_that_is_relative_to_it() {
    let world = seeded();
    let mut session = world.session();
    session.user("what's on next friday");
    session.user("and the day before that");
    assert_eq!(
        session.dates_line("and the day before that").as_deref(),
        Some("dates: the day before that = 2026-10-01 (the day before the second, turn 1)")
    );
    assert_eq!(
        session
            .dates_line("what about 2 days after that day")
            .as_deref(),
        Some("dates: 2 days after that day = 2026-10-04 (2 days after the second, turn 1)")
    );
}

#[test]
fn before_a_grounded_event_anchors_on_its_day() {
    let world = seeded();
    let mut session = world.session();
    let message = "what do i have before the ferry";
    session.user(message);
    let line = session.dates_line(message).expect("a line");
    assert!(
        line.starts_with("dates: before the ferry = ..2026-11-12 (#"),
        "{line}"
    );
    assert!(line.ends_with("event \"Ferry to Mallaig\")"), "{line}");
    let message = "anything after the ferry";
    session.user(message);
    let line = session.dates_line(message).expect("a line");
    assert!(
        line.starts_with("dates: after the ferry = 2026-11-12.. (#"),
        "{line}"
    );
    let message = "tasks until the ferry";
    session.user(message);
    let line = session.dates_line(message).expect("a line");
    assert!(
        line.starts_with("dates: until the ferry = ..2026-11-12 (#"),
        "{line}"
    );
    // a date of its own wins, and a row that is not grounded is no anchor
    assert_eq!(
        session.dates_line("before next friday").as_deref(),
        Some("dates: next friday = 2026-10-02")
    );
    assert_eq!(session.dates_line("before breakfast"), None);
}

// ---------------------------------------------------------------------------------------------
// the compile step reads the same entries the line shows

#[test]
fn a_pick_of_a_conversation_entry_compiles_to_its_date() {
    let world = seeded();
    let mut session = world.session();
    session.user("what's on next friday");
    session.user("what's on that day");
    let compiled = session.compile(&json!({
        "intent": "read", "via": "find", "kind": "event",
        "when": {"pick": {"date": 0}},
    }));
    assert!(compiled.get("refused").is_none(), "{compiled}");
    assert_eq!(
        compiled["call"]["args"]["when"], r#"{"date":"2026-10-02"}"#,
        "{compiled}"
    );
    assert_eq!(
        compiled["resolved"]["dates"][0]["resolution"],
        "2026-10-02 (the second, turn 1)"
    );
}

// ---------------------------------------------------------------------------------------------
// "friday same time" on a reschedule

#[test]
fn a_reschedule_to_a_day_with_the_same_time_keeps_the_rows_time() {
    let world = seeded();
    // a time the call states is the model's judgement and stays
    let reply = dentist_to(
        &world,
        "move the dentist to saturday same time",
        r#"{"date":"2026-10-03","time":"09:00"}"#,
    );
    assert!(!said(&reply).contains("the same time"), "{reply}");
    assert_eq!(started(&reply), "2026-10-03T09:00:00", "{reply}");
    // a day alone: said, nothing changed
    let reply = dentist_to(
        &world,
        "move the dentist to tuesday same time",
        r#"{"date":"2026-09-29"}"#,
    );
    assert!(
        said(&reply)
            .contains("date: the same time keeps the row's time; the call moves the day only."),
        "{reply}"
    );
    assert_eq!(
        reply["effect"]["diff"]["rows"][0]["fields"]["date"][1], "2026-09-29T09:00:00",
        "{reply}"
    );
}

#[test]
fn the_likelier_reading_of_a_bare_hour_comes_first() {
    // 1 to 8 read pm first, 9 to 11 am first; 12 is as written
    for (message, resolution) in [
        ("at 4", "16:00 (pm) / 04:00 (am)"),
        ("at 8", "20:00 (pm) / 08:00 (am)"),
        ("at 8:30", "20:30 (pm) / 08:30 (am)"),
        ("at 9", "09:00 (am) / 21:00 (pm)"),
        ("at 11", "11:00 (am) / 23:00 (pm)"),
        ("quarter to 9", "08:45 (am) / 20:45 (pm)"),
        ("at 12", "12:00"),
    ] {
        assert_eq!(line(message), format!("dates: {message} = {resolution}"));
    }
    assert_eq!(
        line("saturday at 4"),
        "dates: saturday = 2026-10-03 · at 4 = 16:00 (pm) / 04:00 (am)"
    );
}
