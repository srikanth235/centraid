//! THE ONE RRULE PARSER, ITS REFUSALS, ITS CANONICAL FORM AND ITS SENTENCES
//! (#1173, "custom repeat: any RRULE").
//!
//! Three things are pinned here and nowhere else: every shape the engine
//! REFUSES says so, with a sentence that names the part; every shape it
//! ACCEPTS parses to the fields the RFC names and round-trips through its
//! canonical spelling; and the ONE summariser has words for each.

use centraid_vault::time::recurrence::{ExpandInput, expand};
use centraid_vault::time::rrule::{
    self, DayRule, Freq, ParsedRrule, Refusal, Until, assert_supported, inspect, normalize, parse,
};
use centraid_vault::time::zone::FireZone;

fn parsed(rule: &str) -> ParsedRrule {
    inspect(rule).unwrap_or_else(|refusal| panic!("{rule}: {refusal}"))
}

fn refused(rule: &str) -> Refusal {
    match inspect(rule) {
        Err(refusal) => refusal,
        Ok(_) => panic!("{rule} should be refused"),
    }
}

/// A refused rule is refused EVERYWHERE: the write boundary, the reporting
/// shape, the read shape, the summariser and the expander.
fn assert_refused_everywhere(rule: &str) -> Refusal {
    let refusal = refused(rule);
    assert_eq!(
        assert_supported(rule).err(),
        Some(refusal.clone()),
        "{rule}"
    );
    assert_eq!(parse(rule), None, "{rule}");
    assert_eq!(rrule::shape(rule), None, "{rule}");
    assert_eq!(normalize(rule), None, "{rule}");
    let utc = FireZone::named("Etc/UTC").expect("a zone");
    let found = expand(
        &ExpandInput::new(
            rule,
            "2026-03-01T09:00:00.000Z",
            "2026-03-01T00:00:00.000Z",
            "2028-03-01T00:00:00.000Z",
        )
        .in_zone(&utc),
    );
    assert!(
        found.is_empty(),
        "{rule}: a refused rule expands to nothing"
    );
    assert!(!refusal.message().is_empty(), "{rule}: a sentence");
    refusal
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

#[test]
fn sub_daily_frequencies_are_refused_and_named() {
    for freq in ["HOURLY", "MINUTELY", "SECONDLY"] {
        let rule = format!("FREQ={freq};INTERVAL=2");
        let refusal = assert_refused_everywhere(&rule);
        assert_eq!(
            refusal,
            Refusal::UnsupportedFreq {
                freq: freq.to_owned()
            }
        );
        assert!(
            refusal.message().contains(&format!("FREQ={freq}")),
            "{refusal}"
        );
        assert_eq!(refusal.reason(), "unsupported-freq");
    }
}

#[test]
fn the_time_of_day_parts_are_refused_under_every_frequency() {
    for part in ["BYHOUR=9", "BYMINUTE=30", "BYSECOND=15"] {
        for freq in ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] {
            let rule = format!("FREQ={freq};{part}");
            let refusal = assert_refused_everywhere(&rule);
            let name = part.split('=').next().expect("a name");
            assert_eq!(
                refusal,
                Refusal::UnsupportedPart {
                    part: name.to_owned()
                }
            );
            assert!(refusal.message().contains("wall clock"), "{refusal}");
            assert_eq!(refusal.reason(), "unsupported-part");
        }
    }
}

#[test]
fn the_non_gregorian_calendar_parts_of_rfc_7529_are_refused() {
    for (rule, part) in [
        ("FREQ=YEARLY;RSCALE=HEBREW", "RSCALE"),
        ("FREQ=YEARLY;RSCALE=GREGORIAN;SKIP=FORWARD", "RSCALE"),
        ("FREQ=MONTHLY;SKIP=BACKWARD", "SKIP"),
        ("FREQ=MONTHLY;BYMONTHDAY=31;SKIP=OMIT", "SKIP"),
    ] {
        let refusal = assert_refused_everywhere(rule);
        assert_eq!(
            refusal,
            Refusal::UnsupportedPart {
                part: part.to_owned()
            },
            "{rule}"
        );
        assert!(refusal.message().contains("RFC 7529"), "{refusal}");
    }
}

#[test]
fn text_that_is_not_a_rule_is_malformed() {
    for rule in [
        "",
        "   ",
        "banana",
        "INTERVAL=2",
        "FREQ=",
        "FREQ=FORTNIGHTLY",
        "BYDAY=MO",
        "COUNT=3",
    ] {
        assert_eq!(
            assert_refused_everywhere(rule),
            Refusal::Malformed,
            "{rule:?}"
        );
    }
    assert_eq!(Refusal::Malformed.reason(), "malformed");
    assert!(Refusal::Malformed.message().contains("FREQ"));
}

#[test]
fn an_unknown_a_repeated_or_part_less_segment_is_refused_never_dropped() {
    for (rule, part, why) in [
        ("FREQ=DAILY;FOO=1", "FOO", "not a recurrence rule part"),
        (
            "FREQ=DAILY;X-NOTE=1",
            "X-NOTE",
            "not a recurrence rule part",
        ),
        ("FREQ=DAILY;banana", "BANANA", "NAME=value"),
        ("FREQ=DAILY;FREQ=WEEKLY", "FREQ", "more than once"),
        ("FREQ=DAILY;COUNT=1;COUNT=2", "COUNT", "more than once"),
        ("FREQ=WEEKLY;BYDAY=MO;BYDAY=TU", "BYDAY", "more than once"),
        (
            "FREQ=DAILY;INTERVAL=2;INTERVAL=3",
            "INTERVAL",
            "more than once",
        ),
    ] {
        let refusal = assert_refused_everywhere(rule);
        match &refusal {
            Refusal::Invalid {
                part: found,
                problem,
            } => {
                assert_eq!(found, part, "{rule}");
                assert!(problem.contains(why), "{rule}: {problem}");
            }
            other => panic!("{rule}: {other:?}"),
        }
        assert_eq!(refusal.reason(), "invalid-part");
        assert!(refusal.message().contains(part), "{rule}: {refusal}");
    }
}

#[test]
fn count_together_with_until_is_refused() {
    for rule in [
        "FREQ=DAILY;COUNT=3;UNTIL=20270101",
        "FREQ=WEEKLY;BYDAY=MO;UNTIL=20270101T000000Z;COUNT=10",
    ] {
        let refusal = assert_refused_everywhere(rule);
        assert!(
            matches!(&refusal, Refusal::Invalid { part, problem } if part == "COUNT" && problem.contains("UNTIL")),
            "{refusal}"
        );
    }
}

#[test]
fn a_value_that_is_not_what_its_part_takes_is_refused_naming_the_part() {
    for (rule, part) in [
        ("FREQ=DAILY;INTERVAL=banana", "INTERVAL"),
        ("FREQ=DAILY;INTERVAL=", "INTERVAL"),
        ("FREQ=DAILY;COUNT=banana", "COUNT"),
        ("FREQ=DAILY;COUNT=inf", "COUNT"),
        ("FREQ=DAILY;UNTIL=SOON", "UNTIL"),
        ("FREQ=DAILY;UNTIL=20261301", "UNTIL"),
        ("FREQ=DAILY;UNTIL=20260230", "UNTIL"),
        ("FREQ=DAILY;UNTIL=2026-12-31T25:00:00Z", "UNTIL"),
        ("FREQ=DAILY;UNTIL=20261231T0000Z", "UNTIL"),
        ("FREQ=WEEKLY;WKST=XX", "WKST"),
        ("FREQ=WEEKLY;WKST=2", "WKST"),
        ("FREQ=WEEKLY;WKST=", "WKST"),
        ("FREQ=WEEKLY;BYDAY=XX", "BYDAY"),
        ("FREQ=WEEKLY;BYDAY=MO,", "BYDAY"),
        ("FREQ=WEEKLY;BYDAY=", "BYDAY"),
        ("FREQ=WEEKLY;BYDAY=+MO", "BYDAY"),
        ("FREQ=MONTHLY;BYDAY=0MO", "BYDAY"),
        ("FREQ=MONTHLY;BYDAY=123MO", "BYDAY"),
        ("FREQ=YEARLY;BYDAY=54MO", "BYDAY"),
        ("FREQ=MONTHLY;BYMONTHDAY=0", "BYMONTHDAY"),
        ("FREQ=MONTHLY;BYMONTHDAY=32", "BYMONTHDAY"),
        ("FREQ=MONTHLY;BYMONTHDAY=-32", "BYMONTHDAY"),
        ("FREQ=MONTHLY;BYMONTHDAY=1,x", "BYMONTHDAY"),
        ("FREQ=MONTHLY;BYMONTHDAY=", "BYMONTHDAY"),
        ("FREQ=YEARLY;BYMONTH=0", "BYMONTH"),
        ("FREQ=YEARLY;BYMONTH=13", "BYMONTH"),
        ("FREQ=YEARLY;BYMONTH=5L", "BYMONTH"),
        ("FREQ=YEARLY;BYMONTH=-1", "BYMONTH"),
        ("FREQ=YEARLY;BYYEARDAY=0", "BYYEARDAY"),
        ("FREQ=YEARLY;BYYEARDAY=367", "BYYEARDAY"),
        ("FREQ=YEARLY;BYYEARDAY=-367", "BYYEARDAY"),
        ("FREQ=YEARLY;BYWEEKNO=0", "BYWEEKNO"),
        ("FREQ=YEARLY;BYWEEKNO=54", "BYWEEKNO"),
        ("FREQ=YEARLY;BYWEEKNO=-54", "BYWEEKNO"),
        ("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=0", "BYSETPOS"),
        ("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=367", "BYSETPOS"),
        ("FREQ=MONTHLY;BYDAY=MO;BYSETPOS=x", "BYSETPOS"),
    ] {
        let refusal = assert_refused_everywhere(rule);
        assert!(
            matches!(&refusal, Refusal::Invalid { part: found, .. } if found == part),
            "{rule}: {refusal:?}"
        );
    }
}

/// RFC 5545's table of which part takes which frequency: the ones it forbids
/// are refused with the part named, and the sentence says what the part IS for.
#[test]
fn a_part_the_frequency_may_not_carry_is_refused() {
    for (rule, part, says) in [
        ("FREQ=DAILY;BYWEEKNO=12", "BYWEEKNO", "YEARLY"),
        ("FREQ=WEEKLY;BYWEEKNO=12", "BYWEEKNO", "YEARLY"),
        ("FREQ=MONTHLY;BYWEEKNO=12", "BYWEEKNO", "YEARLY"),
        ("FREQ=DAILY;BYYEARDAY=200", "BYYEARDAY", "YEARLY"),
        ("FREQ=WEEKLY;BYYEARDAY=200", "BYYEARDAY", "YEARLY"),
        ("FREQ=MONTHLY;BYYEARDAY=200", "BYYEARDAY", "YEARLY"),
        ("FREQ=WEEKLY;BYMONTHDAY=1", "BYMONTHDAY", "WEEKLY"),
        (
            "FREQ=WEEKLY;BYDAY=MO;BYMONTHDAY=1,15",
            "BYMONTHDAY",
            "WEEKLY",
        ),
        ("FREQ=DAILY;BYDAY=2MO", "BYDAY", "MONTHLY and YEARLY"),
        ("FREQ=WEEKLY;BYDAY=-1FR", "BYDAY", "MONTHLY and YEARLY"),
        (
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,2TU",
            "BYDAY",
            "MONTHLY and YEARLY",
        ),
        ("FREQ=MONTHLY;BYDAY=6MO", "BYDAY", "1 to 5"),
        ("FREQ=MONTHLY;BYDAY=-6MO", "BYDAY", "1 to 5"),
        (
            "FREQ=YEARLY;BYMONTH=2;BYDAY=6MO",
            "BYDAY",
            "within the month",
        ),
        ("FREQ=YEARLY;BYWEEKNO=20;BYDAY=2MO", "BYDAY", "BYWEEKNO"),
        (
            "FREQ=MONTHLY;BYSETPOS=-1",
            "BYSETPOS",
            "nothing to pick from",
        ),
        ("FREQ=DAILY;BYSETPOS=1", "BYSETPOS", "nothing to pick from"),
        (
            "FREQ=YEARLY;BYSETPOS=1,2;INTERVAL=2",
            "BYSETPOS",
            "nothing to pick from",
        ),
    ] {
        let refusal = assert_refused_everywhere(rule);
        match &refusal {
            Refusal::Invalid {
                part: found,
                problem,
            } => {
                assert_eq!(found, part, "{rule}");
                assert!(problem.contains(says), "{rule}: {problem}");
            }
            other => panic!("{rule}: {other:?}"),
        }
    }
}

#[test]
fn the_cautionary_case_stays_refused_and_its_replacement_is_a_rule() {
    // "The last Friday of the month" written as a lone BYSETPOS used to parse as
    // a plain monthly rule. It is refused; the rule it meant is expressible.
    assert!(matches!(
        refused("FREQ=MONTHLY;BYSETPOS=-1"),
        Refusal::Invalid { ref part, .. } if part == "BYSETPOS"
    ));
    let last_friday = parsed("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1");
    assert_eq!(last_friday.by_set_pos, [-1]);
    assert_eq!(
        last_friday.by_day,
        [DayRule {
            ordinal: None,
            day: 5
        }]
    );
    let same = parsed("FREQ=MONTHLY;BYDAY=-1FR");
    assert_eq!(
        same.by_day,
        [DayRule {
            ordinal: Some(-1),
            day: 5
        }]
    );
}

// ---------------------------------------------------------------------------
// Accepted shapes
// ---------------------------------------------------------------------------

#[test]
fn every_part_parses_to_the_fields_the_rfc_names() {
    let rule = parsed(
        "FREQ=YEARLY;INTERVAL=2;BYMONTH=1,3;BYWEEKNO=2,-1;BYYEARDAY=1,-1;BYMONTHDAY=1,-1;\
         BYDAY=MO,TU;BYSETPOS=1,-1;WKST=SU;UNTIL=20301231",
    );
    assert_eq!(rule.freq, Freq::Yearly);
    assert_eq!(rule.interval, 2);
    assert_eq!(rule.by_month, [1, 3]);
    assert_eq!(rule.by_week_no, [2, -1]);
    assert_eq!(rule.by_year_day, [1, -1]);
    assert_eq!(rule.by_month_day, [1, -1]);
    assert_eq!(
        rule.by_day,
        [
            DayRule {
                ordinal: None,
                day: 1
            },
            DayRule {
                ordinal: None,
                day: 2
            }
        ]
    );
    assert_eq!(rule.by_set_pos, [1, -1]);
    assert_eq!(rule.wkst, Some(0));
    assert_eq!(rule.week_start(), 0);
    assert_eq!(rule.count, None);
    assert_eq!(rule.until.as_deref(), Some("20301231"));
    assert!(matches!(rule.until_bound(), Some(Until::Date(_))));
}

#[test]
fn the_weekday_tokens_and_ordinals_parse() {
    let rule = parsed("FREQ=YEARLY;BYDAY=SU,MO,TU,WE,TH,FR,SA,+2MO,-1FR,53SU");
    let tokens: Vec<(Option<i64>, &str)> = rule
        .by_day
        .iter()
        .map(|day| (day.ordinal, day.token()))
        .collect();
    assert_eq!(
        tokens,
        [
            (None, "SU"),
            (None, "MO"),
            (None, "TU"),
            (None, "WE"),
            (None, "TH"),
            (None, "FR"),
            (None, "SA"),
            (Some(2), "MO"),
            (Some(-1), "FR"),
            (Some(53), "SU"),
        ]
    );
    // WKST defaults to Monday.
    assert_eq!(parsed("FREQ=WEEKLY").week_start(), 1);
    assert_eq!(parsed("FREQ=WEEKLY").wkst, None);
}

#[test]
fn every_frequency_takes_the_parts_the_rfc_gives_it() {
    for rule in [
        "FREQ=DAILY;BYMONTH=1,2;BYMONTHDAY=1,-1;BYDAY=MO,TU",
        "FREQ=DAILY;INTERVAL=3;BYDAY=MO;BYSETPOS=1",
        "FREQ=WEEKLY;BYMONTH=6;BYDAY=MO,WE,FR;BYSETPOS=-1;WKST=SU",
        "FREQ=WEEKLY;INTERVAL=2;WKST=WE",
        "FREQ=MONTHLY;BYMONTH=1,7;BYMONTHDAY=1,15,-1;BYSETPOS=2",
        "FREQ=MONTHLY;BYDAY=1MO,-1MO;BYMONTHDAY=1,2,3,4,5,6,7",
        "FREQ=MONTHLY;BYDAY=5SU",
        "FREQ=YEARLY;BYMONTH=2;BYDAY=-5MO",
        "FREQ=YEARLY;BYDAY=-53MO",
        "FREQ=YEARLY;BYWEEKNO=1,53;BYDAY=MO,SU;WKST=SU",
        "FREQ=YEARLY;BYYEARDAY=-366,366;BYMONTH=12",
        "FREQ=YEARLY;BYMONTHDAY=29;BYMONTH=2",
    ] {
        assert!(inspect(rule).is_ok(), "{rule}: {:?}", inspect(rule));
        assert!(rrule::shape(rule).is_some(), "{rule}: a shape");
    }
}

#[test]
fn the_lenient_spellings_stay() {
    // Case, whitespace, the prefix, empty segments.
    for rule in [
        "freq=daily;interval=2",
        "RRULE:FREQ=DAILY;INTERVAL=2",
        " rrule: FREQ = DAILY ; INTERVAL = 2 ",
        ";;FREQ=DAILY;INTERVAL=2;",
    ] {
        assert_eq!(parsed(rule), parsed("FREQ=DAILY;INTERVAL=2"), "{rule}");
    }
    // A non-positive bound is a single occurrence, never an unbounded series.
    assert_eq!(parsed("FREQ=DAILY;COUNT=0").count, Some(1));
    assert_eq!(parsed("FREQ=DAILY;COUNT=-3").count, Some(1));
    assert_eq!(parsed("FREQ=DAILY;INTERVAL=0").interval, 1);
    assert_eq!(parsed("FREQ=DAILY;INTERVAL=-4").interval, 1);
    // Repeated values in a list are one.
    assert_eq!(
        parsed("FREQ=MONTHLY;BYMONTHDAY=1,1,15").by_month_day,
        [1, 15]
    );
}

#[test]
fn every_until_spelling_reads_as_what_it_means() {
    let bound = |text: &str| parsed(&format!("FREQ=DAILY;UNTIL={text}")).until_bound();
    assert!(matches!(bound("20261231"), Some(Until::Date(_))));
    assert!(matches!(bound("2026-12-31"), Some(Until::Date(_))));
    assert_eq!(bound("20261231"), bound("2026-12-31"));
    assert!(matches!(bound("20261231T235959Z"), Some(Until::Utc(_))));
    assert!(matches!(bound("2026-12-31T23:59:59Z"), Some(Until::Utc(_))));
    assert_eq!(bound("20261231T235959Z"), bound("2026-12-31T23:59:59Z"));
    assert!(matches!(bound("20261231T235959"), Some(Until::Floating(_))));
    assert!(matches!(
        bound("2026-12-31T23:59"),
        Some(Until::Floating(_))
    ));
    // An offset is an instant: 23:59 at -05:00 is 04:59Z the next day.
    assert_eq!(
        bound("2026-12-31T23:59:00-05:00"),
        bound("20270101T045900Z")
    );
    assert_eq!(parsed("FREQ=DAILY").until_bound(), None);
}

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

#[test]
fn a_rule_has_one_canonical_spelling_and_it_round_trips() {
    for (rule, canonical) in [
        ("freq=daily", "FREQ=DAILY"),
        (
            "RRULE:FREQ=WEEKLY;BYDAY=FR,MO;INTERVAL=2",
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO",
        ),
        (
            "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15",
            "FREQ=MONTHLY;BYMONTHDAY=15",
        ),
        ("FREQ=MONTHLY;BYDAY=+2MO", "FREQ=MONTHLY;BYDAY=2MO"),
        (
            "FREQ=YEARLY;UNTIL=20301231;BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR;BYMONTH=12",
            "FREQ=YEARLY;BYMONTH=12;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;UNTIL=20301231",
        ),
        (
            "FREQ=YEARLY;WKST=SU;BYWEEKNO=53;BYDAY=SU;COUNT=4",
            "FREQ=YEARLY;BYWEEKNO=53;BYDAY=SU;WKST=SU;COUNT=4",
        ),
        ("FREQ=DAILY;COUNT=0", "FREQ=DAILY;COUNT=1"),
        ("FREQ=DAILY;INTERVAL=0;;", "FREQ=DAILY"),
        (
            "FREQ=MONTHLY;BYMONTHDAY=1,1,-1",
            "FREQ=MONTHLY;BYMONTHDAY=1,-1",
        ),
        (
            "FREQ=YEARLY;BYYEARDAY=-1,1;BYMONTH=12,1",
            "FREQ=YEARLY;BYMONTH=12,1;BYYEARDAY=-1,1",
        ),
    ] {
        assert_eq!(normalize(rule).as_deref(), Some(canonical), "{rule}");
        // Idempotent, and the same rule.
        assert_eq!(normalize(canonical).as_deref(), Some(canonical), "{rule}");
        assert_eq!(parse(canonical), parse(rule), "{rule}");
        assert_eq!(parsed(rule).to_canonical(), canonical, "{rule}");
    }
}

#[test]
fn the_canonical_form_of_every_accepted_shape_parses_back_to_the_same_rule() {
    for rule in [
        "FREQ=DAILY;BYMONTH=1,2;BYMONTHDAY=1,-1;BYDAY=MO,TU;UNTIL=20271231T000000Z",
        "FREQ=WEEKLY;INTERVAL=3;BYDAY=FR,SA,SU;WKST=SA;COUNT=7",
        "FREQ=MONTHLY;BYDAY=1MO,-1MO;BYMONTHDAY=1,2,3,4,5,6,7;BYSETPOS=-1",
        "FREQ=YEARLY;BYWEEKNO=1,-1;BYDAY=MO;WKST=SU;UNTIL=2030-12-31T10:00:00",
        "FREQ=YEARLY;BYYEARDAY=1,100,200;INTERVAL=3;COUNT=10",
        "FREQ=YEARLY;BYMONTH=11;BYDAY=4TH",
    ] {
        let first = parsed(rule);
        let again = parsed(&first.to_canonical());
        assert_eq!(first, again, "{rule}");
    }
}

// ---------------------------------------------------------------------------
// The ONE summariser
// ---------------------------------------------------------------------------

#[test]
fn a_rule_has_a_structural_shape_and_no_words() {
    use centraid_vault::time::rrule::{ShapeEnd, shape};
    let said = shape("FREQ=MONTHLY;INTERVAL=3;BYDAY=-1FR;BYMONTH=1,7;COUNT=4").expect("shape");
    assert_eq!(said.freq, Freq::Monthly);
    assert_eq!(said.interval, 3);
    assert_eq!(
        said.weekdays,
        vec![DayRule {
            ordinal: Some(-1),
            day: 5
        }]
    );
    assert_eq!(said.months, vec![1, 7]);
    assert_eq!(said.end, ShapeEnd::Count(4));

    let said =
        shape("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1,1;UNTIL=2030-12-31").expect("shape");
    assert_eq!(said.set_positions, vec![-1, 1]);
    assert_eq!(
        said.end,
        ShapeEnd::Until {
            year: 2030,
            month: 12,
            day: 31
        }
    );
    let said = shape("FREQ=YEARLY;BYYEARDAY=1,-1;BYWEEKNO=20;BYMONTHDAY=3").expect("shape");
    assert_eq!(said.year_days, vec![1, -1]);
    assert_eq!(said.week_numbers, vec![20]);
    assert_eq!(said.month_days, vec![3]);
    assert_eq!(said.end, ShapeEnd::Never);
    // The basic UTC spelling names its day too.
    assert_eq!(
        shape("FREQ=DAILY;UNTIL=20260301T000000Z").map(|rule| rule.end),
        Some(ShapeEnd::Until {
            year: 2026,
            month: 3,
            day: 1
        })
    );
    // WKST is not what a member reads.
    assert_eq!(shape("FREQ=WEEKLY;WKST=SU"), shape("FREQ=WEEKLY"));
}

#[test]
fn the_refusal_sentence_quotes_the_rule() {
    assert_eq!(
        rrule::refusal_sentence(&refused("FREQ=HOURLY"), "RRULE: FREQ=HOURLY"),
        format!("{} (rule: FREQ=HOURLY)", refused("FREQ=HOURLY").message())
    );
}
