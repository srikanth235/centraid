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
        // nt12 R3: only the example for the key that failed (all of them when none is named)
        let quoted = message.matches(" = ").count();
        assert!(
            (1..=dates::EXAMPLES.len()).contains(&quoted),
            "{bad}: {message}"
        );
    }
    let time = dates::rejection("time 9am is not \"HH:MM\"");
    assert!(time.contains("a date with a time") && !time.contains("tomorrow"));
    let unknown = dates::rejection("it is not a JSON object");
    assert_eq!(unknown.matches(" = ").count(), dates::EXAMPLES.len());
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

// ---------------------------------------------------------------------------
// THE DATES LINE (SPEC §6.1): every phrase family, on a Friday.
// ---------------------------------------------------------------------------

use centraid_nativetools::phrases::{DATES_CAP, dates_line, read_dates};

/// Friday 2026-10-02, 09:00. This week is 09-28..10-04.
const FRIDAY: &str = "2026-10-02T09:00";

fn line_on(today: &str, message: &str) -> String {
    dates_line(message, dates::parse_now(today).expect("a date")).unwrap_or_default()
}

fn line(message: &str) -> String {
    line_on(FRIDAY, message)
}

/// The entries of the line, without its `dates: ` lead.
fn entries(message: &str) -> Vec<String> {
    read_dates(message, dates::parse_now(FRIDAY).expect("a date"))
        .into_iter()
        .map(|reading| format!("{} = {}", reading.phrase, reading.resolution))
        .collect()
}

#[test]
fn a_message_without_a_date_phrase_has_no_line() {
    for message in [
        "",
        "hello",
        "how many tasks do i have",
        "star the second one",
        "the first two of them",
        "mark the third of those done",
        "which two are due first",
        "paid 12.50 for lunch",
        "move it to 14 cardigan rd",
        "add it to 3 lists",
        "at 3 people",
        "a table for 4 at 26 degrees",
        "tell june about it",
        "may i see them",
        "that friday",
        "the monday before",
        "she sat down",
    ] {
        assert_eq!(line(message), "", "{message:?}");
    }
}

#[test]
fn the_line_leads_with_dates_and_joins_entries_in_message_order() {
    assert_eq!(
        line("friday and tomorrow, then last week"),
        "dates: friday = 2026-10-02 · tomorrow = 2026-10-03 · last week = 2026-09-21..2026-09-27"
    );
    // a phrase said twice is listed once
    assert_eq!(line("tomorrow or tomorrow"), "dates: tomorrow = 2026-10-03");
}

#[test]
fn day_words() {
    assert_eq!(line("tomorrow"), "dates: tomorrow = 2026-10-03");
    assert_eq!(line("tmrw"), "dates: tmrw = 2026-10-03");
    assert_eq!(
        line("what's due today and yesterday"),
        "dates: today = 2026-10-02 · yesterday = 2026-10-01"
    );
    assert_eq!(
        line("the day after tomorrow"),
        "dates: the day after tomorrow = 2026-10-04"
    );
    assert_eq!(
        line("the day before yesterday"),
        "dates: the day before yesterday = 2026-09-30"
    );
    assert_eq!(line("tonight"), "dates: tonight = 2026-10-02");
    assert_eq!(
        line("i rang this morning"),
        "dates: this morning = 2026-10-02"
    );
    assert_eq!(line("sent it last night"), "dates: last night = 2026-10-01");
}

#[test]
fn a_weekday_still_ahead_or_today_has_one_reading() {
    assert_eq!(line("friday"), "dates: friday = 2026-10-02");
    assert_eq!(line("saturday"), "dates: saturday = 2026-10-03");
    assert_eq!(line("this sunday"), "dates: this sunday = 2026-10-04");
    assert_eq!(line("on sun"), "dates: sun = 2026-10-04");
    // possessives and short spellings
    assert_eq!(line("saturday's game"), "dates: saturday = 2026-10-03");
    assert_eq!(
        line("thurs"),
        "dates: thurs = 2026-10-01 (past) / 2026-10-08 (upcoming)"
    );
}

#[test]
fn a_weekday_gone_by_this_week_has_a_past_and_an_upcoming_reading() {
    assert_eq!(
        line("monday"),
        "dates: monday = 2026-09-28 (past) / 2026-10-05 (upcoming)"
    );
    assert_eq!(
        line("this monday"),
        "dates: this monday = 2026-09-28 (past) / 2026-10-05 (upcoming)"
    );
    // a read of last week's and a write for the next one both find theirs
    assert_eq!(
        line_on("2026-10-04T09:00", "friday"),
        "dates: friday = 2026-10-02 (past) / 2026-10-09 (upcoming)"
    );
}

#[test]
fn next_last_and_the_week_a_weekday_names() {
    assert_eq!(line("next tuesday"), "dates: next tuesday = 2026-10-06");
    assert_eq!(line("next sat"), "dates: next sat = 2026-10-10");
    assert_eq!(line("last friday"), "dates: last friday = 2026-09-25");
    assert_eq!(line("friday week"), "dates: friday week = 2026-10-16");
    assert_eq!(
        line("thursday next week"),
        "dates: thursday next week = 2026-10-08"
    );
    assert_eq!(
        line("wednesday of next week"),
        "dates: wednesday of next week = 2026-10-07"
    );
    assert_eq!(
        line("monday two weeks back"),
        "dates: monday two weeks back = 2026-09-14"
    );
    // "monday to wednesday next week": the week the second one names is the first one's too
    assert_eq!(
        line("monday to wednesday next week"),
        "dates: monday = 2026-10-05 · wednesday next week = 2026-10-07"
    );
    // a bare "next" is the Monday of next week even from a Sunday
    assert_eq!(
        line_on("2026-09-27T09:00", "next monday"),
        "dates: next monday = 2026-09-28"
    );
}

#[test]
fn a_weekday_the_conversation_names_is_not_a_date() {
    assert_eq!(line("anything else that friday"), "");
    assert_eq!(line("the same friday"), "");
    assert_eq!(line("the monday before"), "");
    assert_eq!(line("fridays"), "");
}

#[test]
fn weeks_weekends_months_and_years() {
    assert_eq!(
        line("this week"),
        "dates: this week = 2026-09-28..2026-10-04"
    );
    assert_eq!(
        line("next week"),
        "dates: next week = 2026-10-05..2026-10-11"
    );
    assert_eq!(
        line("last week"),
        "dates: last week = 2026-09-21..2026-09-27"
    );
    assert_eq!(
        line("the week after next"),
        "dates: the week after next = 2026-10-12..2026-10-18"
    );
    assert_eq!(
        line("the week before last"),
        "dates: the week before last = 2026-09-14..2026-09-20"
    );
    assert_eq!(
        line("this weekend"),
        "dates: this weekend = 2026-10-03..2026-10-04"
    );
    assert_eq!(
        line("next weekend"),
        "dates: next weekend = 2026-10-10..2026-10-11"
    );
    assert_eq!(
        line("last weekend"),
        "dates: last weekend = 2026-09-26..2026-09-27"
    );
    assert_eq!(
        line("over the weekend"),
        "dates: the weekend = 2026-10-03..2026-10-04"
    );
    assert_eq!(
        line("this month"),
        "dates: this month = 2026-10-01..2026-10-31"
    );
    assert_eq!(
        line("next month"),
        "dates: next month = 2026-11-01..2026-11-30"
    );
    assert_eq!(
        line("last month"),
        "dates: last month = 2026-09-01..2026-09-30"
    );
    assert_eq!(
        line("this year"),
        "dates: this year = 2026-01-01..2026-12-31"
    );
    assert_eq!(
        line("last year"),
        "dates: last year = 2025-01-01..2025-12-31"
    );
    assert_eq!(
        line("next year"),
        "dates: next year = 2027-01-01..2027-12-31"
    );
}

#[test]
fn a_named_month_with_last_next_or_this_has_one_reading() {
    assert_eq!(
        line("last november"),
        "dates: last november = 2025-11-01..2025-11-30"
    );
    assert_eq!(
        line("next march"),
        "dates: next march = 2027-03-01..2027-03-31"
    );
    assert_eq!(
        line("this november"),
        "dates: this november = 2026-11-01..2026-11-30"
    );
    assert_eq!(
        line("the november before last"),
        "dates: the november before last = 2024-11-01..2024-11-30"
    );
}

#[test]
fn a_bare_month_has_the_nearest_one_behind_and_the_nearest_one_ahead() {
    assert_eq!(
        line("what's due in november"),
        "dates: november = 2025-11-01..2025-11-30 (past) / 2026-11-01..2026-11-30 (upcoming)"
    );
    assert_eq!(
        line("since september"),
        "dates: september = 2026-09-01..2026-09-30 (past) / 2027-09-01..2027-09-30 (upcoming)"
    );
    // this month is the one reading
    assert_eq!(
        line("anything in october"),
        "dates: october = 2026-10-01..2026-10-31"
    );
    assert_eq!(
        line("march 2027"),
        "dates: march 2027 = 2027-03-01..2027-03-31"
    );
}

#[test]
fn month_names_that_are_also_names_need_a_word_that_says_month() {
    assert_eq!(
        line("renews in june"),
        "dates: june = 2026-06-01..2026-06-30 (past) / 2027-06-01..2027-06-30 (upcoming)"
    );
    assert_eq!(
        line("pics from march to may"),
        "dates: march = 2026-03-01..2026-03-31 (past) / 2027-03-01..2027-03-31 (upcoming) · may = 2026-05-01..2026-05-31 (past) / 2027-05-01..2027-05-31 (upcoming)"
    );
    assert_eq!(line("call june"), "");
    assert_eq!(line("may i"), "");
    assert_eq!(line("this may help"), "");
}

#[test]
fn a_year_after_a_word_that_says_so_is_that_whole_year() {
    assert_eq!(line("in 2024"), "dates: 2024 = 2024-01-01..2024-12-31");
    assert_eq!(
        line("anything since 2023"),
        "dates: 2023 = 2023-01-01..2023-12-31"
    );
    assert_eq!(line("pay 2024 dollars"), "");
}

#[test]
fn a_month_and_day_without_a_year_has_a_past_and_an_upcoming_reading() {
    // the brief's example: past and upcoming differ
    assert_eq!(
        line("sept first"),
        "dates: sept first = 2026-09-01 (past) / 2027-09-01 (upcoming)"
    );
    assert_eq!(
        line("dec 11"),
        "dates: dec 11 = 2025-12-11 (past) / 2026-12-11 (upcoming)"
    );
    assert_eq!(
        line("the 3rd of may"),
        "dates: the 3rd of may = 2026-05-03 (past) / 2027-05-03 (upcoming)"
    );
    assert_eq!(
        line("14 oct"),
        "dates: 14 oct = 2025-10-14 (past) / 2026-10-14 (upcoming)"
    );
    assert_eq!(
        line("twenty-fifth june"),
        "dates: twenty-fifth june = 2026-06-25 (past) / 2027-06-25 (upcoming)"
    );
    assert_eq!(
        line("thirty first of december"),
        "dates: thirty first of december = 2025-12-31 (past) / 2026-12-31 (upcoming)"
    );
    // a weekday beside the day of the month only decorates it
    assert_eq!(
        line("friday dec 11"),
        "dates: friday dec 11 = 2025-12-11 (past) / 2026-12-11 (upcoming)"
    );
    // today is the one reading
    assert_eq!(line("october 2"), "dates: october 2 = 2026-10-02");
    // a leap day comes round every fourth year
    assert_eq!(
        line("feb 29"),
        "dates: feb 29 = 2024-02-29 (past) / 2028-02-29 (upcoming)"
    );
    // a day that no year has leaves the month; a count is not a day
    assert_eq!(
        line("feb 30"),
        "dates: feb = 2026-02-01..2026-02-28 (past) / 2027-02-01..2027-02-28 (upcoming)"
    );
    assert_eq!(line("may 3 people"), "");
}

#[test]
fn a_year_with_the_month_and_day_is_that_date() {
    assert_eq!(
        line("december 11th 2025"),
        "dates: december 11th 2025 = 2025-12-11"
    );
}

#[test]
fn a_bare_day_of_the_month_has_a_past_and_an_upcoming_reading() {
    assert_eq!(
        line("the 25th"),
        "dates: the 25th = 2026-09-25 (past) / 2026-10-25 (upcoming)"
    );
    assert_eq!(
        line("by the thirty-first"),
        "dates: the thirty-first = 2026-08-31 (past) / 2026-10-31 (upcoming)"
    );
    assert_eq!(
        line("the twenty-ninth"),
        "dates: the twenty-ninth = 2026-09-29 (past) / 2026-10-29 (upcoming)"
    );
    // the second today
    assert_eq!(line("on the 2nd"), "dates: the 2nd = 2026-10-02");
    // a small one is a date when nothing it counts follows it
    assert_eq!(
        line("due on the fifth altogether"),
        "dates: the fifth = 2026-09-05 (past) / 2026-10-05 (upcoming)"
    );
    // and a position when a noun follows, or "one", "of" and "two"
    assert_eq!(line("the 3rd meeting"), "");
    assert_eq!(line("the second one"), "");
    assert_eq!(line("the fifth of those"), "");
    assert_eq!(line("due first"), "");
}

#[test]
fn offsets_from_now() {
    // the brief's example
    assert_eq!(line("in two weeks"), "dates: in two weeks = 2026-10-16");
    assert_eq!(line("in 3 days"), "dates: in 3 days = 2026-10-05");
    assert_eq!(line("three days ago"), "dates: three days ago = 2026-09-29");
    assert_eq!(
        line("a week from today"),
        "dates: a week from today = 2026-10-09"
    );
    assert_eq!(
        line("a week ago"),
        "dates: a week ago = 2026-09-25 (day) / 2026-09-21..2026-09-27 (week)"
    );
    assert_eq!(
        line("two weeks ago"),
        "dates: two weeks ago = 2026-09-18 (day) / 2026-09-14..2026-09-20 (week)"
    );
    assert_eq!(
        line("two months ago"),
        "dates: two months ago = 2026-08-01..2026-08-31"
    );
    assert_eq!(
        line("the last 7 days"),
        "dates: the last 7 days = 2026-09-26..2026-10-02"
    );
    assert_eq!(
        line("the past three days"),
        "dates: the past three days = 2026-09-30..2026-10-02"
    );
}

#[test]
fn offsets_in_hours_and_minutes_start_from_the_clock_of_now() {
    assert_eq!(line("in an hour"), "dates: in an hour = 2026-10-02 10:00");
    assert_eq!(
        line("in 30 minutes"),
        "dates: in 30 minutes = 2026-10-02 09:30"
    );
    assert_eq!(
        line("in half an hour"),
        "dates: in half an hour = 2026-10-02 09:30"
    );
    assert_eq!(line("an hour ago"), "dates: an hour ago = 2026-10-02 08:00");
    assert_eq!(
        line_on("2026-10-02T23:30", "in two hours"),
        "dates: in two hours = 2026-10-03 01:30"
    );
}

#[test]
fn clock_times_with_a_meridiem_or_a_24_hour_clock_are_as_written() {
    assert_eq!(line("9pm"), "dates: 9pm = 21:00");
    assert_eq!(line("at 9pm"), "dates: at 9pm = 21:00");
    assert_eq!(line("at 7am"), "dates: at 7am = 07:00");
    assert_eq!(line("at 6:30 pm"), "dates: at 6:30 pm = 18:30");
    assert_eq!(line("at 12am"), "dates: at 12am = 00:00");
    assert_eq!(line("19:00"), "dates: 19:00 = 19:00");
    assert_eq!(line("at 07:30"), "dates: at 07:30 = 07:30");
    assert_eq!(line("noon"), "dates: noon = 12:00");
    assert_eq!(line("lunchtime"), "dates: lunchtime = 12:00");
    assert_eq!(line("midday"), "dates: midday = 12:00");
}

#[test]
fn a_bare_hour_reads_both_ways_except_12() {
    // SPEC §14, "at N": the line lists the morning and the afternoon reading, the pick is the
    // call's (`ground.rs`, `bare_hour`)
    for (message, clock) in [
        ("at 1", "13:00 (pm) / 01:00 (am)"),
        ("at 2", "14:00 (pm) / 02:00 (am)"),
        ("at 3", "15:00 (pm) / 03:00 (am)"),
        ("at 7", "19:00 (pm) / 07:00 (am)"),
        ("at 9", "09:00 (am) / 21:00 (pm)"),
        ("at 10", "10:00 (am) / 22:00 (pm)"),
        ("at 11", "11:00 (am) / 23:00 (pm)"),
        ("at 12", "12:00"),
        ("to 5", "17:00 (pm) / 05:00 (am)"),
        ("till 10", "10:00 (am) / 22:00 (pm)"),
        ("by 6", "18:00 (pm) / 06:00 (am)"),
        ("at 7:30", "19:30 (pm) / 07:30 (am)"),
        ("at 9.40", "09:40 (am) / 21:40 (pm)"),
        ("at five", "17:00 (pm) / 05:00 (am)"),
    ] {
        assert_eq!(
            line(message),
            format!("dates: {message} = {clock}"),
            "{message}"
        );
    }
}

#[test]
fn a_bare_8_reads_both_ways() {
    assert_eq!(line("at 8"), "dates: at 8 = 20:00 (pm) / 08:00 (am)");
    assert_eq!(
        line("make it 8"),
        "dates: make it 8 = 20:00 (pm) / 08:00 (am)"
    );
    assert_eq!(line("to 8:30"), "dates: to 8:30 = 20:30 (pm) / 08:30 (am)");
}

#[test]
fn the_message_decides_a_bare_hour_before_the_rule_does() {
    assert_eq!(line("dinner at 8"), "dates: at 8 = 20:00");
    assert_eq!(line("drinks at 9"), "dates: at 9 = 21:00");
    assert_eq!(
        line("tonight at 11"),
        "dates: tonight = 2026-10-02 · at 11 = 23:00"
    );
    assert_eq!(line("movie at 3"), "dates: at 3 = 15:00");
    assert_eq!(line("breakfast at 7"), "dates: at 7 = 07:00");
    assert_eq!(
        line("tomorrow morning at 6"),
        "dates: tomorrow = 2026-10-03 · at 6 = 06:00"
    );
    assert_eq!(
        line("at 9 last night"),
        "dates: at 9 = 21:00 · last night = 2026-10-01"
    );
}

#[test]
fn each_clock_follows_the_nearest_word_that_says_evening_or_morning() {
    assert_eq!(
        line("tonight at 8 and tomorrow morning at 6"),
        "dates: tonight = 2026-10-02 · at 8 = 20:00 · tomorrow = 2026-10-03 · at 6 = 06:00"
    );
}

#[test]
fn a_word_after_at_that_is_not_an_hour_is_not_a_clock() {
    for message in [
        "she is at a conference",
        "at one point",
        "look at one of them",
        "at an angle",
    ] {
        assert_eq!(line(message), "", "{message:?}");
    }
    assert_eq!(
        line("lunch is at one"),
        "dates: at one = 13:00 (pm) / 01:00 (am)"
    );
}

#[test]
fn half_and_quarter_hours() {
    assert_eq!(line("half 5"), "dates: half 5 = 17:30 (pm) / 05:30 (am)");
    assert_eq!(line("at half 7"), "dates: half 7 = 19:30 (pm) / 07:30 (am)");
    assert_eq!(
        line("half past 2"),
        "dates: half past 2 = 14:30 (pm) / 02:30 (am)"
    );
    assert_eq!(
        line("quarter to 4"),
        "dates: quarter to 4 = 15:45 (pm) / 03:45 (am)"
    );
    assert_eq!(
        line("quarter past 4"),
        "dates: quarter past 4 = 16:15 (pm) / 04:15 (am)"
    );
    // a word that says the time of day settles them
    assert_eq!(line("dinner at half 7"), "dates: half 7 = 19:30");
    // "half an hour" is a length, not a clock
    assert_eq!(line("under half an hour"), "");
}

#[test]
fn a_range_of_hours_never_ends_before_it_starts() {
    assert_eq!(
        line("friday 7 to 9"),
        "dates: friday = 2026-10-02 · 7 to 9 = 19:00..21:00"
    );
    assert_eq!(
        line("friday 7 till 10"),
        "dates: friday = 2026-10-02 · 7 till 10 = 19:00..22:00"
    );
    assert_eq!(line("from 9 to 5pm"), "dates: 9 to 5pm = 09:00..17:00");
    assert_eq!(line("2 to 4pm"), "dates: 2 to 4pm = 14:00..16:00");
    assert_eq!(line("from 12 to 1"), "dates: 12 to 1 = 12:00..13:00");
    // a count of things is not a range of hours
    assert_eq!(line("add 3 to 5 lists"), "");
}

#[test]
fn a_date_and_its_clock_are_two_entries() {
    assert_eq!(
        line("tomorrow at 3pm"),
        "dates: tomorrow = 2026-10-03 · at 3pm = 15:00"
    );
    assert_eq!(
        line("next monday at 2"),
        "dates: next monday = 2026-10-05 · at 2 = 14:00 (pm) / 02:00 (am)"
    );
    // the brief's line, entry by entry
    assert_eq!(
        entries("next tuesday, tomorrow, 9pm, sept first, last week, in two weeks"),
        [
            "next tuesday = 2026-10-06",
            "tomorrow = 2026-10-03",
            "9pm = 21:00",
            "sept first = 2026-09-01 (past) / 2027-09-01 (upcoming)",
            "last week = 2026-09-21..2026-09-27",
            "in two weeks = 2026-10-16",
        ]
    );
}

#[test]
fn the_end_of_a_month() {
    assert_eq!(
        line("by the end of the month"),
        "dates: end of the month = 2026-10-31"
    );
    assert_eq!(line("end of month"), "dates: end of month = 2026-10-31");
    assert_eq!(
        line("end of next month"),
        "dates: end of next month = 2026-11-30"
    );
    assert_eq!(
        line("end of last month"),
        "dates: end of last month = 2026-09-30"
    );
    assert_eq!(
        line("end of march"),
        "dates: end of march = 2026-03-31 (past) / 2027-03-31 (upcoming)"
    );
    assert_eq!(line("end of october"), "dates: end of october = 2026-10-31");
}

#[test]
fn overdue_is_up_to_yesterday() {
    assert_eq!(line("what's overdue"), "dates: overdue = ..2026-10-01");
}

#[test]
fn at_most_six_phrases_are_listed() {
    let message = "mon tue wed thu fri sat sun and next monday, next tuesday, next friday, next sat, yesterday, tomorrow, today";
    let read = read_dates(message, dates::parse_now(FRIDAY).expect("a date"));
    assert_eq!(read.len(), DATES_CAP);
}

#[test]
fn a_clock_needs_the_word_that_says_it_is_a_time() {
    for message in [
        "3 people",
        "at 3 people",
        "at 28 weeks",
        "at 26 degrees",
        "rename it to 14 cardigan rd",
        "for 20 kids",
        "pay 9.40 for lunch",
        "we are 5",
        "5 to 6 people",
    ] {
        assert_eq!(line(message), "", "{message:?}");
    }
}

#[test]
fn every_phrase_of_the_table_reads_back_to_its_expressions_resolution() {
    // phrases that need what the line does not have: a row to move, a span
    // whose ends are two phrases, a date the person typed in full
    let exempt = [
        "since last june",
        "from monday to wednesday next week",
        "between now and friday",
        "on 2026-10-14",
    ];
    let mut checked = 0;
    for row in PHRASES {
        if row.row.is_some() || exempt.contains(&row.phrase) {
            continue;
        }
        let now = dates::parse_now(row.today).expect("a date");
        let resolved = eval_at(row.expr, row.today, None).expect("evaluates");
        let read = read_dates(row.phrase, now);
        let resolutions: Vec<&str> = read.iter().map(|r| r.resolution.as_str()).collect();
        let found = |text: &str| {
            resolutions
                .iter()
                .any(|resolution| resolution.contains(text))
        };
        let (day, clock) = match resolved {
            Resolved::At(at) if row.expr.contains("\"time\"") => {
                (at.date().to_string(), Some(dates::clock(at.time())))
            }
            other => (other.plain(), None),
        };
        assert!(
            found(&day),
            "\"{}\" on {}: want {day}, the line says {resolutions:?}",
            row.phrase,
            row.today
        );
        if let Some(clock) = clock {
            assert!(
                found(&clock),
                "\"{}\" on {}: want {clock}, the line says {resolutions:?}",
                row.phrase,
                row.today
            );
        }
        checked += 1;
    }
    assert!(checked >= 70, "{checked} phrases checked");
}

proptest! {
    /// A line never contradicts the evaluator: a weekday phrase resolves to
    /// the day the expression it stands for evaluates to, on any day.
    #[test]
    fn a_weekday_phrase_is_the_evaluators_day(offset in 0_i64..3000, weekday in 1_i8..=7) {
        let today = day(offset);
        let now = format!("{today}T09:00");
        let name = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][usize::try_from(weekday - 1).unwrap()];
        for (phrase, rel) in [("next", 1_i64), ("last", -1)] {
            let want = eval_at(&format!(r#"{{"unit":"week","rel":{rel},"weekday":{weekday}}}"#), &now, None).unwrap().plain();
            prop_assert_eq!(line_on(&now, &format!("{phrase} {name}")), format!("dates: {phrase} {name} = {want}"));
        }
        // a bare weekday holds the evaluator's this-week day, and its next one when that has gone by
        let this = eval_at(&format!(r#"{{"unit":"week","rel":0,"weekday":{weekday}}}"#), &now, None).unwrap();
        let next = eval_at(&format!(r#"{{"unit":"week","rel":1,"weekday":{weekday}}}"#), &now, None).unwrap();
        let said = line_on(&now, name);
        let this_text = this.plain();
        if this_text.as_str() < today.to_string().as_str() {
            prop_assert_eq!(said, format!("dates: {name} = {this_text} (past) / {} (upcoming)", next.plain()));
        } else {
            prop_assert_eq!(said, format!("dates: {name} = {this_text}"));
        }
    }

    #[test]
    fn a_relative_phrase_is_the_evaluators_range(offset in 0_i64..3000) {
        let today = day(offset);
        let now = format!("{today}T09:00");
        for (phrase, expr) in [
            ("this week", r#"{"unit":"week","rel":0}"#),
            ("next week", r#"{"unit":"week","rel":1}"#),
            ("last week", r#"{"unit":"week","rel":-1}"#),
            ("last month", r#"{"unit":"month","rel":-1}"#),
            ("next month", r#"{"unit":"month","rel":1}"#),
            ("this year", r#"{"unit":"year","rel":0}"#),
            ("tomorrow", r#"{"unit":"day","rel":1}"#),
            ("yesterday", r#"{"unit":"day","rel":-1}"#),
            ("in two weeks", r#"{"unit":"day","rel":14}"#),
            ("last november", r#"{"unit":"month","name":11,"rel":-1}"#),
            ("next march", r#"{"unit":"month","name":3,"rel":1}"#),
            ("this weekend", r#"{"from":{"unit":"week","rel":0,"weekday":6},"to":{"unit":"week","rel":0,"weekday":7}}"#),
        ] {
            let want = eval_at(expr, &now, None).unwrap().plain();
            prop_assert_eq!(line_on(&now, phrase), format!("dates: {phrase} = {want}"));
        }
    }

    /// A month and day, or a day of the month, brackets today: the past
    /// reading is on or before it, the upcoming one on or after it.
    #[test]
    fn the_past_reading_is_not_after_today_and_the_upcoming_one_is_not_before(offset in 0_i64..3000, month in 1_i8..=12, day_of in 1_i8..=28) {
        let today = day(offset);
        let now = format!("{today}T09:00");
        let names = ["jan", "feb", "march", "apr", "may", "june", "july", "aug", "sept", "oct", "nov", "dec"];
        let message = format!("{} {day_of}", names[usize::try_from(month - 1).unwrap()]);
        let said = line_on(&now, &message);
        let dates: Vec<&str> = said.split(|c: char| !(c.is_ascii_digit() || c == '-')).filter(|part| part.len() == 10).collect();
        prop_assert!(!dates.is_empty() && dates.len() <= 2, "{said}");
        let today = today.to_string();
        if let [only] = dates.as_slice() {
            prop_assert_eq!(*only, today.as_str());
        } else {
            prop_assert!(dates[0] < today.as_str() && today.as_str() < dates[1], "{said}");
        }
    }
}

proptest! {
    /// The reader takes any text: no panic, at most `DATES_CAP` entries, each
    /// phrase non-empty and each resolution a date, a range or a clock.
    #[test]
    fn the_reader_takes_any_text(message in "\\PC{0,120}") {
        let read = read_dates(&message, dates::parse_now(FRIDAY).unwrap());
        prop_assert!(read.len() <= DATES_CAP);
        for reading in &read {
            prop_assert!(!reading.phrase.is_empty() && !reading.resolution.is_empty());
        }
    }

    /// The same over words the reader knows, in any order and spacing.
    #[test]
    fn the_reader_takes_any_run_of_date_words(
        words in prop::collection::vec(
            prop::sample::select(vec![
                "next", "last", "this", "the", "of", "at", "to", "till", "until", "by", "from",
                "monday", "friday", "sat", "sun", "week", "weekend", "month", "year", "ago",
                "in", "a", "an", "two", "3", "12", "9pm", "7:30", "9.40", "half", "past",
                "quarter", "noon", "end", "may", "march", "dec", "sept", "first", "second",
                "twenty", "fifth", "25th", "31st", "2024", "today", "tomorrow", "night",
                "overdue", "hours", "days", "weeks", "months", "before", "after", "make", "it",
                ",", ".", "-", "pm", "am", "o'clock", "friday's",
            ]),
            0..14,
        ),
        today in 0_i64..3000,
    ) {
        let message = words.join(" ");
        let now = format!("{}T09:00", day(today));
        let read = read_dates(&message, dates::parse_now(&now).unwrap());
        prop_assert!(read.len() <= DATES_CAP);
        for reading in &read {
            prop_assert!(!reading.phrase.is_empty() && !reading.resolution.is_empty(), "{message}");
        }
    }
}
