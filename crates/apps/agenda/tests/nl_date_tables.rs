//! Phrase-family tables for the quick-add date parser (see `nl_date.rs` for the rest). Every `now` is pinned; nothing reads a clock.

use centraid_apps_agenda::nl_date::{Now, Parsed, parse};

/// A Saturday, mid-morning.
const SAT: &str = "2026-11-07T10:30";
/// The same Saturday, late evening.
const SAT_LATE: &str = "2026-11-07T21:15";
/// A Thursday, year end.
const DEC31: &str = "2026-12-31T09:00";
/// Non-leap February 28.
const FEB28: &str = "2027-02-28T12:00";
/// Leap-year February 28.
const FEB28_LEAP: &str = "2028-02-28T12:00";

fn run(input: &str, now: &str) -> Parsed {
    let now = Now::parse(now).expect("table nows are well formed");
    parse(input, &now)
}

type Row = (
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
    Option<&'static str>,
);

fn check(rows: &[Row]) {
    for (input, now, title, due, rule) in rows {
        let p = run(input, now);
        let got_due = p.when.as_ref().map(|w| w.due());
        let got_rule = p.repeat.as_ref().map(|r| r.rule());
        assert_eq!(
            (p.title.as_str(), got_due.as_deref(), got_rule.as_deref()),
            (*title, *due, *rule),
            "input {input:?} at {now}"
        );
    }
}

#[test]
fn days() {
    check(&[
        ("Call mom today", SAT, "Call mom", Some("2026-11-07"), None),
        (
            "Call mom tomorrow",
            SAT,
            "Call mom",
            Some("2026-11-08"),
            None,
        ),
        (
            "Call mom tonight",
            SAT,
            "Call mom",
            Some("2026-11-07T20:00:00"),
            None,
        ),
        (
            "Call mom tonight",
            SAT_LATE,
            "Call mom",
            Some("2026-11-07"),
            None,
        ),
        (
            "Call mom tonight at 9",
            SAT,
            "Call mom",
            Some("2026-11-07T21:00:00"),
            None,
        ),
        (
            "Call mom tonight at 9pm",
            SAT,
            "Call mom",
            Some("2026-11-07T21:00:00"),
            None,
        ),
        ("x fri", SAT, "x", Some("2026-11-13"), None),
        ("x friday", SAT, "x", Some("2026-11-13"), None),
        ("x sun", SAT, "x", Some("2026-11-08"), None),
        ("x mon", SAT, "x", Some("2026-11-09"), None),
        ("x tue", SAT, "x", Some("2026-11-10"), None),
        ("x tues", SAT, "x", Some("2026-11-10"), None),
        ("x tuesday", SAT, "x", Some("2026-11-10"), None),
        ("x wed", SAT, "x", Some("2026-11-11"), None),
        ("x wednesday", SAT, "x", Some("2026-11-11"), None),
        ("x thu", SAT, "x", Some("2026-11-12"), None),
        ("x thur", SAT, "x", Some("2026-11-12"), None),
        ("x thurs", SAT, "x", Some("2026-11-12"), None),
        ("x thursday", SAT, "x", Some("2026-11-12"), None),
        ("x sat", SAT, "x", Some("2026-11-07"), None),
        ("x saturday", SAT, "x", Some("2026-11-07"), None),
        ("x this sat", SAT, "x", Some("2026-11-07"), None),
        ("x this fri", SAT, "x", Some("2026-11-13"), None),
        ("x next sat", SAT, "x", Some("2026-11-14"), None),
        ("x next fri", SAT, "x", Some("2026-11-13"), None),
        ("x next monday", SAT, "x", Some("2026-11-09"), None),
        ("x next week", SAT, "x", Some("2026-11-09"), None),
        ("x next month", SAT, "x", Some("2026-12-01"), None),
        ("x in 3 days", SAT, "x", Some("2026-11-10"), None),
        ("x in 1 day", SAT, "x", Some("2026-11-08"), None),
        ("x in a day", SAT, "x", Some("2026-11-08"), None),
        ("x in a week", SAT, "x", Some("2026-11-14"), None),
        ("x in 2 weeks", SAT, "x", Some("2026-11-21"), None),
        ("x in two weeks", SAT, "x", Some("2026-11-21"), None),
        ("x in 999 days", SAT, "x", Some("2029-08-02"), None),
        ("x in 2 hours", SAT, "x", Some("2026-11-07T12:30:00"), None),
        ("x in an hour", SAT, "x", Some("2026-11-07T11:30:00"), None),
        (
            "x in 45 minutes",
            SAT,
            "x",
            Some("2026-11-07T11:15:00"),
            None,
        ),
        (
            "x in 3 hours",
            SAT_LATE,
            "x",
            Some("2026-11-08T00:15:00"),
            None,
        ),
        (
            "x in 30 minutes",
            "2026-11-07T23:45",
            "x",
            Some("2026-11-08T00:15:00"),
            None,
        ),
        ("x in 0 days", SAT, "x in 0 days", None, None),
        ("x in 1000 days", SAT, "x in 1000 days", None, None),
    ]);
}

#[test]
fn dates() {
    check(&[
        ("x dec 4", SAT, "x", Some("2026-12-04"), None),
        ("x december 4", SAT, "x", Some("2026-12-04"), None),
        ("x 4 dec", SAT, "x", Some("2026-12-04"), None),
        ("x dec 4th", SAT, "x", Some("2026-12-04"), None),
        ("x 4th december", SAT, "x", Some("2026-12-04"), None),
        ("x 1st jan", SAT, "x", Some("2027-01-01"), None),
        ("x sept 22", SAT, "x", Some("2027-09-22"), None),
        ("x dec 4 2027", SAT, "x", Some("2027-12-04"), None),
        ("x 4 dec 2027", SAT, "x", Some("2027-12-04"), None),
        ("x dec 4 2020", SAT, "x", Some("2020-12-04"), None),
        ("x 2026-12-04", SAT, "x", Some("2026-12-04"), None),
        ("x 2020-01-02", SAT, "x", Some("2020-01-02"), None),
        ("x oct 3", SAT, "x", Some("2027-10-03"), None),
        ("x nov 6", SAT, "x", Some("2027-11-06"), None),
        ("x nov 7", SAT, "x", Some("2026-11-07"), None),
        ("x nov 8", SAT, "x", Some("2026-11-08"), None),
        ("x feb 30", SAT, "x feb 30", None, None),
        ("x apr 31", SAT, "x apr 31", None, None),
        ("x dec 32", SAT, "x dec 32", None, None),
        ("x dec 0", SAT, "x dec 0", None, None),
        (
            "x dec 4 at 14:30",
            SAT,
            "x",
            Some("2026-12-04T14:30:00"),
            None,
        ),
        (
            "x on dec 4 at 14:30",
            SAT,
            "x",
            Some("2026-12-04T14:30:00"),
            None,
        ),
        ("x by friday", SAT, "x", Some("2026-11-13"), None),
        ("x on 2026-12-04", SAT, "x", Some("2026-12-04"), None),
        ("x 14:30 dec 4", SAT, "x", Some("2026-12-04T14:30:00"), None),
        // Year rollover and leap days.
        ("x dec 30", DEC31, "x", Some("2027-12-30"), None),
        ("x dec 31", DEC31, "x", Some("2026-12-31"), None),
        ("x jan 2", DEC31, "x", Some("2027-01-02"), None),
        ("x tomorrow", DEC31, "x", Some("2027-01-01"), None),
        ("x next month", DEC31, "x", Some("2027-01-01"), None),
        ("x in 2 days", DEC31, "x", Some("2027-01-02"), None),
        ("x next week", DEC31, "x", Some("2027-01-04"), None),
        ("x tomorrow", FEB28, "x", Some("2027-03-01"), None),
        ("x feb 29", FEB28, "x", Some("2028-02-29"), None),
        ("x tomorrow", FEB28_LEAP, "x", Some("2028-02-29"), None),
        ("x feb 29", FEB28_LEAP, "x", Some("2028-02-29"), None),
        ("x in 2 days", FEB28_LEAP, "x", Some("2028-03-01"), None),
        ("x feb 29 2027", FEB28, "x feb 29 2027", None, None),
    ]);
}

#[test]
fn times() {
    check(&[
        ("x at 9am", SAT, "x", Some("2026-11-08T09:00:00"), None),
        ("x at 11am", SAT, "x", Some("2026-11-07T11:00:00"), None),
        ("x at 10:30am", SAT, "x", Some("2026-11-08T10:30:00"), None),
        ("x at 10:31am", SAT, "x", Some("2026-11-07T10:31:00"), None),
        ("x 9am", SAT, "x", Some("2026-11-08T09:00:00"), None),
        ("x 9 am", SAT, "x", Some("2026-11-08T09:00:00"), None),
        ("x 9:30pm", SAT, "x", Some("2026-11-07T21:30:00"), None),
        ("x 9:30 pm", SAT, "x", Some("2026-11-07T21:30:00"), None),
        ("x 12am", SAT, "x", Some("2026-11-08T00:00:00"), None),
        ("x 12pm", SAT, "x", Some("2026-11-07T12:00:00"), None),
        ("x 14:30", SAT, "x", Some("2026-11-07T14:30:00"), None),
        ("x 09:00", SAT, "x", Some("2026-11-08T09:00:00"), None),
        ("x 0:15", SAT, "x", Some("2026-11-08T00:15:00"), None),
        ("x 23:59", SAT, "x", Some("2026-11-07T23:59:00"), None),
        ("x noon", SAT, "x", Some("2026-11-07T12:00:00"), None),
        ("x at noon", SAT, "x", Some("2026-11-07T12:00:00"), None),
        (
            "x noon",
            "2026-11-07T12:00",
            "x",
            Some("2026-11-08T12:00:00"),
            None,
        ),
        (
            "x tomorrow morning",
            SAT,
            "x",
            Some("2026-11-08T09:00:00"),
            None,
        ),
        (
            "x tomorrow afternoon",
            SAT,
            "x",
            Some("2026-11-08T15:00:00"),
            None,
        ),
        ("x fri evening", SAT, "x", Some("2026-11-13T19:00:00"), None),
        (
            "x this afternoon",
            SAT,
            "x",
            Some("2026-11-07T15:00:00"),
            None,
        ),
        (
            "x this evening",
            SAT,
            "x",
            Some("2026-11-07T19:00:00"),
            None,
        ),
        ("x morning", SAT, "x morning", None, None),
        ("x evening", SAT, "x evening", None, None),
        ("x at evening", SAT, "x at evening", None, None),
        // The ambiguity rule for a bare hour.
        ("x at 6", SAT, "x", Some("2026-11-07T18:00:00"), None),
        ("x at 1", SAT, "x", Some("2026-11-07T13:00:00"), None),
        ("x at 7", SAT, "x", Some("2026-11-08T07:00:00"), None),
        ("x at 11", SAT, "x", Some("2026-11-07T11:00:00"), None),
        ("x at 12", SAT, "x", Some("2026-11-07T12:00:00"), None),
        ("x at 12:30", SAT, "x", Some("2026-11-07T12:30:00"), None),
        ("x at 6:30", SAT, "x", Some("2026-11-07T18:30:00"), None),
        ("x at 7:15", SAT, "x", Some("2026-11-08T07:15:00"), None),
        ("x at 14", SAT, "x", Some("2026-11-07T14:00:00"), None),
        ("x at 14:30", SAT, "x", Some("2026-11-07T14:30:00"), None),
        ("x at 6", SAT_LATE, "x", Some("2026-11-08T18:00:00"), None),
        ("x at 9pm", SAT_LATE, "x", Some("2026-11-08T21:00:00"), None),
        (
            "x at 9:30pm",
            SAT_LATE,
            "x",
            Some("2026-11-07T21:30:00"),
            None,
        ),
        (
            "x at 11pm",
            SAT_LATE,
            "x",
            Some("2026-11-07T23:00:00"),
            None,
        ),
        // Day and time, either order.
        (
            "x tomorrow 9am",
            SAT,
            "x",
            Some("2026-11-08T09:00:00"),
            None,
        ),
        (
            "x tomorrow at 9am",
            SAT,
            "x",
            Some("2026-11-08T09:00:00"),
            None,
        ),
        (
            "x 9am tomorrow",
            SAT,
            "x",
            Some("2026-11-08T09:00:00"),
            None,
        ),
        (
            "x at 6 tomorrow",
            SAT,
            "x",
            Some("2026-11-08T18:00:00"),
            None,
        ),
        (
            "x next fri at 6pm",
            SAT,
            "x",
            Some("2026-11-13T18:00:00"),
            None,
        ),
        (
            "x today at 9am",
            SAT,
            "x",
            Some("2026-11-07T09:00:00"),
            None,
        ),
        ("x sat at 9am", SAT, "x", Some("2026-11-14T09:00:00"), None),
        ("x sat at 6pm", SAT, "x", Some("2026-11-07T18:00:00"), None),
        // Out of range.
        ("x at 25:00", SAT, "x at 25:00", None, None),
        ("x 14:60", SAT, "x 14:60", None, None),
        ("x 13pm", SAT, "x 13pm", None, None),
        ("x 0am", SAT, "x 0am", None, None),
        ("x at 24", SAT, "x at 24", None, None),
    ]);
}

#[test]
fn repeats() {
    check(&[
        (
            "x every day",
            SAT,
            "x",
            Some("2026-11-07"),
            Some("FREQ=DAILY"),
        ),
        ("x daily", SAT, "x", Some("2026-11-07"), Some("FREQ=DAILY")),
        (
            "x every weekday",
            SAT,
            "x",
            Some("2026-11-09"),
            Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"),
        ),
        (
            "x every weekday",
            "2026-11-06T10:30",
            "x",
            Some("2026-11-06"),
            Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"),
        ),
        (
            "x every week",
            SAT,
            "x",
            Some("2026-11-07"),
            Some("FREQ=WEEKLY;BYDAY=SA"),
        ),
        (
            "x weekly",
            SAT,
            "x",
            Some("2026-11-07"),
            Some("FREQ=WEEKLY;BYDAY=SA"),
        ),
        (
            "x every monday",
            SAT,
            "x",
            Some("2026-11-09"),
            Some("FREQ=WEEKLY;BYDAY=MO"),
        ),
        (
            "x every sat",
            SAT,
            "x",
            Some("2026-11-07"),
            Some("FREQ=WEEKLY;BYDAY=SA"),
        ),
        (
            "x every sunday",
            SAT,
            "x",
            Some("2026-11-08"),
            Some("FREQ=WEEKLY;BYDAY=SU"),
        ),
        (
            "x every month",
            SAT,
            "x",
            Some("2026-11-07"),
            Some("FREQ=MONTHLY"),
        ),
        (
            "x monthly",
            SAT,
            "x",
            Some("2026-11-07"),
            Some("FREQ=MONTHLY"),
        ),
        (
            "x every year",
            SAT,
            "x",
            Some("2026-11-07"),
            Some("FREQ=YEARLY"),
        ),
        (
            "x yearly",
            SAT,
            "x",
            Some("2026-11-07"),
            Some("FREQ=YEARLY"),
        ),
        (
            "x annually",
            SAT,
            "x",
            Some("2026-11-07"),
            Some("FREQ=YEARLY"),
        ),
        (
            "x every monday at 9",
            SAT,
            "x",
            Some("2026-11-09T09:00:00"),
            Some("FREQ=WEEKLY;BYDAY=MO"),
        ),
        (
            "x every sat at 9am",
            SAT,
            "x",
            Some("2026-11-14T09:00:00"),
            Some("FREQ=WEEKLY;BYDAY=SA"),
        ),
        (
            "x every sat at 6pm",
            SAT,
            "x",
            Some("2026-11-07T18:00:00"),
            Some("FREQ=WEEKLY;BYDAY=SA"),
        ),
        (
            "x daily at 7am",
            SAT,
            "x",
            Some("2026-11-08T07:00:00"),
            Some("FREQ=DAILY"),
        ),
        (
            "x daily at 7pm",
            SAT,
            "x",
            Some("2026-11-07T19:00:00"),
            Some("FREQ=DAILY"),
        ),
        (
            "x at 7pm every day",
            SAT,
            "x",
            Some("2026-11-07T19:00:00"),
            Some("FREQ=DAILY"),
        ),
        (
            "x every day at 9:30",
            SAT,
            "x",
            Some("2026-11-08T09:30:00"),
            Some("FREQ=DAILY"),
        ),
        ("x every fortnight", SAT, "x every fortnight", None, None),
        ("x every", SAT, "x every", None, None),
        (
            "x every monday tomorrow",
            SAT,
            "x every monday",
            Some("2026-11-08"),
            None,
        ),
    ]);
}
