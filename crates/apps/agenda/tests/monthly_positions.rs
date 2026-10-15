//! THE MONTH-POSITION RULES THROUGH AGENDA'S EXPANSION (#1119, R-1119-1).
//!
//! The vault's one expander now takes `FREQ=MONTHLY` with one positional
//! `BYDAY` or one `BYMONTHDAY`. Agenda has no expander of its own
//! ([`expand_recurring_events`] calls it), so this proves the series Agenda
//! shows are the ones the engine expands: the second Monday of each month, and
//! the last day of each month — including the months that are short.

use centraid_apps_agenda::expansion::{expand_recurring_events, recurrence_summary};
use centraid_apps_agenda::queries::EventRow;

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
fn a_31st_skips_the_short_months_and_the_summary_says_so_in_words() {
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
    assert_eq!(
        recurrence_summary(Some("FREQ=MONTHLY;BYMONTHDAY=-1")).as_deref(),
        Some("Monthly on the last day")
    );
    assert_eq!(
        recurrence_summary(Some("FREQ=MONTHLY;BYDAY=2MO")).as_deref(),
        Some("Monthly on the second Monday")
    );
}

#[test]
fn a_still_refused_form_keeps_the_anchor_rather_than_erasing_the_event() {
    let rows = expand_recurring_events(
        vec![series(
            "FREQ=MONTHLY;BYDAY=2MO;BYSETPOS=1",
            "2026-01-12T17:00:00.000Z",
        )],
        "2026-01-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
        &[],
    )
    .expect("expands");
    assert_eq!(starts(&rows), ["2026-01-12T17:00:00.000Z"]);
    assert_eq!(
        recurrence_summary(Some("FREQ=MONTHLY;BYDAY=2MO;BYSETPOS=1")),
        None
    );
}
