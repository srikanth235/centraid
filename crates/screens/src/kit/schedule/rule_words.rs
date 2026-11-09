//! THE ONE RECURRENCE SENTENCE (owner decision on #1173): a rule's words,
//! said once for every surface.
//!
//! The vault answers what a rule IS ([`centraid_vault::time::rrule::shape`]:
//! frequency, step, weekdays with their ordinals, month days, months, set
//! positions, end) and holds no English. This module turns that shape into
//! words through `strings::agenda_repeat`, and it is what BOTH the Custom
//! repeat sheet's live summary (a [`super::editor`] spec turned into a shape)
//! and the sentence of a stored rule (an event's detail, a task row, the
//! editor's Repeat row) say. A second summariser anywhere is the defect this
//! exists to prevent (#834), and a raw RRULE string is never shown to a member.

use centraid_vault::time::rrule::{self, DAY_TOKENS, DayRule, Freq, RuleShape, ShapeEnd};

use crate::kit::civil;
use crate::strings::agenda_repeat as words;
use crate::strings::{Locale, agenda as day_words, fill};

/// The full name of a weekday token: `Monday`.
#[must_use]
pub fn weekday_full(locale: Locale, token: &str) -> String {
    match token {
        "MO" => day_words::weekday_full_mon(locale),
        "TU" => day_words::weekday_full_tue(locale),
        "WE" => day_words::weekday_full_wed(locale),
        "TH" => day_words::weekday_full_thu(locale),
        "FR" => day_words::weekday_full_fri(locale),
        "SA" => day_words::weekday_full_sat(locale),
        _ => day_words::weekday_full_sun(locale),
    }
}

/// `a`, `a and b`, `a, b and c`.
#[must_use]
pub fn join(locale: Locale, items: &[String]) -> String {
    match items {
        [] => String::new(),
        [only] => only.clone(),
        [rest @ .., last] => {
            let head = rest.iter().skip(1).fold(rest[0].clone(), |text, item| {
                fill(&words::list_comma(locale), &[("a", &text), ("b", item)])
            });
            fill(
                &words::list_last(locale),
                &[("rest", &head), ("last", last)],
            )
        }
    }
}

/// `first`, `second` … `fifth`, `last`, `second to last`; past five, `20th`.
#[must_use]
pub fn ordinal_word(locale: Locale, ordinal: i64) -> String {
    let n = ordinal.unsigned_abs();
    let positive = match n {
        1 => words::ordinal_first(locale),
        2 => words::ordinal_second(locale),
        3 => words::ordinal_third(locale),
        4 => words::ordinal_fourth(locale),
        5 => words::ordinal_fifth(locale),
        _ => civil::ordinal(u32::try_from(n).unwrap_or(0)),
    }
    .to_lowercase();
    match (ordinal < 0, n) {
        (true, 1) => words::ordinal_last(locale).to_lowercase(),
        (true, _) => fill(&words::ordinal_to_last(locale), &[("ordinal", &positive)]),
        (false, _) => positive,
    }
}

fn weekday_of(locale: Locale, day: DayRule) -> String {
    weekday_full(locale, day.token())
}

fn days_joined(locale: Locale, days: &[DayRule]) -> String {
    let names: Vec<String> = days.iter().map(|day| weekday_of(locale, *day)).collect();
    join(locale, &names)
}

fn the_list(locale: Locale, items: &[String]) -> String {
    fill(
        &words::the_items(locale),
        &[("items", &join(locale, items))],
    )
}

fn clause(template: String, items: &str) -> String {
    fill(&template, &[("items", items)])
}

/// "the 1st, 15th and last day": a `BYMONTHDAY` list.
fn month_day_items(locale: Locale, days: &[i64]) -> String {
    let items: Vec<String> = days
        .iter()
        .map(|day| match *day {
            -1 => words::last_day(locale).to_lowercase(),
            day if day < 0 => fill(
                &words::day_to_last(locale),
                &[("ordinal", &civil::ordinal(u32::try_from(-day).unwrap_or(0)))],
            ),
            day => civil::ordinal(u32::try_from(day).unwrap_or(0)),
        })
        .collect();
    the_list(locale, &items)
}

/// "the second Monday and each Friday": a `BYDAY` list with ordinals.
fn by_day_items(locale: Locale, days: &[DayRule]) -> String {
    let mut items: Vec<String> = days
        .iter()
        .filter_map(|day| {
            day.ordinal.map(|ordinal| {
                fill(
                    &words::nth_weekday(locale),
                    &[
                        ("ordinal", &ordinal_word(locale, ordinal)),
                        ("weekday", &weekday_of(locale, *day)),
                    ],
                )
            })
        })
        .collect();
    let plain: Vec<DayRule> = days
        .iter()
        .filter(|day| day.ordinal.is_none())
        .copied()
        .collect();
    if !plain.is_empty() {
        items.push(fill(
            &words::each_weekdays(locale),
            &[("days", &days_joined(locale, &plain))],
        ));
    }
    join(locale, &items)
}

/// "the last weekday", "the first and third Friday": a `BYSETPOS` list over
/// the days `BYDAY` names.
fn set_position_items(locale: Locale, shape: &RuleShape) -> String {
    let mut positions = shape.set_positions.clone();
    positions.sort_by_key(|pos| (*pos < 0, pos.abs()));
    let ordinals = join(
        locale,
        &positions
            .iter()
            .map(|pos| ordinal_word(locale, *pos))
            .collect::<Vec<_>>(),
    );
    let mut sorted: Vec<u8> = shape.weekdays.iter().map(|day| day.day).collect();
    sorted.sort_unstable();
    sorted.dedup();
    match (shape.weekdays.is_empty(), sorted.as_slice()) {
        (true, _) => fill(&words::set_any_day(locale), &[("ordinals", &ordinals)]),
        (_, [1, 2, 3, 4, 5]) => fill(&words::set_weekday(locale), &[("ordinals", &ordinals)]),
        (_, [0, 6]) => fill(&words::set_weekend_day(locale), &[("ordinals", &ordinals)]),
        (_, [single]) => fill(
            &words::nth_weekday(locale),
            &[
                ("ordinal", &ordinals),
                (
                    "weekday",
                    &weekday_full(locale, DAY_TOKENS[usize::from(*single) % 7]),
                ),
            ],
        ),
        _ => fill(
            &words::set_of_days(locale),
            &[
                ("ordinals", &ordinals),
                ("days", &days_joined(locale, &shape.weekdays)),
            ],
        ),
    }
}

/// "Every 2 weeks", "Every month": the frequency's opening words.
fn head(locale: Locale, shape: &RuleShape) -> String {
    let steps = u64::try_from(shape.interval.max(1)).unwrap_or(1);
    match shape.freq {
        Freq::Daily => words::every_days(locale, steps),
        Freq::Weekly => words::every_weeks(locale, steps),
        Freq::Monthly => words::every_months(locale, steps),
        Freq::Yearly => words::every_years(locale, steps),
    }
}

fn cadence(locale: Locale, shape: &RuleShape) -> String {
    let mut clauses: Vec<String> = Vec::new();
    let plain_days =
        !shape.weekdays.is_empty() && shape.weekdays.iter().all(|day| day.ordinal.is_none());
    if shape.set_positions.is_empty() {
        if !shape.weekdays.is_empty() {
            let in_a_week =
                matches!(shape.freq, Freq::Daily | Freq::Weekly) || !shape.week_numbers.is_empty();
            let text = if plain_days && in_a_week {
                days_joined(locale, &shape.weekdays)
            } else {
                by_day_items(locale, &shape.weekdays)
            };
            clauses.push(clause(words::clause_on(locale), &text));
        }
        if !shape.month_days.is_empty() {
            let template = if shape.weekdays.is_empty() {
                words::clause_on(locale)
            } else {
                words::clause_when(locale)
            };
            clauses.push(clause(
                template,
                &month_day_items(locale, &shape.month_days),
            ));
        }
    } else {
        clauses.push(clause(
            words::clause_on(locale),
            &set_position_items(locale, shape),
        ));
        if !shape.month_days.is_empty() {
            clauses.push(clause(
                words::clause_among(locale),
                &month_day_items(locale, &shape.month_days),
            ));
        }
    }
    if !shape.year_days.is_empty() {
        let items: Vec<String> = shape
            .year_days
            .iter()
            .map(|day| match *day {
                -1 => words::ordinal_last(locale).to_lowercase(),
                day if day < 0 => fill(
                    &words::ordinal_to_last(locale),
                    &[("ordinal", &civil::ordinal(u32::try_from(-day).unwrap_or(0)))],
                ),
                day => civil::ordinal(u32::try_from(day).unwrap_or(0)),
            })
            .collect();
        clauses.push(clause(
            words::clause_year_days(locale),
            &join(locale, &items),
        ));
    }
    if !shape.week_numbers.is_empty() {
        let items: Vec<String> = shape
            .week_numbers
            .iter()
            .map(|week| match *week {
                -1 => words::week_last(locale),
                week if week < 0 => fill(
                    &words::week_to_last(locale),
                    &[(
                        "ordinal",
                        &civil::ordinal(u32::try_from(-week).unwrap_or(0)),
                    )],
                ),
                week => fill(&words::week_number(locale), &[("n", &week.to_string())]),
            })
            .collect();
        clauses.push(clause(words::clause_in(locale), &join(locale, &items)));
    }
    if !shape.months.is_empty() {
        let months: Vec<String> = shape
            .months
            .iter()
            .filter_map(|month| u32::try_from(*month).ok())
            .map(|month| civil::month_name(locale, month))
            .collect();
        clauses.push(clause(words::clause_in(locale), &join(locale, &months)));
    }
    let opening = head(locale, shape);
    if clauses.is_empty() {
        return opening;
    }
    format!("{opening} {}", clauses.join(" "))
}

/// "Thursday 31 December 2026": the day a rule ends on, with its year (a rule
/// read years later has to say which December).
fn until_label(locale: Locale, year: i64, month: u32, day: u32) -> String {
    let stamp = format!("{year:04}-{month:02}-{day:02}");
    let token = match civil::iso_weekday_of(&stamp) {
        Some(1) => "MO",
        Some(2) => "TU",
        Some(3) => "WE",
        Some(4) => "TH",
        Some(5) => "FR",
        Some(6) => "SA",
        Some(7) => "SU",
        _ => return stamp,
    };
    fill(
        &words::until_date(locale),
        &[
            ("weekday", &weekday_full(locale, token)),
            ("day", &day.to_string()),
            ("month", &civil::month_name(locale, month)),
            ("year", &year.to_string()),
        ],
    )
}

/// THE SENTENCE A SHAPE SAYS: "Every 2 weeks on Monday and Friday, until
/// Thursday 31 December".
#[must_use]
pub fn sentence(locale: Locale, shape: &RuleShape) -> String {
    let cadence = cadence(locale, shape);
    match shape.end {
        ShapeEnd::Never => cadence,
        ShapeEnd::Until { year, month, day } => fill(
            &words::ending_until(locale),
            &[
                ("cadence", &cadence),
                ("day", &until_label(locale, year, month, day)),
            ],
        ),
        ShapeEnd::Count(count) => fill(
            &words::ending_count(locale, u64::try_from(count.max(1)).unwrap_or(1)),
            &[("cadence", &cadence)],
        ),
    }
}

/// The sentence a stored RRULE says, or `None` when the rule does not parse
/// (the caller says "Custom" or nothing; it never shows the rule).
#[must_use]
pub fn of_rule(locale: Locale, rule: &str) -> Option<String> {
    rrule::shape(rule).map(|shape| sentence(locale, &shape))
}

/// What a surface that SHOWS a stored rule says: its sentence, or "Custom"
/// for a rule that no longer parses (an old or imported rule): the rule is
/// never shown raw and the screen still draws.
#[must_use]
pub fn stored(locale: Locale, rule: &str) -> String {
    of_rule(locale, rule).unwrap_or_else(|| crate::strings::agenda_editor::repeat_custom(locale))
}

/// Whether a stored rule is a series the engine expands.
#[must_use]
pub fn repeats(rule: Option<&str>) -> bool {
    rule.is_some_and(|rule| rrule::shape(rule).is_some())
}
