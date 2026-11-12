//! THE RRULE ENGINE'S EXPANSION, EXHAUSTIVELY (#1173, "custom repeat: any RRULE").
//!
//! Every expectation here is a fixed answer, not a recomputation: the RFC 5545
//! section 3.8.5.3 examples are the RFC's own lists; the part-by-part tables
//! were cross-checked against an independent implementation (`python-dateutil`)
//! when written and then frozen, with the one place the engine departs from
//! it written down next to the test that pins it (a `BYWEEKNO` that names no
//! day). The two departures it used to keep, clamping an implied 31st and
//! skipping a spring-forward gap, were FLIPPED to RFC 5545 by the owner's
//! decision on #1173 (a calendar followed from EventKit and CalendarContract has to
//! expand exactly the phone's occurrences). **No test reads the wall clock**: every
//! series has an explicit anchor and an explicit range, and the DST tests name
//! the instants.
//!
//! | Section | What it pins |
//! |---|---|
//! | RFC 5545 examples | every day-or-coarser example of 3.8.5.3, in `America/New_York` |
//! | part tables | each `BYxxx` part and each combination, month ends, leap days, week 53, `WKST`, `BYSETPOS`, in two zones |
//! | UNTIL and COUNT | inclusive bounds, every `UNTIL` spelling, in three zones |
//! | DST | New York, London and Sydney (southern hemisphere): the gap, the fold, the wall clock |
//! | caps and walks | instance caps, rules that never land, a window far past the anchor |
//! | tasks | next occurrence, completion anchors, collapsing, exceptions |

use centraid_vault::clock::format_iso_ms;
use centraid_vault::time::civil::parse_civil_ms;
use centraid_vault::time::recurrence::{
    ABSOLUTE_MAX_INSTANCES, CollapseInput, ExceptionAction, ExceptionScope, ExpandInput,
    NextOccurrenceInput, Occurrence, RecurrenceAnchor, RecurrenceException, Semantics,
    apply_exceptions, collapse_missed, expand, next_occurrence,
};
use centraid_vault::time::zone::FireZone;

fn zone(name: &str) -> FireZone {
    FireZone::named(name).unwrap_or_else(|error| panic!("{name}: {error}"))
}

/// A zoned series anchored on a wall clock in `tz`, expanded over `[anchor, to)`.
fn expand_zoned(rule: &str, wall: &str, tz: &str, to: &str, cap: usize) -> Vec<Occurrence> {
    let zone = zone(tz);
    let anchor = format_iso_ms(
        parse_civil_ms(wall, &zone).unwrap_or_else(|| panic!("{wall} is not a wall clock")),
    );
    expand(
        &ExpandInput::new(rule, &anchor, &anchor, to)
            .in_zone(&zone)
            .at_most(cap),
    )
}

/// The wall-clock dates (`YYYY-MM-DD`) of a series.
fn dates(occurrences: &[Occurrence]) -> Vec<String> {
    occurrences
        .iter()
        .map(|occurrence| occurrence.wall_start[..10].to_owned())
        .collect()
}

fn words(text: &str) -> Vec<&str> {
    text.split_whitespace().collect()
}

// ---------------------------------------------------------------------------
// RFC 5545 section 3.8.5.3
// ---------------------------------------------------------------------------

struct Case {
    rule: &'static str,
    start: &'static str,
    /// How many of a "forever" series to compare; 0 is all of it.
    take: usize,
    expect: &'static str,
}

/// The RFC's examples whose frequency is a day or coarser, with the RFC's own
/// lists. All start at 09:00 in `America/New_York` (EDT, then EST after
/// 1997-10-26). The examples with an `UNTIL` are their own tests below.
const RFC_5545: &[Case] = &[
    Case {
        rule: "FREQ=DAILY;COUNT=10",
        start: "1997-09-02T09:00",
        take: 0,
        expect: "1997-09-02 1997-09-03 1997-09-04 1997-09-05 1997-09-06 1997-09-07 1997-09-08 1997-09-09 \
        1997-09-10 1997-09-11",
    },
    Case {
        rule: "FREQ=DAILY;INTERVAL=2",
        start: "1997-09-02T09:00",
        take: 15,
        expect: "1997-09-02 1997-09-04 1997-09-06 1997-09-08 1997-09-10 1997-09-12 1997-09-14 1997-09-16 \
        1997-09-18 1997-09-20 1997-09-22 1997-09-24 1997-09-26 1997-09-28 1997-09-30",
    },
    Case {
        rule: "FREQ=DAILY;INTERVAL=10;COUNT=5",
        start: "1997-09-02T09:00",
        take: 0,
        expect: "1997-09-02 1997-09-12 1997-09-22 1997-10-02 1997-10-12",
    },
    Case {
        rule: "FREQ=WEEKLY;COUNT=10",
        start: "1997-09-02T09:00",
        take: 0,
        expect: "1997-09-02 1997-09-09 1997-09-16 1997-09-23 1997-09-30 1997-10-07 1997-10-14 1997-10-21 \
        1997-10-28 1997-11-04",
    },
    Case {
        rule: "FREQ=WEEKLY;INTERVAL=2;WKST=SU",
        start: "1997-09-02T09:00",
        take: 10,
        expect: "1997-09-02 1997-09-16 1997-09-30 1997-10-14 1997-10-28 1997-11-11 1997-11-25 1997-12-09 \
        1997-12-23 1998-01-06",
    },
    Case {
        rule: "FREQ=WEEKLY;COUNT=10;WKST=SU;BYDAY=TU,TH",
        start: "1997-09-02T09:00",
        take: 0,
        expect: "1997-09-02 1997-09-04 1997-09-09 1997-09-11 1997-09-16 1997-09-18 1997-09-23 1997-09-25 \
        1997-09-30 1997-10-02",
    },
    Case {
        rule: "FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR",
        start: "1997-09-01T09:00",
        take: 0,
        expect: "1997-09-01 1997-09-03 1997-09-05 1997-09-15 1997-09-17 1997-09-19 1997-09-29 1997-10-01 \
        1997-10-03 1997-10-13 1997-10-15 1997-10-17 1997-10-27 1997-10-29 1997-10-31 1997-11-10 \
        1997-11-12 1997-11-14 1997-11-24 1997-11-26 1997-11-28 1997-12-08 1997-12-10 1997-12-12 \
        1997-12-22",
    },
    Case {
        rule: "FREQ=WEEKLY;INTERVAL=2;COUNT=8;WKST=SU;BYDAY=TU,TH",
        start: "1997-09-02T09:00",
        take: 0,
        expect: "1997-09-02 1997-09-04 1997-09-16 1997-09-18 1997-09-30 1997-10-02 1997-10-14 1997-10-16",
    },
    Case {
        rule: "FREQ=MONTHLY;COUNT=10;BYDAY=1FR",
        start: "1997-09-05T09:00",
        take: 0,
        expect: "1997-09-05 1997-10-03 1997-11-07 1997-12-05 1998-01-02 1998-02-06 1998-03-06 1998-04-03 \
        1998-05-01 1998-06-05",
    },
    Case {
        rule: "FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU",
        start: "1997-09-07T09:00",
        take: 0,
        expect: "1997-09-07 1997-09-28 1997-11-02 1997-11-30 1998-01-04 1998-01-25 1998-03-01 1998-03-29 \
        1998-05-03 1998-05-31",
    },
    Case {
        rule: "FREQ=MONTHLY;COUNT=6;BYDAY=-2MO",
        start: "1997-09-22T09:00",
        take: 0,
        expect: "1997-09-22 1997-10-20 1997-11-17 1997-12-22 1998-01-19 1998-02-16",
    },
    Case {
        rule: "FREQ=MONTHLY;BYMONTHDAY=-3",
        start: "1997-09-28T09:00",
        take: 8,
        expect: "1997-09-28 1997-10-29 1997-11-28 1997-12-29 1998-01-29 1998-02-26 1998-03-29 1998-04-28",
    },
    Case {
        rule: "FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15",
        start: "1997-09-02T09:00",
        take: 0,
        expect: "1997-09-02 1997-09-15 1997-10-02 1997-10-15 1997-11-02 1997-11-15 1997-12-02 1997-12-15 \
        1998-01-02 1998-01-15",
    },
    Case {
        rule: "FREQ=MONTHLY;COUNT=10;BYMONTHDAY=1,-1",
        start: "1997-09-30T09:00",
        take: 0,
        expect: "1997-09-30 1997-10-01 1997-10-31 1997-11-01 1997-11-30 1997-12-01 1997-12-31 1998-01-01 \
        1998-01-31 1998-02-01",
    },
    Case {
        rule: "FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15",
        start: "1997-09-10T09:00",
        take: 0,
        expect: "1997-09-10 1997-09-11 1997-09-12 1997-09-13 1997-09-14 1997-09-15 1999-03-10 1999-03-11 \
        1999-03-12 1999-03-13",
    },
    Case {
        rule: "FREQ=MONTHLY;INTERVAL=2;BYDAY=TU",
        start: "1997-09-02T09:00",
        take: 14,
        expect: "1997-09-02 1997-09-09 1997-09-16 1997-09-23 1997-09-30 1997-11-04 1997-11-11 1997-11-18 \
        1997-11-25 1998-01-06 1998-01-13 1998-01-20 1998-01-27 1998-03-03",
    },
    Case {
        rule: "FREQ=YEARLY;COUNT=10;BYMONTH=6,7",
        start: "1997-06-10T09:00",
        take: 0,
        expect: "1997-06-10 1997-07-10 1998-06-10 1998-07-10 1999-06-10 1999-07-10 2000-06-10 2000-07-10 \
        2001-06-10 2001-07-10",
    },
    Case {
        rule: "FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3",
        start: "1997-03-10T09:00",
        take: 0,
        expect: "1997-03-10 1999-01-10 1999-02-10 1999-03-10 2001-01-10 2001-02-10 2001-03-10 2003-01-10 \
        2003-02-10 2003-03-10",
    },
    Case {
        rule: "FREQ=YEARLY;INTERVAL=3;COUNT=10;BYYEARDAY=1,100,200",
        start: "1997-01-01T09:00",
        take: 0,
        expect: "1997-01-01 1997-04-10 1997-07-19 2000-01-01 2000-04-09 2000-07-18 2003-01-01 2003-04-10 \
        2003-07-19 2006-01-01",
    },
    Case {
        rule: "FREQ=YEARLY;BYDAY=20MO",
        start: "1997-05-19T09:00",
        take: 3,
        expect: "1997-05-19 1998-05-18 1999-05-17",
    },
    Case {
        rule: "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO",
        start: "1997-05-12T09:00",
        take: 3,
        expect: "1997-05-12 1998-05-11 1999-05-17",
    },
    Case {
        rule: "FREQ=YEARLY;BYMONTH=3;BYDAY=TH",
        start: "1997-03-13T09:00",
        take: 11,
        expect: "1997-03-13 1997-03-20 1997-03-27 1998-03-05 1998-03-12 1998-03-19 1998-03-26 1999-03-04 \
        1999-03-11 1999-03-18 1999-03-25",
    },
    Case {
        rule: "FREQ=YEARLY;BYDAY=TH;BYMONTH=6,7,8",
        start: "1997-06-05T09:00",
        take: 22,
        expect: "1997-06-05 1997-06-12 1997-06-19 1997-06-26 1997-07-03 1997-07-10 1997-07-17 1997-07-24 \
        1997-07-31 1997-08-07 1997-08-14 1997-08-21 1997-08-28 1998-06-04 1998-06-11 1998-06-18 \
        1998-06-25 1998-07-02 1998-07-09 1998-07-16 1998-07-23 1998-07-30",
    },
    Case {
        rule: "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13",
        start: "1997-09-02T09:00",
        take: 5,
        expect: "1998-02-13 1998-03-13 1998-11-13 1999-08-13 2000-10-13",
    },
    Case {
        rule: "FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13",
        start: "1997-09-13T09:00",
        take: 10,
        expect: "1997-09-13 1997-10-11 1997-11-08 1997-12-13 1998-01-10 1998-02-07 1998-03-07 1998-04-11 \
        1998-05-09 1998-06-13",
    },
    Case {
        rule: "FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8",
        start: "1996-11-05T09:00",
        take: 3,
        expect: "1996-11-05 2000-11-07 2004-11-02",
    },
    Case {
        rule: "FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3",
        start: "1997-09-04T09:00",
        take: 0,
        expect: "1997-09-04 1997-10-07 1997-11-06",
    },
    Case {
        rule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2",
        start: "1997-09-29T09:00",
        take: 6,
        expect: "1997-09-29 1997-10-30 1997-11-27 1997-12-30 1998-01-29 1998-02-26",
    },
    Case {
        rule: "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO",
        start: "1997-08-05T09:00",
        take: 0,
        expect: "1997-08-05 1997-08-10 1997-08-19 1997-08-24",
    },
    Case {
        rule: "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU",
        start: "1997-08-05T09:00",
        take: 0,
        expect: "1997-08-05 1997-08-17 1997-08-19 1997-08-31",
    },
    Case {
        rule: "FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5",
        start: "2007-01-15T09:00",
        take: 0,
        expect: "2007-01-15 2007-01-30 2007-02-15 2007-03-15 2007-03-30",
    },
];

#[test]
fn every_rfc_5545_example_expands_to_the_rfcs_list() {
    for case in RFC_5545 {
        let want = words(case.expect);
        let cap = if case.take > 0 { case.take } else { 500 };
        let found = expand_zoned(
            case.rule,
            case.start,
            "America/New_York",
            "2013-01-01T00:00:00.000Z",
            cap,
        );
        assert_eq!(
            dates(&found),
            want,
            "{} from {}: the RFC's list",
            case.rule,
            case.start
        );
        let time_of_day = &case.start[10..];
        for occurrence in &found {
            assert_eq!(
                &occurrence.wall_start[10..],
                format!("{time_of_day}:00"),
                "{}: the wall clock is the anchor's through every DST change",
                case.rule
            );
        }
    }
    assert!(RFC_5545.len() >= 31, "the table is the RFC's, not a sample");
}

/// The RFC examples that end on a UNTIL, which is INCLUSIVE and read as the UTC
/// instant it says: 1997-12-24T00:00:00Z is the evening of the 23rd in New York.
#[test]
fn the_rfc_examples_with_an_until_end_where_the_rfc_says() {
    let new_york = "America/New_York";
    let far = "2013-01-01T00:00:00.000Z";

    // Daily until December 24, 1997.
    let daily = expand_zoned(
        "FREQ=DAILY;UNTIL=19971224T000000Z",
        "1997-09-02T09:00",
        new_york,
        far,
        500,
    );
    assert_eq!(daily.len(), 113);
    assert_eq!(daily[0].wall_start, "1997-09-02T09:00:00");
    assert_eq!(daily[0].start, "1997-09-02T13:00:00.000Z", "EDT");
    assert_eq!(daily[112].wall_start, "1997-12-23T09:00:00");
    assert_eq!(
        daily[112].start, "1997-12-23T14:00:00.000Z",
        "EST: the clock held"
    );

    // Every day in January, for 3 years: both spellings in the RFC.
    for rule in [
        "FREQ=YEARLY;UNTIL=20000131T140000Z;BYMONTH=1;BYDAY=SU,MO,TU,WE,TH,FR,SA",
        "FREQ=DAILY;UNTIL=20000131T140000Z;BYMONTH=1",
    ] {
        let january = expand_zoned(rule, "1998-01-01T09:00", new_york, far, 500);
        assert_eq!(january.len(), 93, "{rule}");
        assert_eq!(january[0].wall_start, "1998-01-01T09:00:00");
        assert_eq!(
            january[92].wall_start, "2000-01-31T09:00:00",
            "{rule}: 14:00Z is 09:00 EST, and UNTIL is inclusive"
        );
        assert!(
            january.iter().all(|day| day.wall_start[5..7] == *"01"),
            "{rule}"
        );
    }

    // Weekly until December 24, 1997.
    let weekly = expand_zoned(
        "FREQ=WEEKLY;UNTIL=19971224T000000Z",
        "1997-09-02T09:00",
        new_york,
        far,
        500,
    );
    assert_eq!(weekly.len(), 17);
    assert_eq!(weekly[16].wall_start, "1997-12-23T09:00:00");

    // Weekly on Tuesday and Thursday for five weeks, UNTIL form.
    let five_weeks = expand_zoned(
        "FREQ=WEEKLY;UNTIL=19971007T000000Z;WKST=SU;BYDAY=TU,TH",
        "1997-09-02T09:00",
        new_york,
        far,
        500,
    );
    assert_eq!(
        dates(&five_weeks),
        words("1997-09-02 09-04 09-09 09-11 09-16 09-18 09-23 09-25 09-30 10-02")
            .iter()
            .map(|day| if day.len() == 10 {
                (*day).to_owned()
            } else {
                format!("1997-{day}")
            })
            .collect::<Vec<_>>()
    );

    // Monthly on the first Friday until December 24, 1997.
    let first_fridays = expand_zoned(
        "FREQ=MONTHLY;UNTIL=19971224T000000Z;BYDAY=1FR",
        "1997-09-05T09:00",
        new_york,
        far,
        500,
    );
    assert_eq!(
        dates(&first_fridays),
        ["1997-09-05", "1997-10-03", "1997-11-07", "1997-12-05"]
    );
}

// ---------------------------------------------------------------------------
// Part tables
// ---------------------------------------------------------------------------

struct Edge {
    name: &'static str,
    rule: &'static str,
    /// A 09:00 wall clock.
    start: &'static str,
    /// The series is read until the end of the year before this one.
    before_year: i64,
    expect: &'static str,
}

/// One row per part and combination. `python-dateutil` agreed on every row
/// when it was written, EXCEPT where noted in the tests that pin the two
/// departures (the implied day clamps; `BYWEEKNO` alone takes the anchor's weekday).
const EDGES: &[Edge] = &[
    Edge {
        name: "the 31st skips the short months",
        rule: "FREQ=MONTHLY;BYMONTHDAY=31",
        start: "2026-01-31T09:00",
        before_year: 2027,
        expect: "2026-01-31 2026-03-31 2026-05-31 2026-07-31 2026-08-31 2026-10-31 2026-12-31",
    },
    Edge {
        name: "the last day is the 28th to the 31st",
        rule: "FREQ=MONTHLY;BYMONTHDAY=-1",
        start: "2026-01-31T09:00",
        before_year: 2027,
        expect: "2026-01-31 2026-02-28 2026-03-31 2026-04-30 2026-05-31 2026-06-30 2026-07-31 2026-08-31 \
        2026-09-30 2026-10-31 2026-11-30 2026-12-31",
    },
    Edge {
        name: "the 29th skips February except in a leap year",
        rule: "FREQ=MONTHLY;BYMONTHDAY=29",
        start: "2027-01-29T09:00",
        before_year: 2029,
        expect: "2027-01-29 2027-03-29 2027-04-29 2027-05-29 2027-06-29 2027-07-29 2027-08-29 2027-09-29 \
        2027-10-29 2027-11-29 2027-12-29 2028-01-29 2028-02-29 2028-03-29 2028-04-29 2028-05-29 \
        2028-06-29 2028-07-29 2028-08-29 2028-09-29 2028-10-29 2028-11-29 2028-12-29",
    },
    Edge {
        name: "Feb 29 is a leap-year rule",
        rule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
        start: "2024-02-29T09:00",
        before_year: 2037,
        expect: "2024-02-29 2028-02-29 2032-02-29 2036-02-29",
    },
    Edge {
        name: "the 30th across February",
        rule: "FREQ=MONTHLY;BYMONTHDAY=30",
        start: "2026-01-30T09:00",
        before_year: 2027,
        expect: "2026-01-30 2026-03-30 2026-04-30 2026-05-30 2026-06-30 2026-07-30 2026-08-30 2026-09-30 \
        2026-10-30 2026-11-30 2026-12-30",
    },
    Edge {
        name: "29, 30 and 31 across February",
        rule: "FREQ=MONTHLY;BYMONTHDAY=29,30,31",
        start: "2026-01-29T09:00",
        before_year: 2027,
        expect: "2026-01-29 2026-01-30 2026-01-31 2026-03-29 2026-03-30 2026-03-31 2026-04-29 2026-04-30 \
        2026-05-29 2026-05-30 2026-05-31 2026-06-29 2026-06-30 2026-07-29 2026-07-30 2026-07-31 \
        2026-08-29 2026-08-30 2026-08-31 2026-09-29 2026-09-30 2026-10-29 2026-10-30 2026-10-31 \
        2026-11-29 2026-11-30 2026-12-29 2026-12-30 2026-12-31",
    },
    Edge {
        name: "the 31st from the end is the 1st of 31-day months",
        rule: "FREQ=MONTHLY;BYMONTHDAY=-31",
        start: "2026-01-01T09:00",
        before_year: 2027,
        expect: "2026-01-01 2026-03-01 2026-05-01 2026-07-01 2026-08-01 2026-10-01 2026-12-01",
    },
    Edge {
        name: "day 366 is a leap-year rule",
        rule: "FREQ=YEARLY;BYYEARDAY=366",
        start: "2024-12-31T09:00",
        before_year: 2041,
        expect: "2024-12-31 2028-12-31 2032-12-31 2036-12-31 2040-12-31",
    },
    Edge {
        name: "day -1 is Dec 31",
        rule: "FREQ=YEARLY;BYYEARDAY=-1",
        start: "2026-12-31T09:00",
        before_year: 2030,
        expect: "2026-12-31 2027-12-31 2028-12-31 2029-12-31",
    },
    Edge {
        name: "day 60 is Feb 29 or Mar 1",
        rule: "FREQ=YEARLY;BYYEARDAY=60",
        start: "2026-03-01T09:00",
        before_year: 2031,
        expect: "2026-03-01 2027-03-01 2028-02-29 2029-03-01 2030-03-01",
    },
    Edge {
        name: "week 53 exists in some years only",
        rule: "FREQ=YEARLY;BYWEEKNO=53;BYDAY=MO",
        start: "2020-12-28T09:00",
        before_year: 2041,
        expect: "2020-12-28 2026-12-28 2032-12-27 2037-12-28",
    },
    Edge {
        name: "week 53 under a Sunday week start",
        rule: "FREQ=YEARLY;BYWEEKNO=53;BYDAY=SU;WKST=SU",
        start: "2020-12-27T09:00",
        before_year: 2041,
        expect: "2020-12-27 2025-12-28 2031-12-28 2036-12-28",
    },
    Edge {
        name: "week 1 starts in the previous December",
        rule: "FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO",
        start: "2025-12-29T09:00",
        before_year: 2033,
        expect: "2025-12-29 2027-01-04 2028-01-03 2029-01-01 2029-12-31 2030-12-30 2031-12-29",
    },
    Edge {
        name: "the last week of the year",
        rule: "FREQ=YEARLY;BYWEEKNO=-1;BYDAY=SU",
        start: "2025-12-28T09:00",
        before_year: 2033,
        expect: "2025-12-28 2027-01-03 2028-01-02 2028-12-31 2029-12-30 2030-12-29 2031-12-28",
    },
    Edge {
        name: "weeks 52 and 53 under WKST=SU",
        rule: "FREQ=YEARLY;BYWEEKNO=52,53;BYDAY=SU;WKST=SU",
        start: "2020-12-27T09:00",
        before_year: 2029,
        expect: "2020-12-27 2021-12-26 2022-12-25 2023-12-24 2024-12-22 2025-12-21 2025-12-28 2026-12-27 \
        2027-12-26 2028-12-24",
    },
    Edge {
        name: "a fortnight of Monday and Sunday, week starting Monday",
        rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;COUNT=6;WKST=MO",
        start: "2026-03-01T09:00",
        before_year: 2031,
        expect: "2026-03-01 2026-03-09 2026-03-15 2026-03-23 2026-03-29 2026-04-06",
    },
    Edge {
        name: "a fortnight of Monday and Sunday, week starting Sunday",
        rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;COUNT=6;WKST=SU",
        start: "2026-03-01T09:00",
        before_year: 2031,
        expect: "2026-03-01 2026-03-02 2026-03-15 2026-03-16 2026-03-29 2026-03-30",
    },
    Edge {
        name: "a fortnight of Monday and Sunday, week starting Wednesday",
        rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;COUNT=6;WKST=WE",
        start: "2026-03-01T09:00",
        before_year: 2031,
        expect: "2026-03-01 2026-03-02 2026-03-15 2026-03-16 2026-03-29 2026-03-30",
    },
    Edge {
        name: "every third week on FR SA SU, week starting Saturday",
        rule: "FREQ=WEEKLY;INTERVAL=3;BYDAY=FR,SA,SU;COUNT=7;WKST=SA",
        start: "2026-03-06T09:00",
        before_year: 2031,
        expect: "2026-03-06 2026-03-21 2026-03-22 2026-03-27 2026-04-11 2026-04-12 2026-04-17",
    },
    Edge {
        name: "the last weekday of the month",
        rule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        start: "2026-01-30T09:00",
        before_year: 2027,
        expect: "2026-01-30 2026-02-27 2026-03-31 2026-04-30 2026-05-29 2026-06-30 2026-07-31 2026-08-31 \
        2026-09-30 2026-10-30 2026-11-30 2026-12-31",
    },
    Edge {
        name: "the last Friday via BYSETPOS",
        rule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
        start: "2026-01-30T09:00",
        before_year: 2027,
        expect: "2026-01-30 2026-02-27 2026-03-27 2026-04-24 2026-05-29 2026-06-26 2026-07-31 2026-08-28 \
        2026-09-25 2026-10-30 2026-11-27 2026-12-25",
    },
    Edge {
        name: "first and last weekday of the month",
        rule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1,-1",
        start: "2026-01-01T09:00",
        before_year: 2027,
        expect: "2026-01-01 2026-01-30 2026-02-02 2026-02-27 2026-03-02 2026-03-31 2026-04-01 2026-04-30 \
        2026-05-01 2026-05-29 2026-06-01 2026-06-30 2026-07-01 2026-07-31 2026-08-03 2026-08-31 \
        2026-09-01 2026-09-30 2026-10-01 2026-10-30 2026-11-02 2026-11-30 2026-12-01 2026-12-31",
    },
    Edge {
        name: "the last Monday among January to March",
        rule: "FREQ=YEARLY;BYMONTH=1,2,3;BYDAY=MO;BYSETPOS=-1",
        start: "2026-03-30T09:00",
        before_year: 2030,
        expect: "2026-03-30 2027-03-29 2028-03-27 2029-03-26",
    },
    Edge {
        name: "the last of Monday Wednesday Friday each week",
        rule: "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYSETPOS=-1",
        start: "2026-03-02T09:00",
        before_year: 2027,
        expect: "2026-03-06 2026-03-13 2026-03-20 2026-03-27 2026-04-03 2026-04-10 2026-04-17 2026-04-24 \
        2026-05-01 2026-05-08 2026-05-15 2026-05-22 2026-05-29 2026-06-05 2026-06-12 2026-06-19 \
        2026-06-26 2026-07-03 2026-07-10 2026-07-17 2026-07-24 2026-07-31 2026-08-07 2026-08-14 \
        2026-08-21 2026-08-28 2026-09-04 2026-09-11 2026-09-18 2026-09-25 2026-10-02 2026-10-09 \
        2026-10-16 2026-10-23 2026-10-30 2026-11-06 2026-11-13 2026-11-20 2026-11-27 2026-12-04 \
        2026-12-11 2026-12-18 2026-12-25",
    },
    Edge {
        name: "the second of the 1st, 15th and last day",
        rule: "FREQ=MONTHLY;BYMONTHDAY=1,15,-1;BYSETPOS=2",
        start: "2026-01-15T09:00",
        before_year: 2027,
        expect: "2026-01-15 2026-02-15 2026-03-15 2026-04-15 2026-05-15 2026-06-15 2026-07-15 2026-08-15 \
        2026-09-15 2026-10-15 2026-11-15 2026-12-15",
    },
    Edge {
        name: "the first weekend day of each year",
        rule: "FREQ=YEARLY;BYDAY=SA,SU;BYSETPOS=1",
        start: "2026-01-03T09:00",
        before_year: 2031,
        expect: "2026-01-03 2027-01-02 2028-01-01 2029-01-06 2030-01-05",
    },
    Edge {
        name: "every other month, the second Monday via BYSETPOS",
        rule: "FREQ=MONTHLY;INTERVAL=2;BYDAY=MO;BYSETPOS=2",
        start: "2026-01-12T09:00",
        before_year: 2027,
        expect: "2026-01-12 2026-03-09 2026-05-11 2026-07-13 2026-09-14 2026-11-09",
    },
    Edge {
        name: "every third month on the last Friday",
        rule: "FREQ=MONTHLY;INTERVAL=3;BYDAY=-1FR",
        start: "2026-01-30T09:00",
        before_year: 2028,
        expect: "2026-01-30 2026-04-24 2026-07-31 2026-10-30 2027-01-29 2027-04-30 2027-07-30 2027-10-29",
    },
    Edge {
        name: "every other year on Feb 29",
        rule: "FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=29",
        start: "2024-02-29T09:00",
        before_year: 2035,
        expect: "2024-02-29 2028-02-29 2032-02-29",
    },
    Edge {
        name: "the last Friday of the year",
        rule: "FREQ=YEARLY;BYDAY=-1FR",
        start: "2026-12-25T09:00",
        before_year: 2031,
        expect: "2026-12-25 2027-12-31 2028-12-29 2029-12-28 2030-12-27",
    },
    Edge {
        name: "the 53rd Friday of the year",
        rule: "FREQ=YEARLY;BYDAY=53FR",
        start: "2021-12-31T09:00",
        before_year: 2035,
        expect: "2021-12-31 2027-12-31 2032-12-31",
    },
    Edge {
        name: "US Thanksgiving",
        rule: "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
        start: "2026-11-26T09:00",
        before_year: 2031,
        expect: "2026-11-26 2027-11-25 2028-11-23 2029-11-22 2030-11-28",
    },
    Edge {
        name: "weekdays",
        rule: "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=10",
        start: "2026-03-06T09:00",
        before_year: 2031,
        expect: "2026-03-06 2026-03-09 2026-03-10 2026-03-11 2026-03-12 2026-03-13 2026-03-16 2026-03-17 \
        2026-03-18 2026-03-19",
    },
    Edge {
        name: "daily in February on the 28th and 29th",
        rule: "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=28,29",
        start: "2026-02-01T09:00",
        before_year: 2030,
        expect: "2026-02-28 2027-02-28 2028-02-28 2028-02-29 2029-02-28",
    },
    Edge {
        name: "daily on the 31st",
        rule: "FREQ=DAILY;BYMONTHDAY=31;COUNT=5",
        start: "2026-01-01T09:00",
        before_year: 2031,
        expect: "2026-01-31 2026-03-31 2026-05-31 2026-07-31 2026-08-31",
    },
    Edge {
        name: "weekly Mondays in June and July",
        rule: "FREQ=WEEKLY;BYDAY=MO;BYMONTH=6,7",
        start: "2026-06-01T09:00",
        before_year: 2027,
        expect: "2026-06-01 2026-06-08 2026-06-15 2026-06-22 2026-06-29 2026-07-06 2026-07-13 2026-07-20 \
        2026-07-27",
    },
    Edge {
        name: "the anchor does not match: count starts at the first match",
        rule: "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13;COUNT=3",
        start: "2026-01-01T09:00",
        before_year: 2031,
        expect: "2026-02-13 2026-03-13 2026-11-13",
    },
    Edge {
        name: "yearly on a BYMONTHDAY alone is every month",
        rule: "FREQ=YEARLY;BYMONTHDAY=1;COUNT=14",
        start: "2026-01-01T09:00",
        before_year: 2031,
        expect: "2026-01-01 2026-02-01 2026-03-01 2026-04-01 2026-05-01 2026-06-01 2026-07-01 2026-08-01 \
        2026-09-01 2026-10-01 2026-11-01 2026-12-01 2027-01-01 2027-02-01",
    },
    Edge {
        name: "yearly on the 1st and 15th of two months",
        rule: "FREQ=YEARLY;BYMONTH=3,9;BYMONTHDAY=1,15",
        start: "2026-03-01T09:00",
        before_year: 2028,
        expect: "2026-03-01 2026-03-15 2026-09-01 2026-09-15 2027-03-01 2027-03-15 2027-09-01 2027-09-15",
    },
    Edge {
        name: "monthly every Monday of the month",
        rule: "FREQ=MONTHLY;BYDAY=MO",
        start: "2026-03-02T09:00",
        before_year: 2027,
        expect: "2026-03-02 2026-03-09 2026-03-16 2026-03-23 2026-03-30 2026-04-06 2026-04-13 2026-04-20 \
        2026-04-27 2026-05-04 2026-05-11 2026-05-18 2026-05-25 2026-06-01 2026-06-08 2026-06-15 \
        2026-06-22 2026-06-29 2026-07-06 2026-07-13 2026-07-20 2026-07-27 2026-08-03 2026-08-10 \
        2026-08-17 2026-08-24 2026-08-31 2026-09-07 2026-09-14 2026-09-21 2026-09-28 2026-10-05 \
        2026-10-12 2026-10-19 2026-10-26 2026-11-02 2026-11-09 2026-11-16 2026-11-23 2026-11-30 \
        2026-12-07 2026-12-14 2026-12-21 2026-12-28",
    },
    Edge {
        name: "monthly every Monday, every third month",
        rule: "FREQ=MONTHLY;INTERVAL=3;BYDAY=MO;COUNT=9",
        start: "2026-03-02T09:00",
        before_year: 2031,
        expect: "2026-03-02 2026-03-09 2026-03-16 2026-03-23 2026-03-30 2026-06-01 2026-06-08 2026-06-15 \
        2026-06-22",
    },
    Edge {
        name: "monthly the first and the last Friday",
        rule: "FREQ=MONTHLY;BYDAY=1FR,-1FR",
        start: "2026-01-02T09:00",
        before_year: 2027,
        expect: "2026-01-02 2026-01-30 2026-02-06 2026-02-27 2026-03-06 2026-03-27 2026-04-03 2026-04-24 \
        2026-05-01 2026-05-29 2026-06-05 2026-06-26 2026-07-03 2026-07-31 2026-08-07 2026-08-28 \
        2026-09-04 2026-09-25 2026-10-02 2026-10-30 2026-11-06 2026-11-27 2026-12-04 2026-12-25",
    },
    Edge {
        name: "monthly on the 5th Monday skips months without one",
        rule: "FREQ=MONTHLY;BYDAY=5MO",
        start: "2026-03-30T09:00",
        before_year: 2028,
        expect: "2026-03-30 2026-06-29 2026-08-31 2026-11-30 2027-03-29 2027-05-31 2027-08-30 2027-11-29",
    },
    Edge {
        name: "monthly on the 5th from the end",
        rule: "FREQ=MONTHLY;BYDAY=-5MO",
        start: "2026-03-02T09:00",
        before_year: 2028,
        expect: "2026-03-02 2026-06-01 2026-08-03 2026-11-02 2027-03-01 2027-05-03 2027-08-02 2027-11-01",
    },
    Edge {
        name: "yearly in March on the 2nd and last Sunday",
        rule: "FREQ=YEARLY;BYMONTH=3;BYDAY=2SU,-1SU",
        start: "2026-03-08T09:00",
        before_year: 2030,
        expect: "2026-03-08 2026-03-29 2027-03-14 2027-03-28 2028-03-12 2028-03-26 2029-03-11 2029-03-25",
    },
    Edge {
        name: "weekly rule limited to January",
        rule: "FREQ=WEEKLY;BYMONTH=1",
        start: "2026-01-05T09:00",
        before_year: 2027,
        expect: "2026-01-05 2026-01-12 2026-01-19 2026-01-26",
    },
    Edge {
        name: "a Friday the 13th",
        rule: "FREQ=MONTHLY;BYMONTHDAY=13;BYDAY=FR",
        start: "2026-01-01T09:00",
        before_year: 2031,
        expect: "2026-02-13 2026-03-13 2026-11-13 2027-08-13 2028-10-13 2029-04-13 2029-07-13 2030-09-13 \
        2030-12-13",
    },
    Edge {
        name: "Feb 29 on a Monday is decades apart",
        rule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO",
        start: "2026-01-01T09:00",
        before_year: 2131,
        expect: "2044-02-29 2072-02-29 2112-02-29",
    },
    Edge {
        name: "the second Monday of every other month by BYDAY",
        rule: "FREQ=MONTHLY;INTERVAL=2;BYDAY=2MO",
        start: "2026-01-12T09:00",
        before_year: 2029,
        expect: "2026-01-12 2026-03-09 2026-05-11 2026-07-13 2026-09-14 2026-11-09 2027-01-11 2027-03-08 \
        2027-05-10 2027-07-12 2027-09-13 2027-11-08 2028-01-10 2028-03-13 2028-05-08 2028-07-10 \
        2028-09-11 2028-11-13",
    },
];

fn expand_edge(edge: &Edge, tz: &str) -> Vec<String> {
    let to = format!("{}-01-03T00:00:00.000Z", edge.before_year);
    let found = expand_zoned(edge.rule, edge.start, tz, &to, 10_000);
    let year_limit = format!("{:04}", edge.before_year);
    for occurrence in &found {
        assert!(
            occurrence.wall_start.ends_with("T09:00:00"),
            "{}: {} keeps the anchor's 09:00",
            edge.name,
            occurrence.wall_start
        );
    }
    dates(&found)
        .into_iter()
        .filter(|day| day[..4] < *year_limit)
        .collect()
}

#[test]
fn every_part_and_combination_expands_to_its_frozen_list() {
    for edge in EDGES {
        let want: Vec<String> = words(edge.expect)
            .iter()
            .map(|day| (*day).to_owned())
            .collect();
        // The same civil days whichever zone the 09:00 is in: a rule is
        // day arithmetic and the zone only resolves the instant.
        for tz in ["Etc/UTC", "Australia/Sydney", "America/Los_Angeles"] {
            assert_eq!(
                expand_edge(edge, tz),
                want,
                "{} ({}) in {tz}",
                edge.name,
                edge.rule
            );
        }
    }
    assert!(EDGES.len() >= 49);
}

/// A window far past the anchor lands on the same days as a walk from it: the
/// fast-forward is an optimisation and may never move an occurrence.
#[test]
fn a_window_far_past_the_anchor_equals_a_walk_from_the_anchor() {
    let mut rules: Vec<(&str, &str)> = EDGES
        .iter()
        .filter(|edge| !edge.rule.contains("COUNT") && edge.before_year < 2100)
        .map(|edge| (edge.rule, edge.start))
        .collect();
    rules.extend(
        RFC_5545
            .iter()
            .filter(|case| !case.rule.contains("COUNT") && !case.rule.contains("UNTIL"))
            .map(|case| (case.rule, case.start)),
    );
    assert!(rules.len() > 30);
    for (rule, start) in rules {
        let new_york = zone("America/New_York");
        let anchor = format_iso_ms(parse_civil_ms(start, &new_york).expect("a wall clock"));
        let year: i64 = start[..4].parse().expect("a year");
        let window_from = format!("{}-02-10T00:00:00.000Z", year + 6);
        let window_to = format!("{}-06-20T00:00:00.000Z", year + 9);
        let to = format!("{}-01-01T00:00:00.000Z", year + 10);
        let walked = expand(
            &ExpandInput::new(rule, &anchor, &anchor, &to)
                .in_zone(&new_york)
                .at_most(10_000),
        );
        let windowed = expand(
            &ExpandInput::new(rule, &anchor, &window_from, &window_to)
                .in_zone(&new_york)
                .at_most(10_000),
        );
        let (from_ms, to_ms) = (
            parse_civil_ms(&window_from, &new_york).expect("instant"),
            parse_civil_ms(&window_to, &new_york).expect("instant"),
        );
        let expected: Vec<&Occurrence> = walked
            .iter()
            .filter(|occurrence| {
                let at = parse_civil_ms(&occurrence.start, &new_york).expect("instant");
                (from_ms..to_ms).contains(&at)
            })
            .collect();
        assert_eq!(
            windowed.iter().collect::<Vec<_>>(),
            expected,
            "{rule}: the window equals the walk"
        );
    }
}

// ---------------------------------------------------------------------------
// The implied day, and the one place the engine departs from a plain reading
// ---------------------------------------------------------------------------

/// The day a rule takes from DTSTART because it names none SKIPS the months
/// that lack it, exactly as a day named with BYMONTHDAY does (RFC 5545 section
/// 3.3.10; owner decision on #1173). It used to CLAMP to the month's last day
/// (a rent anchored on the 31st fell on the 28th in February), which no phone
/// calendar does, so a followed calendar would have disagreed with EventKit and
/// CalendarContract. "The last day" is `BYMONTHDAY=-1`, which the editor's
/// "last" default writes for a start on the 29th to 31st. COUNT counts the
/// occurrences that exist.
#[test]
fn an_implied_day_and_a_named_day_both_skip_and_count_counts_real_occurrences() {
    let monthly = expand_zoned(
        "FREQ=MONTHLY",
        "2026-01-31T09:00",
        "Etc/UTC",
        "2026-06-01T00:00:00.000Z",
        50,
    );
    assert_eq!(
        dates(&monthly),
        ["2026-01-31", "2026-03-31", "2026-05-31"],
        "RFC 5545: February and April have no 31st"
    );
    let named = expand_zoned(
        "FREQ=MONTHLY;BYMONTHDAY=31",
        "2026-01-31T09:00",
        "Etc/UTC",
        "2026-06-01T00:00:00.000Z",
        50,
    );
    assert_eq!(dates(&named), ["2026-01-31", "2026-03-31", "2026-05-31"]);
    // Feb 29 yearly: only the leap years.
    let leap = expand_zoned(
        "FREQ=YEARLY",
        "2024-02-29T09:00",
        "Etc/UTC",
        "2029-01-01T00:00:00.000Z",
        50,
    );
    assert_eq!(dates(&leap), ["2024-02-29", "2028-02-29"]);
    // COUNT counts real occurrences only: three is three, not three months.
    let counted = expand_zoned(
        "FREQ=MONTHLY;COUNT=3",
        "2026-01-31T09:00",
        "Etc/UTC",
        "2027-01-01T00:00:00.000Z",
        50,
    );
    assert_eq!(dates(&counted), ["2026-01-31", "2026-03-31", "2026-05-31"]);
    let counted_leaps = expand_zoned(
        "FREQ=YEARLY;COUNT=3",
        "2024-02-29T09:00",
        "Etc/UTC",
        "2040-01-01T00:00:00.000Z",
        50,
    );
    assert_eq!(
        dates(&counted_leaps),
        ["2024-02-29", "2028-02-29", "2032-02-29"]
    );
    // The 30th skips only February; the 29th only a common year's.
    let thirtieth = expand_zoned(
        "FREQ=MONTHLY",
        "2026-01-30T09:00",
        "Etc/UTC",
        "2026-05-01T00:00:00.000Z",
        50,
    );
    assert_eq!(
        dates(&thirtieth),
        ["2026-01-30", "2026-03-30", "2026-04-30"]
    );
    // And a month limit keeps the implied day: Jan 31 names neither Feb nor
    // Apr, so there is nothing.
    let limited = expand_zoned(
        "FREQ=MONTHLY;BYMONTH=2,4",
        "2026-01-31T09:00",
        "Etc/UTC",
        "2027-01-01T00:00:00.000Z",
        50,
    );
    assert!(dates(&limited).is_empty(), "{:?}", dates(&limited));
    // Anchored on the 30th, the same limit lands only in April.
    let limited = expand_zoned(
        "FREQ=MONTHLY;BYMONTH=2,4",
        "2026-01-30T09:00",
        "Etc/UTC",
        "2027-01-01T00:00:00.000Z",
        50,
    );
    assert_eq!(dates(&limited), ["2026-04-30"]);
}

/// `BYWEEKNO` with no day beside it takes the anchor's weekday (RFC 5545:
/// "information not in the rule comes from DTSTART"). Anchored on Tuesday of
/// week 20, it is that Tuesday every year.
#[test]
fn a_week_number_alone_takes_the_anchors_weekday() {
    let found = expand_zoned(
        "FREQ=YEARLY;BYWEEKNO=20",
        "2026-05-12T09:00",
        "Etc/UTC",
        "2029-01-01T00:00:00.000Z",
        50,
    );
    assert_eq!(dates(&found), ["2026-05-12", "2027-05-18", "2028-05-16"]);
}

/// WKST decides which week a day belongs to, so under INTERVAL > 1 it moves
/// occurrences, and under BYWEEKNO it moves the week numbers. The default is
/// Monday, as RFC 5545 says (the engine used to assume Sunday).
#[test]
fn the_default_week_starts_on_monday() {
    let monday = expand_zoned(
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;COUNT=4",
        "2026-03-01T09:00",
        "Etc/UTC",
        "2027-01-01T00:00:00.000Z",
        50,
    );
    let explicit = expand_zoned(
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;COUNT=4;WKST=MO",
        "2026-03-01T09:00",
        "Etc/UTC",
        "2027-01-01T00:00:00.000Z",
        50,
    );
    assert_eq!(dates(&monday), dates(&explicit));
    assert_eq!(
        dates(&monday),
        ["2026-03-01", "2026-03-09", "2026-03-15", "2026-03-23"]
    );
}

// ---------------------------------------------------------------------------
// UNTIL and COUNT boundaries
// ---------------------------------------------------------------------------

fn last_day(rule: &str, wall: &str, tz: &str) -> (usize, String) {
    let found = expand_zoned(rule, wall, tz, "2027-01-01T00:00:00.000Z", 500);
    let last = found
        .last()
        .map_or_else(String::new, |occurrence| occurrence.wall_start.clone());
    (found.len(), last)
}

/// UNTIL is inclusive, in every spelling and in zones either side of Greenwich.
#[test]
fn until_is_inclusive_in_every_spelling_and_zone() {
    // (rule, zone, the last wall clock it keeps). Anchor: 09:00 on 2026-03-01.
    for (rule, tz, last) in [
        // UTC instant, series in UTC.
        (
            "FREQ=DAILY;UNTIL=20260305T090000Z",
            "Etc/UTC",
            "2026-03-05T09:00:00",
        ),
        (
            "FREQ=DAILY;UNTIL=20260305T085959Z",
            "Etc/UTC",
            "2026-03-04T09:00:00",
        ),
        // A bare date keeps the whole of its day, in the series' own zone.
        (
            "FREQ=DAILY;UNTIL=20260305",
            "Etc/UTC",
            "2026-03-05T09:00:00",
        ),
        (
            "FREQ=DAILY;UNTIL=2026-03-05",
            "America/New_York",
            "2026-03-05T09:00:00",
        ),
        (
            "FREQ=DAILY;UNTIL=20260305",
            "Australia/Sydney",
            "2026-03-05T09:00:00",
        ),
        // A floating UNTIL is the series' own wall clock.
        (
            "FREQ=DAILY;UNTIL=20260305T090000",
            "America/New_York",
            "2026-03-05T09:00:00",
        ),
        (
            "FREQ=DAILY;UNTIL=20260305T085959",
            "America/New_York",
            "2026-03-04T09:00:00",
        ),
        // A UTC UNTIL against a zoned series is an INSTANT: 09:00 EST is 14:00Z.
        (
            "FREQ=DAILY;UNTIL=20260305T140000Z",
            "America/New_York",
            "2026-03-05T09:00:00",
        ),
        (
            "FREQ=DAILY;UNTIL=20260305T135959Z",
            "America/New_York",
            "2026-03-04T09:00:00",
        ),
        // 09:00 AEDT (+11) on the 5th is 22:00Z on the 4th.
        (
            "FREQ=DAILY;UNTIL=20260304T220000Z",
            "Australia/Sydney",
            "2026-03-05T09:00:00",
        ),
        (
            "FREQ=DAILY;UNTIL=20260304T215959Z",
            "Australia/Sydney",
            "2026-03-04T09:00:00",
        ),
        // An offset spelling is an instant too.
        (
            "FREQ=DAILY;UNTIL=2026-03-05T09:00:00-05:00",
            "America/New_York",
            "2026-03-05T09:00:00",
        ),
    ] {
        let wall = "2026-03-01T09:00";
        let (count, found) = last_day(rule, wall, tz);
        assert_eq!(found, last, "{rule} in {tz}");
        let days: usize = last[8..10].parse().expect("a day");
        assert_eq!(count, days, "{rule} in {tz}: from the 1st to the last kept");
    }
}

#[test]
fn until_binds_a_floating_series_on_its_wall_clock_and_an_all_day_one_on_its_date() {
    let floating = expand(
        &ExpandInput::new(
            "FREQ=DAILY;UNTIL=20260303T090000Z",
            "2026-03-01T09:00:00",
            "2026-03-01T00:00:00",
            "2026-04-01T00:00:00",
        )
        .with_semantics(Semantics::Floating),
    );
    assert_eq!(
        floating.len(),
        3,
        "a Z on a floating series names no zone: its wall clock"
    );
    let all_day = expand(
        &ExpandInput::new(
            "FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20260312",
            "2026-03-02",
            "2026-03-01",
            "2026-04-01",
        )
        .with_semantics(Semantics::AllDay),
    );
    let days: Vec<&str> = all_day.iter().map(|day| day.start.as_str()).collect();
    assert_eq!(
        days,
        ["2026-03-02", "2026-03-05", "2026-03-09", "2026-03-12"]
    );
}

#[test]
fn count_counts_occurrences_from_the_first_match_and_never_the_months() {
    // COUNT=1 is the anchor, or the first match when the anchor is not one.
    assert_eq!(
        last_day("FREQ=DAILY;COUNT=1", "2026-03-01T09:00", "Etc/UTC").0,
        1
    );
    let (count, last) = last_day(
        "FREQ=WEEKLY;BYDAY=FR;COUNT=3",
        "2026-03-02T09:00",
        "Etc/UTC",
    );
    assert_eq!((count, last.as_str()), (3, "2026-03-20T09:00:00"));
    // The 31st: three occurrences span five months.
    let (count, last) = last_day(
        "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3",
        "2026-01-31T09:00",
        "Etc/UTC",
    );
    assert_eq!((count, last.as_str()), (3, "2026-05-31T09:00:00"));
    // COUNT is not stretched by a window: asking later never yields more.
    let later = expand_zoned(
        "FREQ=DAILY;COUNT=3",
        "2026-03-01T09:00",
        "Etc/UTC",
        "2027-01-01T00:00:00.000Z",
        50,
    );
    assert_eq!(later.len(), 3);
    let window = expand(
        &ExpandInput::new(
            "FREQ=DAILY;COUNT=3",
            "2026-03-01T09:00:00.000Z",
            "2026-03-02T00:00:00.000Z",
            "2027-01-01T00:00:00.000Z",
        )
        .in_zone(&zone("Etc/UTC")),
    );
    assert_eq!(dates(&window), ["2026-03-02", "2026-03-03"]);
    // COUNT with BYSETPOS counts the picks.
    let (count, last) = last_day(
        "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4",
        "2026-01-30T09:00",
        "Etc/UTC",
    );
    assert_eq!((count, last.as_str()), (4, "2026-04-30T09:00:00"));
}

// ---------------------------------------------------------------------------
// DST: New York, London, Sydney
// ---------------------------------------------------------------------------

/// The wall clock, the instant and the fold flag of each occurrence.
fn resolved(occurrences: &[Occurrence]) -> Vec<(String, String, bool)> {
    occurrences
        .iter()
        .map(|occurrence| {
            (
                occurrence.wall_start.clone(),
                occurrence.start.clone(),
                occurrence.overlap,
            )
        })
        .collect()
}

fn triples(rows: &[(&str, &str, bool)]) -> Vec<(String, String, bool)> {
    rows.iter()
        .map(|(wall, instant, overlap)| ((*wall).to_owned(), (*instant).to_owned(), *overlap))
        .collect()
}

#[test]
fn a_09_00_weekly_event_stays_09_00_local_across_new_yorks_spring_forward() {
    let found = expand_zoned(
        "FREQ=WEEKLY;BYDAY=MO,WE",
        "2026-03-02T09:00",
        "America/New_York",
        "2026-03-14T00:00:00.000Z",
        50,
    );
    assert_eq!(
        resolved(&found),
        triples(&[
            ("2026-03-02T09:00:00", "2026-03-02T14:00:00.000Z", false),
            ("2026-03-04T09:00:00", "2026-03-04T14:00:00.000Z", false),
            // The clocks sprang forward on Sunday the 8th: 09:00 is 13:00Z now.
            ("2026-03-09T09:00:00", "2026-03-09T13:00:00.000Z", false),
            ("2026-03-11T09:00:00", "2026-03-11T13:00:00.000Z", false),
        ])
    );
}

/// THE POLICY, stated once, and it is RFC 5545 section 3.3.5's (owner decision
/// on #1173, FLIPPED from "skip the gap": EventKit and CalendarContract both
/// move a gap time forward, and a followed calendar must expand the phone's own
/// occurrences). A wall time that does not exist (02:30 on the spring-forward
/// day) is read with the offset from before the gap and lands on 03:30 EDT,
/// and it COUNTS. A wall time that happens twice (01:30 on the fall-back day)
/// is ONE occurrence, at the EARLIER instant, flagged `overlap`. The key an
/// exception names is still the series' own wall clock (02:30).
#[test]
fn new_yorks_gap_moves_forward_and_counts_and_its_fold_occurs_once_at_the_earlier_instant() {
    let spring = expand_zoned(
        "FREQ=DAILY;COUNT=5",
        "2026-03-06T02:30",
        "America/New_York",
        "2026-04-01T00:00:00.000Z",
        50,
    );
    assert_eq!(
        resolved(&spring),
        triples(&[
            ("2026-03-06T02:30:00", "2026-03-06T07:30:00.000Z", false),
            ("2026-03-07T02:30:00", "2026-03-07T07:30:00.000Z", false),
            // 2026-03-08T02:30 does not exist: it is 03:30 EDT, 07:30Z, and counts.
            ("2026-03-08T02:30:00", "2026-03-08T07:30:00.000Z", false),
            ("2026-03-09T02:30:00", "2026-03-09T06:30:00.000Z", false),
            ("2026-03-10T02:30:00", "2026-03-10T06:30:00.000Z", false),
        ]),
        "five occurrences: the gap day is the third"
    );
    let autumn = expand_zoned(
        "FREQ=DAILY",
        "2026-10-31T01:30",
        "America/New_York",
        "2026-11-03T00:00:00.000Z",
        50,
    );
    assert_eq!(
        resolved(&autumn),
        triples(&[
            ("2026-10-31T01:30:00", "2026-10-31T05:30:00.000Z", false),
            // Twice on the 1st: 05:30Z (EDT) and 06:30Z (EST). Once, the first.
            ("2026-11-01T01:30:00", "2026-11-01T05:30:00.000Z", true),
            ("2026-11-02T01:30:00", "2026-11-02T06:30:00.000Z", false),
        ])
    );
}

#[test]
fn a_yearly_event_on_a_gap_day_moves_forward_that_year_and_counts() {
    let found = expand_zoned(
        "FREQ=YEARLY;COUNT=4",
        "2025-03-08T02:30",
        "America/New_York",
        "2030-01-01T00:00:00.000Z",
        50,
    );
    assert_eq!(
        dates(&found),
        ["2025-03-08", "2026-03-08", "2027-03-08", "2028-03-08"],
        "2026-03-08 02:30 is the gap: 03:30 EDT, and it counts"
    );
}

#[test]
fn a_month_position_in_the_gap_moves_forward_too() {
    let found = expand_zoned(
        "FREQ=MONTHLY;BYDAY=2SU",
        "2026-02-08T02:30",
        "America/New_York",
        "2026-05-01T00:00:00.000Z",
        50,
    );
    assert_eq!(
        resolved(&found),
        triples(&[
            ("2026-02-08T02:30:00", "2026-02-08T07:30:00.000Z", false),
            // The second Sunday of March is the 8th: the gap, 03:30 EDT.
            ("2026-03-08T02:30:00", "2026-03-08T07:30:00.000Z", false),
            ("2026-04-12T02:30:00", "2026-04-12T06:30:00.000Z", false),
        ])
    );
}

#[test]
fn londons_gap_and_fold_fall_on_the_last_sundays_of_march_and_october() {
    let spring = expand_zoned(
        "FREQ=WEEKLY;BYDAY=SU",
        "2026-03-22T01:30",
        "Europe/London",
        "2026-04-13T00:00:00.000Z",
        50,
    );
    assert_eq!(
        resolved(&spring),
        triples(&[
            ("2026-03-22T01:30:00", "2026-03-22T01:30:00.000Z", false),
            // 01:00 GMT jumps to 02:00 BST on 2026-03-29: 01:30 does not exist,
            // so it is 02:30 BST, which is the instant 01:30Z.
            ("2026-03-29T01:30:00", "2026-03-29T01:30:00.000Z", false),
            ("2026-04-05T01:30:00", "2026-04-05T00:30:00.000Z", false),
            ("2026-04-12T01:30:00", "2026-04-12T00:30:00.000Z", false),
        ])
    );
    let autumn = expand_zoned(
        "FREQ=WEEKLY;BYDAY=SU",
        "2026-10-18T01:30",
        "Europe/London",
        "2026-11-02T00:00:00.000Z",
        50,
    );
    assert_eq!(
        resolved(&autumn),
        triples(&[
            ("2026-10-18T01:30:00", "2026-10-18T00:30:00.000Z", false),
            // Twice on 2026-10-25: 00:30Z (BST) then 01:30Z (GMT). Once, the first.
            ("2026-10-25T01:30:00", "2026-10-25T00:30:00.000Z", true),
            ("2026-11-01T01:30:00", "2026-11-01T01:30:00.000Z", false),
        ])
    );
    let nine = expand_zoned(
        "FREQ=WEEKLY;BYDAY=SU",
        "2026-03-22T09:00",
        "Europe/London",
        "2026-04-06T00:00:00.000Z",
        50,
    );
    assert_eq!(
        resolved(&nine),
        triples(&[
            ("2026-03-22T09:00:00", "2026-03-22T09:00:00.000Z", false),
            ("2026-03-29T09:00:00", "2026-03-29T08:00:00.000Z", false),
            ("2026-04-05T09:00:00", "2026-04-05T08:00:00.000Z", false),
        ])
    );
}

/// The southern hemisphere runs the other way: Sydney's clocks go BACK on the
/// first Sunday of April (a fold, 02:00 to 03:00) and FORWARD on the first
/// Sunday of October (a gap).
#[test]
fn sydneys_fold_is_in_april_and_its_gap_in_october() {
    let autumn = expand_zoned(
        "FREQ=WEEKLY;BYDAY=SU",
        "2026-03-29T02:30",
        "Australia/Sydney",
        "2026-04-13T00:00:00.000Z",
        50,
    );
    assert_eq!(
        resolved(&autumn),
        triples(&[
            ("2026-03-29T02:30:00", "2026-03-28T15:30:00.000Z", false),
            // 02:30 happens at 15:30Z (AEDT) and 16:30Z (AEST) on 2026-04-05.
            ("2026-04-05T02:30:00", "2026-04-04T15:30:00.000Z", true),
            ("2026-04-12T02:30:00", "2026-04-11T16:30:00.000Z", false),
        ])
    );
    let spring = expand_zoned(
        "FREQ=WEEKLY;BYDAY=SU",
        "2026-09-27T02:30",
        "Australia/Sydney",
        "2026-10-12T00:00:00.000Z",
        50,
    );
    assert_eq!(
        resolved(&spring),
        triples(&[
            ("2026-09-27T02:30:00", "2026-09-26T16:30:00.000Z", false),
            // 02:00 AEST jumps to 03:00 AEDT on 2026-10-04: 02:30 does not exist,
            // so it is 03:30 AEDT, 16:30Z the day before.
            ("2026-10-04T02:30:00", "2026-10-03T16:30:00.000Z", false),
            ("2026-10-11T02:30:00", "2026-10-10T15:30:00.000Z", false),
        ])
    );
}

#[test]
fn a_sydney_morning_event_keeps_09_00_through_the_april_fold() {
    let saturdays = expand_zoned(
        "FREQ=WEEKLY;BYDAY=SA",
        "2026-03-28T09:00",
        "Australia/Sydney",
        "2026-04-12T00:00:00.000Z",
        50,
    );
    assert_eq!(
        resolved(&saturdays),
        triples(&[
            ("2026-03-28T09:00:00", "2026-03-27T22:00:00.000Z", false),
            ("2026-04-04T09:00:00", "2026-04-03T22:00:00.000Z", false),
            // AEST (+10) after the fold on the 5th: 09:00 is 23:00Z the day before.
            ("2026-04-11T09:00:00", "2026-04-10T23:00:00.000Z", false),
        ])
    );
    let month_ends = expand_zoned(
        "FREQ=MONTHLY;BYMONTHDAY=1,-1",
        "2026-03-31T09:00",
        "Australia/Sydney",
        "2026-05-02T00:00:00.000Z",
        50,
    );
    assert_eq!(
        resolved(&month_ends),
        triples(&[
            ("2026-03-31T09:00:00", "2026-03-30T22:00:00.000Z", false),
            ("2026-04-01T09:00:00", "2026-03-31T22:00:00.000Z", false),
            ("2026-04-30T09:00:00", "2026-04-29T23:00:00.000Z", false),
            ("2026-05-01T09:00:00", "2026-04-30T23:00:00.000Z", false),
        ])
    );
}

#[test]
fn a_floating_series_has_no_gap_and_no_fold() {
    let floating = expand(
        &ExpandInput::new(
            "FREQ=DAILY",
            "2026-03-06T02:30:00",
            "2026-03-06T00:00:00",
            "2026-03-11T00:00:00",
        )
        .with_semantics(Semantics::Floating),
    );
    assert_eq!(
        dates(&floating),
        [
            "2026-03-06",
            "2026-03-07",
            "2026-03-08",
            "2026-03-09",
            "2026-03-10"
        ],
        "02:30 on the 8th is a wall clock like any other when no zone reads it"
    );
}

/// UNTIL as a UTC instant, across the fall-back: 09:00 EST on 2026-11-01 is
/// 14:00Z, and a second earlier the series has ended.
#[test]
fn an_until_instant_decides_the_last_day_across_the_fall_back() {
    let kept = expand_zoned(
        "FREQ=DAILY;UNTIL=20261101T140000Z",
        "2026-10-30T09:00",
        "America/New_York",
        "2026-12-01T00:00:00.000Z",
        50,
    );
    assert_eq!(dates(&kept), ["2026-10-30", "2026-10-31", "2026-11-01"]);
    let ended = expand_zoned(
        "FREQ=DAILY;UNTIL=20261101T135959Z",
        "2026-10-30T09:00",
        "America/New_York",
        "2026-12-01T00:00:00.000Z",
        50,
    );
    assert_eq!(dates(&ended), ["2026-10-30", "2026-10-31"]);
}

// ---------------------------------------------------------------------------
// Caps and walks that end
// ---------------------------------------------------------------------------

#[test]
fn the_instance_caps_hold() {
    let five = expand_zoned(
        "FREQ=DAILY",
        "2026-03-01T09:00",
        "Etc/UTC",
        "2036-01-01T00:00:00.000Z",
        5,
    );
    assert_eq!(five.len(), 5);
    assert_eq!(five[0].wall_start, "2026-03-01T09:00:00");
    // A cap of 0 is a cap of 1, and none exceeds the absolute ceiling.
    assert_eq!(
        expand_zoned(
            "FREQ=DAILY",
            "2026-03-01T09:00",
            "Etc/UTC",
            "2036-01-01T00:00:00.000Z",
            0
        )
        .len(),
        1
    );
    let all = expand_zoned(
        "FREQ=DAILY",
        "2000-01-01T09:00",
        "Etc/UTC",
        "2100-01-01T00:00:00.000Z",
        1_000_000,
    );
    assert_eq!(all.len(), ABSOLUTE_MAX_INSTANCES);
    // The cap bounds what comes back, never what COUNT counts.
    let capped = expand_zoned(
        "FREQ=DAILY;COUNT=40",
        "2026-03-01T09:00",
        "Etc/UTC",
        "2036-01-01T00:00:00.000Z",
        10,
    );
    assert_eq!(capped.len(), 10);
    // BYSETPOS rules cap the same way.
    let setpos = expand_zoned(
        "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        "2026-01-30T09:00",
        "Etc/UTC",
        "2036-01-01T00:00:00.000Z",
        7,
    );
    assert_eq!(setpos.len(), 7);
}

/// A rule that can never land terminates with nothing, in the time a rule that
/// does would take, however far the range reaches.
#[test]
fn a_rule_that_never_lands_expands_to_nothing_and_stops() {
    for rule in [
        "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
        "FREQ=MONTHLY;BYMONTHDAY=31;BYMONTH=4,6,9,11",
        "FREQ=YEARLY;BYWEEKNO=53;BYDAY=MO;BYMONTH=6",
        "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
        "FREQ=YEARLY;BYYEARDAY=366;BYMONTH=2",
        "FREQ=MONTHLY;BYDAY=5MO;BYMONTHDAY=1",
    ] {
        let found = expand_zoned(
            rule,
            "2026-01-01T09:00",
            "Etc/UTC",
            "9000-01-01T00:00:00.000Z",
            366,
        );
        assert!(found.is_empty(), "{rule}: {found:?}");
    }
}

#[test]
fn the_last_year_of_the_calendar_ends_the_walk() {
    let found = expand_zoned(
        "FREQ=YEARLY",
        "9998-06-01T09:00",
        "Etc/UTC",
        "9999-12-31T00:00:00.000Z",
        50,
    );
    assert_eq!(dates(&found), ["9998-06-01", "9999-06-01"]);
}

// ---------------------------------------------------------------------------
// Tasks: next occurrence, completion anchors, collapsing, exceptions
// ---------------------------------------------------------------------------

#[test]
fn a_tasks_next_occurrence_follows_the_new_shapes() {
    let new_york = zone("America/New_York");
    let next = |rule: &str, start: &str, after: &str, anchor| {
        next_occurrence(&NextOccurrenceInput {
            rrule: rule,
            scheduled_start: start,
            after,
            zone: Some(&new_york),
            anchor,
        })
    };
    // The last weekday of the month, 09:00 New York.
    assert_eq!(
        next(
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
            "2026-01-30T14:00:00.000Z",
            "2026-02-01T00:00:00.000Z",
            RecurrenceAnchor::Scheduled,
        )
        .as_deref(),
        Some("2026-02-27T14:00:00.000Z")
    );
    // Strictly after: on the occurrence itself, the next one.
    assert_eq!(
        next(
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
            "2026-01-30T14:00:00.000Z",
            "2026-02-27T14:00:00.000Z",
            RecurrenceAnchor::Scheduled,
        )
        .as_deref(),
        Some("2026-03-31T13:00:00.000Z"),
        "March is EDT: the 09:00 clock held"
    );
    // A completion anchor measures from the completion, Wednesday the 4th.
    assert_eq!(
        next(
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR",
            "2026-02-02T14:00:00.000Z",
            "2026-03-04T15:00:00.000Z",
            RecurrenceAnchor::Completion,
        )
        .as_deref(),
        Some("2026-03-06T15:00:00.000Z"),
        "the Friday of the completion's own week"
    );
    // A sparse rule still answers: every 12 years, beyond the ten-year default.
    assert_eq!(
        next(
            "FREQ=YEARLY;INTERVAL=12;BYMONTH=6;BYMONTHDAY=1",
            "2026-06-01T13:00:00.000Z",
            "2026-06-02T00:00:00.000Z",
            RecurrenceAnchor::Scheduled,
        )
        .as_deref(),
        Some("2038-06-01T13:00:00.000Z")
    );
    // A rule that never lands has no next.
    assert_eq!(
        next(
            "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
            "2026-01-01T14:00:00.000Z",
            "2026-02-01T00:00:00.000Z",
            RecurrenceAnchor::Scheduled,
        ),
        None
    );
}

#[test]
fn a_bare_date_task_rolls_to_the_next_date_of_the_new_shapes() {
    let utc = zone("Etc/UTC");
    let next = |rule: &str, start: &str, after: &str| {
        next_occurrence(&NextOccurrenceInput {
            rrule: rule,
            scheduled_start: start,
            after,
            zone: Some(&utc),
            anchor: RecurrenceAnchor::Scheduled,
        })
    };
    assert_eq!(
        next("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-01-31", "2026-02-10").as_deref(),
        Some("2026-02-28")
    );
    assert_eq!(
        next(
            "FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO",
            "2025-12-29",
            "2026-01-01"
        )
        .as_deref(),
        Some("2027-01-04")
    );
    assert_eq!(
        next(
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
            "2026-01-30",
            "2026-02-27"
        )
        .as_deref(),
        Some("2026-03-31"),
        "strictly after the day"
    );
}

#[test]
fn a_repeating_task_collapses_the_periods_of_the_new_shapes() {
    let new_york = zone("America/New_York");
    let collapsed = collapse_missed(&CollapseInput {
        rrule: "FREQ=WEEKLY;BYDAY=MO,TH",
        scheduled_start: "2026-03-02T14:00:00.000Z",
        zone: Some(&new_york),
        anchor: RecurrenceAnchor::Scheduled,
        now: "2026-03-20T00:00:00.000Z",
        last_completed_at: None,
    });
    // Mon 2, Thu 5, Mon 9, Thu 12, Mon 16, Thu 19: six went by.
    assert_eq!(collapsed.missed, 6);
    assert_eq!(
        collapsed.next_due.as_deref(),
        Some("2026-03-23T13:00:00.000Z")
    );
    // A completion on the 12th covers everything up to it.
    let done = collapse_missed(&CollapseInput {
        last_completed_at: Some("2026-03-12T20:00:00.000Z"),
        ..CollapseInput {
            rrule: "FREQ=WEEKLY;BYDAY=MO,TH",
            scheduled_start: "2026-03-02T14:00:00.000Z",
            zone: Some(&new_york),
            anchor: RecurrenceAnchor::Scheduled,
            now: "2026-03-20T00:00:00.000Z",
            last_completed_at: None,
        }
    });
    assert_eq!(done.missed, 2, "Monday the 16th and Thursday the 19th");
}

/// RFC 5545 for a task too (owner decision on #1173): a plain monthly task on
/// the 31st skips the months with no 31st, a yearly one on Feb 29 skips the
/// common years, and a task's 02:30 on the spring-forward day is 03:30 EDT.
/// `next_occurrence` and `collapse_missed` are built on the same expander, so
/// they cannot disagree with it.
#[test]
fn a_tasks_next_occurrence_and_collapse_follow_the_skip_and_the_forward_gap() {
    let utc = zone("Etc/UTC");
    let new_york = zone("America/New_York");
    let next = |rule: &str, start: &str, after: &str, zone: &FireZone, anchor| {
        next_occurrence(&NextOccurrenceInput {
            rrule: rule,
            scheduled_start: start,
            after,
            zone: Some(zone),
            anchor,
        })
    };
    // A bare-date monthly task on the 31st: Jan 31, then March 31.
    assert_eq!(
        next(
            "FREQ=MONTHLY",
            "2026-01-31",
            "2026-02-01",
            &utc,
            RecurrenceAnchor::Scheduled
        )
        .as_deref(),
        Some("2026-03-31"),
        "February has no 31st: it is skipped, not the 28th"
    );
    assert_eq!(
        next(
            "FREQ=MONTHLY",
            "2026-01-31",
            "2026-03-31",
            &utc,
            RecurrenceAnchor::Scheduled
        )
        .as_deref(),
        Some("2026-05-31"),
        "April has no 31st either"
    );
    // Feb 29 yearly: the next leap day, four years on.
    assert_eq!(
        next(
            "FREQ=YEARLY",
            "2024-02-29",
            "2024-03-01",
            &utc,
            RecurrenceAnchor::Scheduled
        )
        .as_deref(),
        Some("2028-02-29")
    );
    // A timed task: the same, in its own zone (09:00 EST, then 09:00 EDT).
    assert_eq!(
        next(
            "FREQ=MONTHLY",
            "2026-01-31T14:00:00.000Z",
            "2026-02-01T00:00:00.000Z",
            &new_york,
            RecurrenceAnchor::Scheduled
        )
        .as_deref(),
        Some("2026-03-31T13:00:00.000Z")
    );
    // A completion anchor takes its implied day from the completion: done on
    // Jan 31, the next 31st is March 31.
    assert_eq!(
        next(
            "FREQ=MONTHLY",
            "2026-01-10",
            "2026-01-31",
            &utc,
            RecurrenceAnchor::Completion
        )
        .as_deref(),
        Some("2026-03-31")
    );
    // The gap: 02:30 on the 8th is 03:30 EDT, the next occurrence after the 7th.
    assert_eq!(
        next(
            "FREQ=DAILY",
            "2026-03-06T07:30:00.000Z",
            "2026-03-07T07:30:00.000Z",
            &new_york,
            RecurrenceAnchor::Scheduled
        )
        .as_deref(),
        Some("2026-03-08T07:30:00.000Z"),
        "02:30 does not exist on the 8th: 03:30 EDT, which is 07:30Z"
    );
    // Collapse: Jan 31 and Mar 31 went by (February has no 31st), and the
    // next period is May 31 (April has none).
    let collapsed = collapse_missed(&CollapseInput {
        rrule: "FREQ=MONTHLY",
        scheduled_start: "2026-01-31",
        zone: Some(&utc),
        anchor: RecurrenceAnchor::Scheduled,
        now: "2026-04-15T12:00:00.000Z",
        last_completed_at: None,
    });
    assert_eq!(collapsed.missed, 2);
    assert_eq!(collapsed.next_due.as_deref(), Some("2026-05-31"));
    // And a daily 02:30 task counts the gap day: the 6th, 7th and 8th went by.
    let collapsed = collapse_missed(&CollapseInput {
        rrule: "FREQ=DAILY",
        scheduled_start: "2026-03-06T07:30:00.000Z",
        zone: Some(&new_york),
        anchor: RecurrenceAnchor::Scheduled,
        now: "2026-03-09T00:00:00.000Z",
        last_completed_at: None,
    });
    assert_eq!(collapsed.missed, 3);
    assert_eq!(
        collapsed.next_due.as_deref(),
        Some("2026-03-09T06:30:00.000Z")
    );
}

#[test]
fn an_exception_keys_off_the_wall_clock_of_a_bysetpos_series() {
    let found = expand_zoned(
        "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        "2026-01-30T09:00",
        "America/New_York",
        "2026-05-01T00:00:00.000Z",
        50,
    );
    assert_eq!(
        dates(&found),
        ["2026-01-30", "2026-02-27", "2026-03-31", "2026-04-30"]
    );
    let after = apply_exceptions(
        &found,
        &[
            RecurrenceException {
                original_start: "2026-02-27T09:00:00".to_owned(),
                action: ExceptionAction::Skip,
                scope: ExceptionScope::Occurrence,
                start: None,
            },
            RecurrenceException {
                original_start: "2026-03-31T09:00:00".to_owned(),
                action: ExceptionAction::Override,
                scope: ExceptionScope::Occurrence,
                start: Some("2026-04-01T15:00:00.000Z".to_owned()),
            },
        ],
    );
    assert_eq!(after.len(), 3);
    assert_eq!(after[1].start, "2026-04-01T15:00:00.000Z");
    assert_eq!(
        after[1].wall_start, "2026-03-31T09:00:00",
        "the key is the unmodified original"
    );
}

#[test]
fn a_refused_rule_expands_to_nothing_whatever_the_shape() {
    for rule in [
        "FREQ=HOURLY",
        "FREQ=DAILY;BYHOUR=9",
        "FREQ=MONTHLY;BYSETPOS=1",
        "FREQ=DAILY;COUNT=2;UNTIL=20270101",
        "FREQ=WEEKLY;BYMONTHDAY=1",
        "FREQ=MONTHLY;RSCALE=HEBREW",
    ] {
        assert!(
            expand_zoned_or_empty(rule).is_empty(),
            "{rule} expands to nothing"
        );
    }
}

fn expand_zoned_or_empty(rule: &str) -> Vec<Occurrence> {
    let utc = zone("Etc/UTC");
    expand(
        &ExpandInput::new(
            rule,
            "2026-03-01T09:00:00.000Z",
            "2026-03-01T00:00:00.000Z",
            "2027-03-01T00:00:00.000Z",
        )
        .in_zone(&utc),
    )
}
