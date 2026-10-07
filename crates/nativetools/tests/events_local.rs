//! The runtime reads events on the person's own days (#1088, R-1088-8).
//!
//! `World` reads the events of the days around today through Agenda's own read
//! (`centraid_apps_agenda::occurrences`, by `Door::events`): placed in the person's zone, a repeating
//! series as one row per occurrence. A stored event the zone does not move reads as it is stored,
//! so the harness (`Etc/UTC`) reads what it always has.

mod common;

use centraid_nativetools::dates;
use common::{World, call, seeded};
use serde_json::{Value, json};

const TODAY: &str = "2026-09-27";

/// An event stored as an instant in UTC.
fn night_call(world: &World) {
    world.elsewhere(
        "schedule.propose_event",
        json!({
            "summary": "Night call",
            "dtstart": "2026-09-27T22:30:00.000Z",
            "dtend": "2026-09-27T23:30:00.000Z",
            "start_tz": "Etc/UTC",
            "recurrence_semantics": "zoned",
            "calendar_id": world.calendar(),
        }),
    );
}

fn found(session: &mut centraid_nativetools::Session, args: Value) -> Value {
    session.user("");
    call(session, "find", args)
}

fn rows(response: &Value) -> usize {
    response["effect"]["rows"].as_array().expect("rows").len()
}

fn text(response: &Value) -> String {
    response["text"].as_str().expect("a text").to_owned()
}

#[test]
fn a_late_evening_utc_event_falls_on_the_next_local_day() {
    let world = seeded();
    night_call(&world);
    let named = json!({"kind": "event", "name": "Night call"});

    // in UTC it is tonight at 22:30: today
    let mut utc = world.session_in(TODAY, "Etc/UTC");
    let seen = found(&mut utc, named.clone());
    assert!(
        text(&seen).contains("Sun 2026-09-27 22:30 (today)"),
        "{}",
        text(&seen)
    );
    let on_today = found(
        &mut utc,
        json!({"kind": "event", "name": "Night call", "when": {"unit": "day", "rel": 0}}),
    );
    assert!(!text(&on_today).contains("note:"), "{}", text(&on_today));

    // in Tokyo (UTC+9) the same instant is 07:30 the next morning: tomorrow
    let mut tokyo = world.session_in(TODAY, "Asia/Tokyo");
    let seen = found(&mut tokyo, named);
    assert!(
        text(&seen).contains("Mon 2026-09-28 07:30 (tomorrow)"),
        "{}",
        text(&seen)
    );
    let on_today = found(
        &mut tokyo,
        json!({"kind": "event", "name": "Night call", "when": {"unit": "day", "rel": 0}}),
    );
    assert!(
        text(&on_today).contains("note: none"),
        "nothing is on Tokyo's today: {}",
        text(&on_today)
    );
    let on_tomorrow = found(
        &mut tokyo,
        json!({"kind": "event", "name": "Night call", "when": {"unit": "day", "rel": 1}}),
    );
    assert_eq!(rows(&on_tomorrow), 1);
    assert!(
        !text(&on_tomorrow).contains("note:"),
        "{}",
        text(&on_tomorrow)
    );
}

#[test]
fn the_session_clock_follows_the_request() {
    let world = seeded();
    night_call(&world);
    let mut session = world.session_in(TODAY, "Etc/UTC");
    let before = found(&mut session, json!({"kind": "event", "name": "Night call"}));
    assert!(text(&before).contains("Sun 2026-09-27 22:30"));
    // the person lands in Auckland (UTC+13): their today is already the 28th
    session
        .set_clock(
            dates::parse_now("2026-09-28T12:00").expect("a time"),
            "Pacific/Auckland",
        )
        .expect("the clock moves");
    let after = found(&mut session, json!({"kind": "event", "name": "Night call"}));
    assert!(
        text(&after).contains("Mon 2026-09-28 11:30"),
        "{}",
        text(&after)
    );
    assert_eq!(session.today().to_string(), "2026-09-28");
}

#[test]
fn a_weekly_event_is_read_as_its_occurrences_in_a_two_week_window() {
    let world = seeded();
    world.elsewhere(
        "schedule.propose_event",
        json!({
            "summary": "Book club",
            "dtstart": "2026-09-01T19:00:00",
            "dtend": "2026-09-01T20:00:00",
            "rrule": "FREQ=WEEKLY;BYDAY=TU",
            "calendar_id": world.calendar(),
        }),
    );
    let mut session = world.session_in(TODAY, "Etc/UTC");
    let window = json!({"from": {"date": "2026-09-28"}, "to": {"date": "2026-10-11"}});
    let seen = found(
        &mut session,
        json!({"kind": "event", "name": "Book club", "when": window}),
    );
    let shown = text(&seen);
    assert_eq!(rows(&seen), 2, "{shown}");
    assert!(
        shown.contains("Tue 2026-09-29 19:00") && shown.contains("Tue 2026-10-06 19:00"),
        "{shown}"
    );
    assert!(
        !shown.contains("2026-09-01"),
        "the series' first day is not in the window: {shown}"
    );

    // one occurrence cannot be changed here: the runtime says so and writes nothing
    let one = format!("#{}", seen["effect"]["rows"][0]["n"]);
    let cancel = call(&mut session, "act", json!({"verb": "cancel", "rows": one}));
    assert_eq!(
        cancel["effect"]["decline"]["reason"],
        json!("out_of_scope"),
        "{cancel}"
    );
}

#[test]
fn a_zone_the_door_does_not_know_leaves_the_events_as_stored() {
    let world = seeded();
    night_call(&world);
    let mut session = world.session_in(TODAY, "Not/AZone");
    let seen = found(&mut session, json!({"kind": "event", "name": "Night call"}));
    assert!(
        text(&seen).contains("Sun 2026-09-27 22:30"),
        "{}",
        text(&seen)
    );
}
