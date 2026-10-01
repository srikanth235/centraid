//! The date evaluator against the phrase table (SPEC §4.4, §14), plus
//! properties of the evaluator over arbitrary days.

use centraid_nativetools::dates::{self, Resolved, Stamp};
use centraid_nativetools::phrases::PHRASES;
use jiff::ToSpan as _;
use jiff::civil::Date;
use proptest::prelude::*;

fn eval_at(expr: &str, today: &str, row: Option<&str>) -> Result<Resolved, String> {
    let expr = dates::parse(&serde_json::from_str(expr).map_err(|e| e.to_string())?)?;
    let row = row.map(|text| Stamp::parse(text).expect("a row date"));
    dates::evaluate(&expr, dates::parse_now(today)?, row)
}

#[test]
fn the_phrase_table_has_at_least_sixty_rows_and_every_row_evaluates_to_its_echo() {
    assert!(PHRASES.len() >= 60, "{} rows", PHRASES.len());
    for phrase in PHRASES {
        let resolved = eval_at(phrase.expr, phrase.today, phrase.row)
            .unwrap_or_else(|error| panic!("{}: {error}", phrase.phrase));
        assert_eq!(
            resolved.echo(),
            phrase.echo,
            "\"{}\" on {}",
            phrase.phrase,
            phrase.today
        );
    }
}

#[test]
fn the_rulings_the_spec_names_are_in_the_table() {
    let find = |phrase: &str, today: &str| {
        PHRASES
            .iter()
            .find(|row| row.phrase == phrase && row.today == today)
            .unwrap_or_else(|| panic!("{phrase} on {today} is not in the table"))
    };
    assert_eq!(
        find("last november", "2027-01-19").echo,
        "2026-11-01..2026-11-30"
    );
    assert_eq!(
        find("next monday at 2", "2026-09-30").echo,
        "Mon 2026-10-05 14:00"
    );
    let earlier = find("an hour earlier", "2026-09-30");
    assert_eq!(earlier.row, Some("2026-06-19T09:00"));
    assert!(earlier.expr.contains("\"anchor\":\"row\""));
    assert_eq!(earlier.echo, "Fri 2026-06-19 08:00");
    // 2026-10-03 is a Saturday: this weekend is today and tomorrow.
    assert_eq!(
        find("this weekend", "2026-10-03").echo,
        "2026-10-03..2026-10-04"
    );
    assert_eq!(
        find("next monday", "2026-09-27").echo,
        "Mon 2026-09-28",
        "even on a Sunday"
    );
}

#[test]
fn a_bad_expression_is_rejected_with_the_grammar_examples() {
    for bad in [
        r#"{"unit":"day"}"#,
        r#"{"unit":"fortnight","rel":1}"#,
        r#"{"unit":"day","rel":1,"weekday":2}"#,
        r#"{"unit":"month","rel":1,"time":"10:00"}"#,
        r#"{"unit":"month","rel":1,"name":13}"#,
        r#"{"unit":"day","rel":1,"time":"9am"}"#,
        r#"{"date":"30/09/2026"}"#,
        r#"{"from":{"from":{"unit":"day","rel":0},"to":{"unit":"day","rel":1}},"to":{"unit":"day","rel":1}}"#,
        r#"{"from":{"unit":"day","rel":2},"to":{"unit":"day","rel":1}}"#,
        r#""tomorrow""#,
    ] {
        let error = eval_at(bad, "2026-09-30", None).expect_err(bad);
        let message = dates::rejection(&error);
        assert!(
            message.starts_with("error: could not read the date expression"),
            "{bad}"
        );
        assert!(
            message.contains(r#"{"unit":"day","rel":1} = tomorrow"#),
            "{bad}"
        );
    }
}

fn day(offset: i64) -> Date {
    Date::constant(2026, 1, 1)
        .checked_add(offset.days())
        .expect("in range")
}

proptest! {
    #[test]
    fn a_day_expression_is_exactly_that_day(offset in 0_i64..3000, rel in -400_i64..400) {
        let today = day(offset);
        let resolved = eval_at(&format!(r#"{{"unit":"day","rel":{rel}}}"#), &today.to_string(), None).unwrap();
        let want = today.checked_add(rel.days()).unwrap();
        prop_assert_eq!(resolved, Resolved::Days { from: want, to: want });
    }

    #[test]
    fn a_week_runs_monday_to_sunday_and_contains_today_at_rel_zero(offset in 0_i64..3000, rel in -60_i64..60) {
        let today = day(offset);
        let Resolved::Days { from, to } = eval_at(&format!(r#"{{"unit":"week","rel":{rel}}}"#), &today.to_string(), None).unwrap() else {
            panic!("a week is a range of days");
        };
        prop_assert_eq!(from.weekday().to_monday_one_offset(), 1);
        prop_assert_eq!(from.checked_add(6.days()).unwrap(), to);
        if rel == 0 {
            prop_assert!(from <= today && today <= to);
        }
    }

    #[test]
    fn last_named_month_has_fully_ended_and_is_the_most_recent(offset in 0_i64..3000, month in 1_i8..=12) {
        let today = day(offset);
        let Resolved::Days { from, to } = eval_at(&format!(r#"{{"unit":"month","name":{month},"rel":-1}}"#), &today.to_string(), None).unwrap() else {
            panic!("a month is a range of days");
        };
        prop_assert_eq!(from.month(), month);
        prop_assert!(to < today, "ended before today");
        // The next one of that name has not fully ended.
        let next = Date::new(from.year() + 1, month, 1).unwrap().last_of_month();
        prop_assert!(next >= today);
    }

    #[test]
    fn next_named_month_has_not_begun(offset in 0_i64..3000, month in 1_i8..=12) {
        let today = day(offset);
        let Resolved::Days { from, .. } = eval_at(&format!(r#"{{"unit":"month","name":{month},"rel":1}}"#), &today.to_string(), None).unwrap() else {
            panic!("a month is a range of days");
        };
        prop_assert!(from > today);
        prop_assert!(from.checked_sub(1.years()).unwrap() <= today);
    }

    #[test]
    fn an_hour_shift_on_the_row_is_exact(hour in 0_i8..23, minute in 0_i8..59, rel in -48_i64..48) {
        let row = format!("2026-06-19T{hour:02}:{minute:02}");
        let resolved = eval_at(&format!(r#"{{"unit":"hour","rel":{rel},"anchor":"row"}}"#), "2026-09-30", Some(&row)).unwrap();
        let base = Stamp::parse(&row).unwrap().at();
        prop_assert_eq!(resolved, Resolved::At(base.checked_add(rel.hours()).unwrap()));
    }

    #[test]
    fn a_resolved_range_contains_its_own_ends(offset in 0_i64..3000, rel in -20_i64..20) {
        let today = day(offset);
        let resolved = eval_at(&format!(r#"{{"unit":"month","rel":{rel}}}"#), &today.to_string(), None).unwrap();
        let Resolved::Days { from, to } = resolved else { panic!("days") };
        let (first, last) = (Stamp { date: from, time: None }, Stamp { date: to, time: None });
        let after = Stamp { date: to.tomorrow().unwrap(), time: None };
        prop_assert!(resolved.contains(first));
        prop_assert!(resolved.contains(last));
        prop_assert!(!resolved.contains(after));
    }
}
