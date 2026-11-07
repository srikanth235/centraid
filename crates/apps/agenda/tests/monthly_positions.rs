//! THE MONTH-POSITION RULES THROUGH AGENDA'S EXPANSION (#1119, R-1119-1).
//!
//! The vault's one expander now takes `FREQ=MONTHLY` with one positional
//! `BYDAY` or one `BYMONTHDAY`. Agenda has no expander of its own
//! ([`expand_recurring_events`] calls it), so this proves the series Agenda
//! shows are the ones the engine expands: the second Monday of each month, and
//! the last day of each month — including the months that are short.

use centraid_apps_agenda::expansion::expand_recurring_events;
use centraid_apps_agenda::queries::EventRow;
use centraid_vault::time::rrule;

fn series(rrule: &str, dtstart: &str) -> EventRow {
    EventRow {
        event_id: "e1".to_owned(),
        summary: Some("Rent".to_owned()),
        dtstart: dtstart.to_owned(),
        dtend: Some(dtstart.replace("09:00", "10:00")),
        start_tz: Some("America/Los_Angeles".to_owned()),
        recurrence_semantics: Some("zoned".to_owned()),
        rrule: Some(rrule.to_owned()),
        ..EventRow::default()
    }
}

fn starts(rows: &[EventRow]) -> Vec<String> {
    rows.iter().map(|row| row.dtstart.clone()).collect()
}

#[test]
fn the_second_monday_and_the_last_day_expand_in_the_series_own_zone() {
    // 09:00 PST on the second Monday of January 2026.
    let second_monday = expand_recurring_events(
        vec![series("FREQ=MONTHLY;BYDAY=2MO", "2026-01-12T17:00:00.000Z")],
        "2026-01-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
        &[],
    )
    .expect("expands");
    assert_eq!(
        starts(&second_monday),
        [
            "2026-01-12T17:00:00.000Z",
            "2026-02-09T17:00:00.000Z",
            "2026-03-09T16:00:00.000Z", // PDT began on the 8th: 09:00 is 16:00Z
            "2026-04-13T16:00:00.000Z",
        ]
    );
    // The occurrence's own identity is its series-local wall clock.
    assert_eq!(
        second_monday[2].original_start_local.as_deref(),
        Some("2026-03-09T09:00:00")
    );

    let month_end = expand_recurring_events(
        vec![series(
            "FREQ=MONTHLY;BYMONTHDAY=-1",
            "2026-01-31T17:00:00.000Z",
        )],
        "2026-01-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
        &[],
    )
    .expect("expands");
    assert_eq!(
        starts(&month_end),
        [
            "2026-01-31T17:00:00.000Z",
            "2026-02-28T17:00:00.000Z",
            "2026-03-31T16:00:00.000Z",
            "2026-04-30T16:00:00.000Z",
        ]
    );
}

#[test]
fn a_31st_skips_the_short_months_and_the_positions_have_a_shape() {
    let rows = expand_recurring_events(
        vec![series(
            "FREQ=MONTHLY;BYMONTHDAY=31",
            "2026-01-31T17:00:00.000Z",
        )],
        "2026-01-01T00:00:00.000Z",
        "2026-06-01T00:00:00.000Z",
        &[],
    )
    .expect("expands");
    assert_eq!(
        starts(&rows),
        [
            "2026-01-31T17:00:00.000Z",
            "2026-03-31T16:00:00.000Z",
            "2026-05-31T16:00:00.000Z",
        ]
    );
    // The words are the core strings' (`crates/screens/tests/agenda_repeat_words.rs`).
    assert!(rrule::shape("FREQ=MONTHLY;BYMONTHDAY=-1").is_some());
    assert!(rrule::shape("FREQ=MONTHLY;BYDAY=2MO").is_some());
}

#[test]
fn a_still_refused_form_keeps_the_anchor_rather_than_erasing_the_event() {
    let rows = expand_recurring_events(
        vec![series(
            "FREQ=MONTHLY;BYDAY=2MO;BYHOUR=9",
            "2026-01-12T17:00:00.000Z",
        )],
        "2026-01-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
        &[],
    )
    .expect("expands");
    assert_eq!(starts(&rows), ["2026-01-12T17:00:00.000Z"]);
    assert_eq!(rrule::shape("FREQ=MONTHLY;BYDAY=2MO;BYHOUR=9"), None);
}

#[test]
fn a_rule_that_once_was_refused_now_expands_through_agenda() {
    // The last weekday of the month via BYSETPOS (#1173), 09:00 PST.
    let rows = expand_recurring_events(
        vec![series(
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
            "2026-01-30T17:00:00.000Z",
        )],
        "2026-01-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
        &[],
    )
    .expect("expands");
    assert_eq!(
        starts(&rows),
        [
            "2026-01-30T17:00:00.000Z",
            "2026-02-27T17:00:00.000Z",
            "2026-03-31T16:00:00.000Z", // PDT: 09:00 is 16:00Z
            "2026-04-30T16:00:00.000Z",
        ]
    );
    assert!(rrule::shape("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1").is_some());
}

/// RFC 5545 (owner decision on #1173): a plain monthly series that starts on
/// the 31st names no day, takes the 31st from its start, and SKIPS the months
/// that have none; it no longer lands on the month's last day.
#[test]
fn a_plain_monthly_series_on_the_31st_skips_the_short_months() {
    let rows = expand_recurring_events(
        vec![series("FREQ=MONTHLY", "2026-01-31T17:00:00.000Z")],
        "2026-01-01T00:00:00.000Z",
        "2026-06-01T00:00:00.000Z",
        &[],
    )
    .expect("expands");
    assert_eq!(
        starts(&rows),
        [
            "2026-01-31T17:00:00.000Z",
            "2026-03-31T16:00:00.000Z",
            "2026-05-31T16:00:00.000Z",
        ],
        "February and April have no 31st"
    );
}
