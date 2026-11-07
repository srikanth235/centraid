//! THE EDITOR'S BUILDER: [`RepeatSpec`] to and from RRULE text (#1173).
//!
//! The contract the editor leans on: a spec it builds is a rule the engine
//! accepts and expands as meant; a rule `from_rrule` reads is the rule the
//! spec writes back; and a rule outside what the editor shows is `None`, so
//! the editor can show "Custom" and leave the stored text alone.

use centraid_vault::time::recurrence::{ExpandInput, expand};
use centraid_vault::time::rrule::{self, Freq};
use centraid_vault::time::zone::FireZone;
use centraid_vault::time::{MonthlyBasis, RepeatEnd, RepeatSpec, Weekday};

fn spec(freq: Freq, interval: u32) -> RepeatSpec {
    RepeatSpec::every(freq, interval)
}

fn weekly(interval: u32, days: &[Weekday]) -> RepeatSpec {
    RepeatSpec {
        weekdays: days.to_vec(),
        ..spec(Freq::Weekly, interval)
    }
}

fn monthly(interval: u32, monthly: MonthlyBasis) -> RepeatSpec {
    RepeatSpec {
        monthly,
        ..spec(Freq::Monthly, interval)
    }
}

fn ends(mut spec: RepeatSpec, end: RepeatEnd) -> RepeatSpec {
    spec.end = end;
    spec
}

use Weekday::{Friday, Monday, Saturday, Sunday, Thursday, Tuesday, Wednesday};

#[test]
fn weekdays_are_monday_first_and_round_trip_their_tokens() {
    let tokens: Vec<&str> = Weekday::ALL.iter().map(|day| day.token()).collect();
    assert_eq!(tokens, ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
    for day in Weekday::ALL {
        assert_eq!(Weekday::from_token(day.token()), Some(day));
    }
    assert_eq!(Weekday::from_token("XX"), None);
    assert_eq!(
        Weekday::from_token("mo"),
        None,
        "tokens are the RFC's upper case"
    );
    assert!(Monday < Sunday);
}

#[test]
fn a_spec_writes_the_canonical_rule() {
    for (built, rule) in [
        (spec(Freq::Daily, 1), "FREQ=DAILY"),
        (spec(Freq::Daily, 3), "FREQ=DAILY;INTERVAL=3"),
        (weekly(1, &[]), "FREQ=WEEKLY"),
        (weekly(1, &[Friday, Monday]), "FREQ=WEEKLY;BYDAY=MO,FR"),
        (
            weekly(2, &[Sunday, Tuesday, Thursday]),
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH,SU",
        ),
        (spec(Freq::Monthly, 1), "FREQ=MONTHLY"),
        (
            monthly(1, MonthlyBasis::ByDate(vec![15])),
            "FREQ=MONTHLY;BYMONTHDAY=15",
        ),
        (
            monthly(1, MonthlyBasis::ByDate(vec![-1, 15, 1])),
            "FREQ=MONTHLY;BYMONTHDAY=1,15,-1",
        ),
        (
            monthly(
                3,
                MonthlyBasis::ByDay {
                    ordinal: 2,
                    weekday: Monday,
                },
            ),
            "FREQ=MONTHLY;INTERVAL=3;BYDAY=2MO",
        ),
        (
            monthly(
                1,
                MonthlyBasis::ByDay {
                    ordinal: -1,
                    weekday: Friday,
                },
            ),
            "FREQ=MONTHLY;BYDAY=-1FR",
        ),
        (spec(Freq::Yearly, 1), "FREQ=YEARLY"),
        (spec(Freq::Yearly, 2), "FREQ=YEARLY;INTERVAL=2"),
        (
            ends(spec(Freq::Daily, 1), RepeatEnd::Count(10)),
            "FREQ=DAILY;COUNT=10",
        ),
        (
            ends(
                weekly(1, &[Saturday]),
                RepeatEnd::Until("2026-12-31".to_owned()),
            ),
            "FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231",
        ),
        (
            ends(
                monthly(
                    2,
                    MonthlyBasis::ByDay {
                        ordinal: 4,
                        weekday: Wednesday,
                    },
                ),
                RepeatEnd::Count(6),
            ),
            "FREQ=MONTHLY;INTERVAL=2;BYDAY=4WE;COUNT=6",
        ),
    ] {
        assert_eq!(built.to_rrule().as_deref(), Some(rule), "{built:?}");
        assert!(
            rrule::inspect(rule).is_ok(),
            "{rule}: the engine accepts what the builder writes"
        );
    }
}

#[test]
fn fields_that_do_not_apply_to_the_frequency_are_not_written() {
    let mut daily = spec(Freq::Daily, 1);
    daily.weekdays = vec![Monday, Friday];
    daily.monthly = MonthlyBasis::ByDate(vec![1]);
    assert_eq!(daily.to_rrule().as_deref(), Some("FREQ=DAILY"));
    let mut yearly = spec(Freq::Yearly, 1);
    yearly.weekdays = vec![Monday];
    assert_eq!(yearly.to_rrule().as_deref(), Some("FREQ=YEARLY"));
    let mut month = monthly(1, MonthlyBasis::ByDate(vec![5]));
    month.weekdays = vec![Monday];
    assert_eq!(
        month.to_rrule().as_deref(),
        Some("FREQ=MONTHLY;BYMONTHDAY=5")
    );
}

#[test]
fn a_spec_that_is_no_rule_writes_nothing() {
    for built in [
        spec(Freq::Daily, 0),
        ends(spec(Freq::Daily, 1), RepeatEnd::Count(0)),
        ends(
            spec(Freq::Daily, 1),
            RepeatEnd::Until("2026-13-01".to_owned()),
        ),
        ends(
            spec(Freq::Daily, 1),
            RepeatEnd::Until("2026-02-30".to_owned()),
        ),
        ends(
            spec(Freq::Daily, 1),
            RepeatEnd::Until("20261231".to_owned()),
        ),
        ends(spec(Freq::Daily, 1), RepeatEnd::Until(String::new())),
        ends(spec(Freq::Daily, 1), RepeatEnd::Until("soon".to_owned())),
        monthly(1, MonthlyBasis::ByDate(vec![0])),
        monthly(1, MonthlyBasis::ByDate(vec![32])),
        monthly(1, MonthlyBasis::ByDate(vec![-32])),
        monthly(
            1,
            MonthlyBasis::ByDay {
                ordinal: 0,
                weekday: Monday,
            },
        ),
        monthly(
            1,
            MonthlyBasis::ByDay {
                ordinal: 5,
                weekday: Monday,
            },
        ),
        monthly(
            1,
            MonthlyBasis::ByDay {
                ordinal: -2,
                weekday: Monday,
            },
        ),
    ] {
        assert_eq!(built.to_rrule(), None, "{built:?}");
    }
}

#[test]
fn a_rule_the_editor_shows_reads_back_as_its_spec() {
    for (rule, expected) in [
        ("FREQ=DAILY", spec(Freq::Daily, 1)),
        ("RRULE:FREQ=DAILY;INTERVAL=2", spec(Freq::Daily, 2)),
        ("FREQ=WEEKLY", weekly(1, &[])),
        ("FREQ=WEEKLY;BYDAY=FR,MO", weekly(1, &[Monday, Friday])),
        (
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR;WKST=MO",
            weekly(2, &[Monday, Tuesday, Wednesday, Thursday, Friday]),
        ),
        ("FREQ=WEEKLY;BYDAY=SU;WKST=SU", weekly(1, &[Sunday])),
        ("FREQ=WEEKLY;INTERVAL=2;WKST=SU", spec(Freq::Weekly, 2)),
        ("FREQ=MONTHLY", spec(Freq::Monthly, 1)),
        (
            "FREQ=MONTHLY;BYMONTHDAY=-1",
            monthly(1, MonthlyBasis::ByDate(vec![-1])),
        ),
        (
            "FREQ=MONTHLY;BYMONTHDAY=-1,15,1",
            monthly(1, MonthlyBasis::ByDate(vec![1, 15, -1])),
        ),
        (
            "FREQ=MONTHLY;BYDAY=+3WE",
            monthly(
                1,
                MonthlyBasis::ByDay {
                    ordinal: 3,
                    weekday: Wednesday,
                },
            ),
        ),
        (
            "FREQ=MONTHLY;BYDAY=-1SU",
            monthly(
                1,
                MonthlyBasis::ByDay {
                    ordinal: -1,
                    weekday: Sunday,
                },
            ),
        ),
        ("FREQ=YEARLY;INTERVAL=3", spec(Freq::Yearly, 3)),
        (
            "FREQ=DAILY;COUNT=5",
            ends(spec(Freq::Daily, 1), RepeatEnd::Count(5)),
        ),
        (
            "FREQ=DAILY;COUNT=0",
            ends(spec(Freq::Daily, 1), RepeatEnd::Count(1)),
        ),
        (
            "FREQ=DAILY;UNTIL=20261231",
            ends(
                spec(Freq::Daily, 1),
                RepeatEnd::Until("2026-12-31".to_owned()),
            ),
        ),
        (
            "FREQ=DAILY;UNTIL=2026-12-31",
            ends(
                spec(Freq::Daily, 1),
                RepeatEnd::Until("2026-12-31".to_owned()),
            ),
        ),
    ] {
        assert_eq!(
            RepeatSpec::from_rrule(rule),
            Some(expected.clone()),
            "{rule}"
        );
    }
}

/// Everything the editor does not show is `None`, so the editor says "Custom".
#[test]
fn a_rule_outside_the_editor_reads_as_none() {
    for rule in [
        // Parts the editor has no control for.
        "FREQ=YEARLY;BYMONTH=6,7",
        "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15",
        "FREQ=YEARLY;BYYEARDAY=100",
        "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO",
        "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
        "FREQ=DAILY;BYMONTH=2",
        "FREQ=YEARLY;BYDAY=-1FR",
        // Shapes the editor's month and week controls cannot say.
        "FREQ=MONTHLY;BYDAY=MO",
        "FREQ=MONTHLY;BYDAY=MO,FR",
        "FREQ=MONTHLY;BYDAY=1MO,-1MO",
        "FREQ=MONTHLY;BYDAY=2MO;BYMONTHDAY=8",
        "FREQ=MONTHLY;BYDAY=5MO",
        "FREQ=MONTHLY;BYDAY=-2MO",
        "FREQ=DAILY;BYDAY=MO,TU",
        "FREQ=DAILY;BYMONTHDAY=13",
        "FREQ=WEEKLY;BYDAY=-1FR",
        // A week start that moves a fortnightly rule.
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=SU",
        "FREQ=WEEKLY;INTERVAL=3;BYDAY=FR;WKST=WE",
        // An end the date field cannot hold.
        "FREQ=DAILY;UNTIL=20261231T235959Z",
        "FREQ=DAILY;UNTIL=20261231T000000",
        // Not a rule the engine takes at all.
        "FREQ=HOURLY",
        "FREQ=DAILY;BYHOUR=9",
        "FREQ=DAILY;COUNT=2;UNTIL=20270101",
        "banana",
        "",
    ] {
        assert_eq!(RepeatSpec::from_rrule(rule), None, "{rule}");
    }
}

/// THE ROUND TRIP: over a grid of specs, what is written reads back as itself,
/// and what the engine expands is what the spec says.
#[test]
fn every_spec_round_trips_through_its_rule() {
    let mut grid: Vec<RepeatSpec> = Vec::new();
    let ends_list = [
        RepeatEnd::Never,
        RepeatEnd::Count(1),
        RepeatEnd::Count(12),
        RepeatEnd::Until("2027-02-28".to_owned()),
    ];
    let weekday_sets: [&[Weekday]; 5] = [
        &[],
        &[Monday],
        &[Tuesday, Thursday],
        &[Monday, Wednesday, Friday],
        &Weekday::ALL,
    ];
    let month_bases = [
        MonthlyBasis::ByDate(vec![]),
        MonthlyBasis::ByDate(vec![1]),
        MonthlyBasis::ByDate(vec![31]),
        MonthlyBasis::ByDate(vec![1, 15]),
        MonthlyBasis::ByDate(vec![-1]),
        MonthlyBasis::ByDate(vec![1, 15, -1]),
        MonthlyBasis::ByDay {
            ordinal: 1,
            weekday: Monday,
        },
        MonthlyBasis::ByDay {
            ordinal: 4,
            weekday: Sunday,
        },
        MonthlyBasis::ByDay {
            ordinal: -1,
            weekday: Friday,
        },
    ];
    for interval in [1_u32, 2, 3, 13] {
        for end in &ends_list {
            grid.push(ends(spec(Freq::Daily, interval), end.clone()));
            grid.push(ends(spec(Freq::Yearly, interval), end.clone()));
            for days in weekday_sets {
                grid.push(ends(weekly(interval, days), end.clone()));
            }
            for basis in &month_bases {
                grid.push(ends(monthly(interval, basis.clone()), end.clone()));
            }
        }
    }
    assert_eq!(grid.len(), 4 * 4 * (2 + 5 + 9));
    for built in grid {
        let rule = built
            .to_rrule()
            .unwrap_or_else(|| panic!("{built:?} is a rule"));
        assert_eq!(RepeatSpec::from_rrule(&rule), Some(built.clone()), "{rule}");
        // Canonical, and idempotent through the engine's own normaliser.
        assert_eq!(
            rrule::normalize(&rule).as_deref(),
            Some(rule.as_str()),
            "{rule}"
        );
        // A shape exists for the one summariser (the core strings).
        assert!(rrule::shape(&rule).is_some(), "{rule}: a shape");
    }
}

fn days_of(rule: &str, start: &str, count: usize) -> Vec<String> {
    let utc = FireZone::named("Etc/UTC").expect("a zone");
    expand(
        &ExpandInput::new(rule, start, start, "2029-01-01T00:00:00.000Z")
            .in_zone(&utc)
            .at_most(count),
    )
    .iter()
    .map(|occurrence| occurrence.wall_start[..10].to_owned())
    .collect()
}

#[test]
fn a_built_rule_expands_as_the_spec_says() {
    // Every other week on Monday and Friday, six times, from Monday 2026-03-02.
    let rule = ends(weekly(2, &[Friday, Monday]), RepeatEnd::Count(6))
        .to_rrule()
        .expect("a rule");
    assert_eq!(
        days_of(&rule, "2026-03-02T09:00:00.000Z", 50),
        [
            "2026-03-02",
            "2026-03-06",
            "2026-03-16",
            "2026-03-20",
            "2026-03-30",
            "2026-04-03"
        ]
    );
    // The 31st of the month, skipping the short ones.
    let rule = monthly(1, MonthlyBasis::ByDate(vec![31]))
        .to_rrule()
        .expect("a rule");
    assert_eq!(
        days_of(&rule, "2026-01-31T09:00:00.000Z", 5),
        [
            "2026-01-31",
            "2026-03-31",
            "2026-05-31",
            "2026-07-31",
            "2026-08-31"
        ]
    );
    // The last Friday, until the end of June.
    let rule = ends(
        monthly(
            1,
            MonthlyBasis::ByDay {
                ordinal: -1,
                weekday: Friday,
            },
        ),
        RepeatEnd::Until("2026-06-26".to_owned()),
    )
    .to_rrule()
    .expect("a rule");
    assert_eq!(
        days_of(&rule, "2026-01-30T09:00:00.000Z", 50),
        [
            "2026-01-30",
            "2026-02-27",
            "2026-03-27",
            "2026-04-24",
            "2026-05-29",
            "2026-06-26"
        ],
        "the UNTIL day is inclusive"
    );
    // No detail: the anchor's own weekday, every third week.
    let rule = spec(Freq::Weekly, 3).to_rrule().expect("a rule");
    assert_eq!(
        days_of(&rule, "2026-03-04T09:00:00.000Z", 3),
        ["2026-03-04", "2026-03-25", "2026-04-15"]
    );
    // A yearly rule with no detail keeps the anchor's day.
    let rule = spec(Freq::Yearly, 1).to_rrule().expect("a rule");
    assert_eq!(
        days_of(&rule, "2026-07-04T09:00:00.000Z", 3),
        ["2026-07-04", "2027-07-04", "2028-07-04"]
    );
}
