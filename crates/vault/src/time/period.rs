//! THE PERIOD WALK: which civil DAYS an RFC 5545 rule selects in one period
//! of its frequency (#1173).
//!
//! The expander ([`super::recurrence`]) steps period by period (the day, week,
//! month or year the rule's `INTERVAL` lands on), asks this module for that
//! period's days, then carries the anchor's wall clock onto each. Everything
//! here is DAY arithmetic on the proleptic Gregorian calendar: no zone, no
//! clock, no instant, which is why a DST change cannot touch it.
//!
//! ## RFC 5545's order, and how this module follows it
//!
//! Within a period the candidate days are the period's own days, narrowed by
//! every `BYxxx` part the rule carries: `BYMONTH`, `BYWEEKNO`, `BYYEARDAY`,
//! `BYMONTHDAY`, `BYDAY`. The RFC's table splits each part into "expand" (it
//! adds days to the period) and "limit" (it removes them); starting from ALL
//! of the period's days and filtering is the same set, because a part that
//! expands under one frequency only ever names days inside the period. Then
//! `BYSETPOS` picks positions out of that sorted set, and only afterwards does
//! the expander drop days before `DTSTART` and count.
//!
//! ## What a rule names nothing for
//!
//! "Information not contained in the rule is derived from DTSTART": a rule with
//! no day-level part takes its day from the anchor (the day of the month for
//! MONTHLY and YEARLY, the weekday for WEEKLY, the month for YEARLY), and a
//! `BYWEEKNO` with no day beside it takes the anchor's weekday. The anchor's
//! day of the month is CLAMPED to the month's length (an implied 31st is the
//! 30th in April); a day a rule names with `BYMONTHDAY` never is.
//!
//! ## Weeks
//!
//! A week starts on `WKST` (Monday by default). Week 1 of a year is the first
//! week holding at least four days of it, which is the week holding January
//! 4th, for every `WKST`. Under `BYWEEKNO` a YEARLY period is that WEEK-year,
//! so week 1 may start in the previous December and week 52 or 53 may end in
//! January; the year has 53 weeks when the next week 1 starts 53 weeks on.

use super::rrule::{DayRule, Freq, ParsedRrule};
use super::zone::days_in_month;
use crate::clock::{civil_from_days, days_from_civil};

/// The calendar years the engine walks. RFC 5545's dates are four digits.
const LAST_YEAR: i64 = 9999;

/// 0 = Sunday ... 6 = Saturday, for a day number.
const fn weekday_of(day: i64) -> i64 {
    (day + 4).rem_euclid(7)
}

const fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

const fn year_length(year: i64) -> i64 {
    if is_leap(year) { 366 } else { 365 }
}

/// The first day of week 1 of `year` when weeks start on `wkst`.
fn week_one_start(year: i64, wkst: i64) -> i64 {
    let jan_fourth = days_from_civil(year, 1, 4);
    jan_fourth - (weekday_of(jan_fourth) - wkst).rem_euclid(7)
}

/// One rule, read once: the anchor, the defaults a bare rule takes from it,
/// and the facts the per-day filter needs.
#[derive(Debug, Clone)]
pub(super) struct Plan {
    freq: Freq,
    interval: i64,
    wkst: i64,
    anchor: i64,
    anchor_year: i64,
    anchor_month: i64,
    by_month: Vec<i64>,
    by_week_no: Vec<i64>,
    by_year_day: Vec<i64>,
    by_month_day: Vec<i64>,
    by_day: Vec<DayRule>,
    by_set_pos: Vec<i64>,
    /// The anchor's day of the month, taken because the rule names no day.
    implied_day: Option<i64>,
    /// Ordinals count within the YEAR (a YEARLY rule with no `BYMONTH`).
    ordinals_in_year: bool,
    /// A YEARLY period is the week-year (`BYWEEKNO`).
    week_year: bool,
}

impl Plan {
    /// `anchor` is the series' first day, as a day number since 1970-01-01.
    pub(super) fn new(rule: &ParsedRrule, anchor: i64) -> Self {
        let (anchor_year, anchor_month, anchor_dom) = civil_from_days(anchor);
        let mut plan = Self {
            freq: rule.freq,
            interval: rule.interval.max(1),
            wkst: i64::from(rule.week_start()),
            anchor,
            anchor_year,
            anchor_month,
            by_month: rule.by_month.clone(),
            by_week_no: rule.by_week_no.clone(),
            by_year_day: rule.by_year_day.clone(),
            by_month_day: rule.by_month_day.clone(),
            by_day: rule.by_day.clone(),
            by_set_pos: rule.by_set_pos.clone(),
            implied_day: None,
            ordinals_in_year: rule.freq == Freq::Yearly && rule.by_month.is_empty(),
            week_year: rule.freq == Freq::Yearly && !rule.by_week_no.is_empty(),
        };
        let names_a_day = !(plan.by_day.is_empty()
            && plan.by_month_day.is_empty()
            && plan.by_year_day.is_empty()
            && plan.by_week_no.is_empty());
        let anchor_weekday = DayRule {
            ordinal: None,
            day: u8::try_from(weekday_of(anchor)).unwrap_or(0),
        };
        if !names_a_day {
            match plan.freq {
                Freq::Daily => {}
                Freq::Weekly => plan.by_day = vec![anchor_weekday],
                Freq::Monthly => plan.implied_day = Some(anchor_dom),
                Freq::Yearly => {
                    plan.implied_day = Some(anchor_dom);
                    if plan.by_month.is_empty() {
                        plan.by_month = vec![anchor_month];
                    }
                }
            }
        } else if !plan.by_week_no.is_empty()
            && plan.by_day.is_empty()
            && plan.by_month_day.is_empty()
            && plan.by_year_day.is_empty()
        {
            plan.by_day = vec![anchor_weekday];
        }
        plan
    }

    /// The period `index` steps on: its first day, and the days it selects.
    /// `None` once the calendar runs out (year 9999), which ends the walk.
    pub(super) fn period(&self, index: i64) -> Option<(i64, Vec<i64>)> {
        let (first, last, week_no_year) = self.span(index)?;
        let mut days: Vec<i64> = (first..=last)
            .filter(|day| self.selects(*day, week_no_year))
            .collect();
        if !self.by_set_pos.is_empty() {
            let len = i64::try_from(days.len()).unwrap_or(0);
            let mut picked: Vec<i64> = self
                .by_set_pos
                .iter()
                .filter_map(|pos| {
                    let at = if *pos > 0 { pos - 1 } else { len + pos };
                    usize::try_from(at)
                        .ok()
                        .and_then(|at| days.get(at).copied())
                })
                .collect();
            picked.sort_unstable();
            picked.dedup();
            days = picked;
        }
        Some((first, days))
    }

    /// The first and last day of period `index`, and the week-year when the
    /// period is one.
    fn span(&self, index: i64) -> Option<(i64, i64, Option<i64>)> {
        let steps = index.checked_mul(self.interval)?;
        match self.freq {
            Freq::Daily => {
                let day = self.anchor.checked_add(steps)?;
                Some((day, day, None))
            }
            Freq::Weekly => {
                let week_one = self.anchor - (weekday_of(self.anchor) - self.wkst).rem_euclid(7);
                let first = week_one.checked_add(steps.checked_mul(7)?)?;
                Some((first, first + 6, None))
            }
            Freq::Monthly => {
                let months = self.anchor_year * 12 + (self.anchor_month - 1) + steps;
                let (year, month) = (months.div_euclid(12), months.rem_euclid(12) + 1);
                if !(1..=LAST_YEAR).contains(&year) {
                    return None;
                }
                let first = days_from_civil(year, month, 1);
                Some((first, first + days_in_month(year, month) - 1, None))
            }
            Freq::Yearly => {
                let year = self.anchor_year.checked_add(steps)?;
                if !(1..=LAST_YEAR).contains(&year) {
                    return None;
                }
                if self.week_year {
                    let first = week_one_start(year, self.wkst);
                    let next = week_one_start(year + 1, self.wkst);
                    return Some((first, next - 1, Some(year)));
                }
                let first = days_from_civil(year, 1, 1);
                Some((first, first + year_length(year) - 1, None))
            }
        }
    }

    /// Whether every part the rule carries lets `day` through.
    fn selects(&self, day: i64, week_year: Option<i64>) -> bool {
        let (year, month, dom) = civil_from_days(day);
        let month_len = days_in_month(year, month);
        if !self.by_month.is_empty() && !self.by_month.contains(&month) {
            return false;
        }
        if let Some(week_year) = week_year {
            let start = week_one_start(week_year, self.wkst);
            let weeks = (week_one_start(week_year + 1, self.wkst) - start) / 7;
            let number = (day - start) / 7 + 1;
            if !self
                .by_week_no
                .iter()
                .any(|week| *week == number || *week == number - weeks - 1)
            {
                return false;
            }
        }
        let year_day = day - days_from_civil(year, 1, 1) + 1;
        let year_len = year_length(year);
        if !self.by_year_day.is_empty()
            && !self
                .by_year_day
                .iter()
                .any(|nth| *nth == year_day || *nth == year_day - year_len - 1)
        {
            return false;
        }
        if !self.by_month_day.is_empty()
            && !self
                .by_month_day
                .iter()
                .any(|nth| *nth == dom || *nth == dom - month_len - 1)
        {
            return false;
        }
        if let Some(implied) = self.implied_day
            && dom != implied.min(month_len)
        {
            return false;
        }
        if self.by_day.is_empty() {
            return true;
        }
        let weekday = weekday_of(day);
        let (from_start, from_end) = if self.ordinals_in_year {
            ((year_day - 1) / 7 + 1, (year_len - year_day) / 7 + 1)
        } else {
            ((dom - 1) / 7 + 1, (month_len - dom) / 7 + 1)
        };
        self.by_day.iter().any(|rule| {
            i64::from(rule.day) == weekday
                && match rule.ordinal {
                    None => true,
                    Some(nth) if nth > 0 => nth == from_start,
                    Some(nth) => -nth == from_end,
                }
        })
    }

    /// A period index at or before the first whose days can reach `from_day`.
    /// It overshoots backwards by two periods (a zone can shift a date by a
    /// day, a week-year starts days before its year), so the walk that follows
    /// still applies every filter and the count exactly.
    pub(super) fn first_period_near(&self, from_day: i64) -> i64 {
        if from_day <= self.anchor {
            return 0;
        }
        let (year, month, _) = civil_from_days(from_day);
        let elapsed = match self.freq {
            Freq::Daily => from_day - self.anchor,
            Freq::Weekly => {
                let week_one = self.anchor - (weekday_of(self.anchor) - self.wkst).rem_euclid(7);
                (from_day - week_one).div_euclid(7)
            }
            Freq::Monthly => (year - self.anchor_year) * 12 + (month - self.anchor_month),
            Freq::Yearly => year - self.anchor_year,
        };
        (elapsed.div_euclid(self.interval) - 2).max(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(year: i64, month: i64, dom: i64) -> i64 {
        days_from_civil(year, month, dom)
    }

    #[test]
    fn week_one_is_the_week_holding_january_fourth_whatever_the_week_start() {
        // Monday start (ISO): 2026's week 1 starts on 2025-12-29.
        assert_eq!(week_one_start(2026, 1), day(2025, 12, 29));
        // Sunday start: January 4th 2026 is a Sunday, so week 1 begins on it.
        assert_eq!(week_one_start(2026, 0), day(2026, 1, 4));
        assert_eq!(week_one_start(2025, 0), day(2024, 12, 29));
        // January 4th is itself the first day of a week when it is the week start.
        assert_eq!(week_one_start(2021, 1), day(2021, 1, 4));
    }

    #[test]
    fn a_year_has_52_or_53_weeks_by_the_week_start() {
        let weeks = |year: i64, wkst: i64| {
            (week_one_start(year + 1, wkst) - week_one_start(year, wkst)) / 7
        };
        // ISO: 2020 and 2026 have 53 weeks, 2021 to 2025 have 52.
        assert_eq!(weeks(2020, 1), 53);
        assert_eq!(weeks(2026, 1), 53);
        for year in 2021..=2025 {
            assert_eq!(weeks(year, 1), 52, "{year}");
        }
        // Sunday weeks: 2020 and 2025 have 53.
        assert_eq!(weeks(2020, 0), 53);
        assert_eq!(weeks(2025, 0), 53);
        assert_eq!(weeks(2026, 0), 52);
    }

    #[test]
    fn the_weekday_of_a_day_number_is_sunday_zero() {
        assert_eq!(weekday_of(day(1970, 1, 1)), 4, "a Thursday");
        assert_eq!(weekday_of(day(2026, 3, 1)), 0, "a Sunday");
        assert_eq!(weekday_of(day(2026, 3, 2)), 1);
    }

    #[test]
    fn the_first_period_is_at_or_before_the_one_that_holds_the_day() {
        let rule = super::super::rrule::inspect("FREQ=MONTHLY;BYMONTHDAY=15").expect("a rule");
        let plan = Plan::new(&rule, day(2026, 1, 15));
        let target = day(2027, 3, 15);
        let near = plan.first_period_near(target);
        let (_, days) = plan.period(near).expect("a period");
        // 14 months on is period 14; the jump lands within two periods before it.
        assert!((12..=14).contains(&near), "{near}");
        assert!(days.iter().all(|found| *found < target));
        assert_eq!(
            plan.first_period_near(day(2025, 1, 1)),
            0,
            "before the anchor"
        );
    }
}
