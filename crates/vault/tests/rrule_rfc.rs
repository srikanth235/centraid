//! Independent expected dates from RFC 5545 §3.8.5.3, plus the vault's zone,
//! count and bounded-expansion guarantees. The frozen v0 corpus remains intact.
use centraid_vault::time::{
    recurrence::{ExpandInput, Semantics, expand},
    zone::FireZone,
};

fn dates(rule: &str, start: &str, to: &str) -> Vec<String> {
    expand(&ExpandInput::new(rule, start, start, to).with_semantics(Semantics::AllDay))
        .into_iter()
        .map(|o| o.start)
        .collect()
}
fn clocks(rule: &str, start: &str, from: &str, to: &str, zone: &str) -> Vec<String> {
    let zone = FireZone::named(zone).expect("zone");
    expand(&ExpandInput::new(rule, start, from, to).in_zone(&zone))
        .into_iter()
        .map(|o| o.start)
        .collect()
}

#[test]
fn rfc_third_tuesday_and_second_to_last_weekday() {
    assert_eq!(
        dates(
            "FREQ=MONTHLY;BYDAY=TU,WE,TH;BYSETPOS=3;COUNT=3",
            "1997-09-04",
            "1998-01-01"
        ),
        ["1997-09-04", "1997-10-07", "1997-11-06"]
    );
    assert_eq!(
        dates(
            "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2;COUNT=3",
            "1997-09-29",
            "1998-01-01"
        ),
        ["1997-09-29", "1997-10-30", "1997-11-27"]
    );
}

#[test]
fn rfc_week_start_changes_alternating_week_candidates() {
    let prefix = "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU";
    assert_eq!(
        dates(&format!("{prefix};WKST=MO"), "1997-08-05", "1997-09-01"),
        ["1997-08-05", "1997-08-10", "1997-08-19", "1997-08-24"]
    );
    assert_eq!(
        dates(&format!("{prefix};WKST=SU"), "1997-08-05", "1997-09-01"),
        ["1997-08-05", "1997-08-17", "1997-08-19", "1997-08-31"]
    );
}

#[test]
fn rfc_us_election_day_and_twentieth_monday() {
    assert_eq!(
        dates(
            "FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8;COUNT=3",
            "1996-11-05",
            "2005-01-01"
        ),
        ["1996-11-05", "2000-11-07", "2004-11-02"]
    );
    assert_eq!(
        dates("FREQ=YEARLY;BYDAY=20MO;COUNT=3", "1997-05-19", "2000-01-01"),
        ["1997-05-19", "1998-05-18", "1999-05-17"]
    );
}

#[test]
fn year_days_and_week_numbers_obey_leap_and_week_year_boundaries() {
    assert_eq!(
        dates(
            "FREQ=YEARLY;BYYEARDAY=60,-1;COUNT=4",
            "2023-01-01",
            "2025-01-01"
        ),
        ["2023-03-01", "2023-12-31", "2024-02-29", "2024-12-31"]
    );
    assert_eq!(
        dates(
            "FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO;COUNT=4",
            "2018-01-01",
            "2022-01-01"
        ),
        ["2018-01-01", "2018-12-31", "2019-12-30", "2021-01-04"]
    );
    assert_eq!(
        dates(
            "FREQ=YEARLY;BYWEEKNO=-1;BYDAY=SU;COUNT=2",
            "2020-01-01",
            "2022-01-10"
        ),
        ["2021-01-03", "2022-01-02"]
    );
}

#[test]
fn negative_positions_lists_and_intersections_do_not_clamp_missing_dates() {
    assert_eq!(
        dates(
            "FREQ=MONTHLY;BYDAY=-2MO;COUNT=3",
            "2026-01-01",
            "2026-04-01"
        ),
        ["2026-01-19", "2026-02-16", "2026-03-23"]
    );
    assert_eq!(
        dates("FREQ=MONTHLY;BYDAY=5MO;COUNT=2", "2026-01-01", "2026-07-01"),
        ["2026-03-30", "2026-06-29"]
    );
    assert_eq!(
        dates(
            "FREQ=MONTHLY;BYMONTHDAY=1,15,-1;COUNT=6",
            "2026-01-01",
            "2026-03-01"
        ),
        [
            "2026-01-01",
            "2026-01-15",
            "2026-01-31",
            "2026-02-01",
            "2026-02-15",
            "2026-02-28"
        ]
    );
    assert_eq!(
        dates("FREQ=MONTHLY;COUNT=3", "2026-01-31", "2026-06-01"),
        ["2026-01-31", "2026-03-31", "2026-05-31"]
    );
}

#[test]
fn hourly_minutely_and_secondly_rules_keep_the_anchor_phase() {
    assert_eq!(
        clocks(
            "FREQ=MINUTELY;INTERVAL=15;COUNT=4",
            "1997-09-02T09:00:00Z",
            "1997-09-02T00:00:00Z",
            "1997-09-03T00:00:00Z",
            "Etc/UTC"
        ),
        [
            "1997-09-02T09:00:00.000Z",
            "1997-09-02T09:15:00.000Z",
            "1997-09-02T09:30:00.000Z",
            "1997-09-02T09:45:00.000Z"
        ]
    );
    assert_eq!(
        clocks(
            "FREQ=HOURLY;INTERVAL=3;BYMINUTE=15,45;COUNT=3",
            "2026-01-01T09:00:00Z",
            "2026-01-01T00:00:00Z",
            "2026-01-02T00:00:00Z",
            "Etc/UTC"
        ),
        [
            "2026-01-01T09:15:00.000Z",
            "2026-01-01T09:45:00.000Z",
            "2026-01-01T12:15:00.000Z"
        ]
    );
    assert_eq!(
        clocks(
            "FREQ=SECONDLY;INTERVAL=7;BYMINUTE=1;COUNT=3",
            "2026-01-01T09:00:00Z",
            "2026-01-01T00:00:00Z",
            "2026-01-01T10:00:00Z",
            "Etc/UTC"
        ),
        [
            "2026-01-01T09:01:03.000Z",
            "2026-01-01T09:01:10.000Z",
            "2026-01-01T09:01:17.000Z"
        ]
    );
}

#[test]
fn subdaily_gap_does_not_consume_count_and_fold_occurs_once() {
    assert_eq!(
        clocks(
            "FREQ=HOURLY;COUNT=3",
            "2026-03-08T09:30:00Z",
            "2026-03-08T09:30:00Z",
            "2026-03-09T00:00:00Z",
            "America/Los_Angeles"
        ),
        [
            "2026-03-08T09:30:00.000Z",
            "2026-03-08T10:30:00.000Z",
            "2026-03-08T11:30:00.000Z"
        ]
    );
    assert_eq!(
        clocks(
            "FREQ=HOURLY;COUNT=3",
            "2026-11-01T07:30:00Z",
            "2026-11-01T07:30:00Z",
            "2026-11-02T00:00:00Z",
            "America/Los_Angeles"
        ),
        [
            "2026-11-01T07:30:00.000Z",
            "2026-11-01T08:30:00.000Z",
            "2026-11-01T10:30:00.000Z"
        ]
    );
}

#[test]
fn a_large_set_position_does_not_materialize_every_second_of_a_year() {
    let hours = (0..24).map(|n| n.to_string()).collect::<Vec<_>>().join(",");
    let seconds = (0..60).map(|n| n.to_string()).collect::<Vec<_>>().join(",");
    let rule = format!(
        "FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR={hours};BYMINUTE={seconds};BYSECOND={seconds};BYSETPOS=-1;COUNT=1"
    );
    assert_eq!(
        clocks(
            &rule,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "2027-01-01T00:00:00Z",
            "Etc/UTC"
        ),
        ["2026-12-31T23:59:59.000Z"]
    );
}

#[test]
fn far_window_subdaily_series_preserves_count_and_zone_phase() {
    let zone = FireZone::named("America/Los_Angeles").expect("zone");
    let start = "2000-01-01T08:00:00Z";
    let from = "2026-03-09T07:00:00Z";
    let to = "2026-03-09T07:00:03Z";
    let unbounded = expand(&ExpandInput::new("FREQ=SECONDLY", start, from, to).in_zone(&zone));
    let counted =
        expand(&ExpandInput::new("FREQ=SECONDLY;COUNT=2147483647", start, from, to).in_zone(&zone));
    assert_eq!(counted, unbounded);
    assert_eq!(counted.len(), 3);
    assert_eq!(counted[0].wall_start, "2026-03-09T00:00:00");
    assert!(
        expand(&ExpandInput::new("FREQ=SECONDLY;COUNT=10", start, from, to).in_zone(&zone))
            .is_empty()
    );
}

#[test]
fn sparse_subdaily_filters_jump_days_and_preserve_set_positions() {
    let zone = FireZone::named("Etc/UTC").expect("zone");
    let rule =
        "FREQ=SECONDLY;BYMONTH=12;BYMONTHDAY=31;BYHOUR=23;BYMINUTE=59;BYSECOND=58,59;COUNT=2";
    let found = expand(
        &ExpandInput::new(
            rule,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "2027-01-01T00:00:00Z",
        )
        .in_zone(&zone)
        .at_most(2),
    );
    assert_eq!(
        found.iter().map(|o| o.start.as_str()).collect::<Vec<_>>(),
        ["2026-12-31T23:59:58.000Z", "2026-12-31T23:59:59.000Z"]
    );
}

#[test]
fn a_filtered_counted_subdaily_prefix_is_counted_by_days() {
    let zone = FireZone::named("America/Los_Angeles").expect("zone");
    let start = "2000-01-01T08:00:00Z";
    let from = "2026-03-09T16:00:00Z";
    let to = "2026-03-09T16:00:03Z";
    let counted = expand(
        &ExpandInput::new("FREQ=SECONDLY;BYHOUR=9;COUNT=2147483647", start, from, to)
            .in_zone(&zone),
    );
    let unbounded =
        expand(&ExpandInput::new("FREQ=SECONDLY;BYHOUR=9", start, from, to).in_zone(&zone));
    assert_eq!(counted, unbounded);
    assert_eq!(counted.len(), 3);
    assert_eq!(
        clocks(
            "FREQ=HOURLY;COUNT=3",
            "2026-03-08T09:30:00Z",
            "2026-03-08T11:30:00Z",
            "2026-03-09T00:00:00Z",
            "America/Los_Angeles"
        ),
        ["2026-03-08T11:30:00.000Z"]
    );
}

#[test]
fn a_dense_yearly_grid_can_start_in_a_late_window() {
    let hours = (0..24).map(|n| n.to_string()).collect::<Vec<_>>().join(",");
    let seconds = (0..60).map(|n| n.to_string()).collect::<Vec<_>>().join(",");
    let rule = format!(
        "FREQ=YEARLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR={hours};BYMINUTE={seconds};BYSECOND={seconds};COUNT=31536000"
    );
    assert_eq!(
        clocks(
            &rule,
            "2026-01-01T00:00:00Z",
            "2026-12-31T23:59:58Z",
            "2027-01-01T00:00:00Z",
            "Etc/UTC"
        ),
        ["2026-12-31T23:59:58.000Z", "2026-12-31T23:59:59.000Z"]
    );
}

#[test]
fn leap_seconds_use_the_rfc_fallback_and_do_not_duplicate_count() {
    assert_eq!(
        clocks(
            "FREQ=MINUTELY;BYSECOND=59,60;COUNT=3",
            "2026-12-31T23:58:00Z",
            "2026-12-31T23:58:00Z",
            "2027-01-01T00:02:00Z",
            "Etc/UTC"
        ),
        [
            "2026-12-31T23:58:59.000Z",
            "2026-12-31T23:59:59.000Z",
            "2027-01-01T00:00:59.000Z"
        ]
    );
    assert_eq!(
        clocks(
            "FREQ=MINUTELY;BYSECOND=60;UNTIL=20261231T235960Z",
            "2026-12-31T23:59:00Z",
            "2026-12-31T23:59:00Z",
            "2027-01-01T00:01:00Z",
            "Etc/UTC"
        ),
        ["2026-12-31T23:59:59.000Z"]
    );
}
