//! THE EDITOR'S VIEW OF A RULE (#1173): [`RepeatSpec`], a small struct a repeat
//! editor reads and writes, and its two conversions to RRULE text.
//!
//! The engine takes ANY day-or-coarser RFC 5545 rule ([`super::rrule`]); an
//! editor shows far fewer shapes: how often, how many steps between, which
//! weekdays, which day of the month, and when it ends. This module is that
//! seam, and it is the only one. It builds and reads rules through the ONE
//! parser, so a spec it writes always parses and a rule it reads is the rule
//! the expander expands:
//!
//! - [`RepeatSpec::to_rrule`] writes the canonical body, or `None` for a spec
//!   that is no rule (an interval of 0, a date that is not one).
//! - [`RepeatSpec::from_rrule`] reads a rule back, or `None` when the rule is
//!   outside what the editor shows (`BYMONTH`, `BYSETPOS`, `BYYEARDAY`,
//!   `BYWEEKNO`, a list of nth weekdays, a `UNTIL` with a time of day, a
//!   `WKST` that changes a fortnightly week...). The editor then shows the
//!   rule as read-only "Custom" and leaves the stored text alone: it never
//!   rewrites a rule it could not read.
//!
//! Round trip: for every rule `from_rrule` accepts,
//! `from_rrule(&spec.to_rrule()?) == Some(spec)`, and the rule it writes
//! expands exactly as the one it read did.
//!
//! No words live here. The sentence for a rule is
//! [`super::rrule::describe`]'s, and the editor's own labels are the editor's.

use super::rrule::{self, DayRule, Freq, ParsedRrule};

/// A day of the week, Monday first (the order a week is shown in, and RFC
/// 5545's default week start).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Weekday {
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
    Sunday,
}

impl Weekday {
    /// All seven, Monday first.
    pub const ALL: [Self; 7] = [
        Self::Monday,
        Self::Tuesday,
        Self::Wednesday,
        Self::Thursday,
        Self::Friday,
        Self::Saturday,
        Self::Sunday,
    ];

    /// The RRULE token (`MO`).
    #[must_use]
    pub const fn token(self) -> &'static str {
        match self {
            Self::Monday => "MO",
            Self::Tuesday => "TU",
            Self::Wednesday => "WE",
            Self::Thursday => "TH",
            Self::Friday => "FR",
            Self::Saturday => "SA",
            Self::Sunday => "SU",
        }
    }

    /// The day an RRULE token names.
    #[must_use]
    pub fn from_token(token: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|day| day.token() == token)
    }

    /// 0 = Sunday ... 6 = Saturday, the engine's own index.
    const fn engine_index(self) -> u8 {
        match self {
            Self::Sunday => 0,
            Self::Monday => 1,
            Self::Tuesday => 2,
            Self::Wednesday => 3,
            Self::Thursday => 4,
            Self::Friday => 5,
            Self::Saturday => 6,
        }
    }

    fn from_engine_index(index: u8) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|day| day.engine_index() == index)
    }
}

/// What a MONTHLY rule pins each month to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonthlyBasis {
    /// Days of the month: `1..=31`, or `-1..=-31` counted from the end (`-1`
    /// is the last day). **Empty means the day the series starts on.** A month
    /// without the day has no occurrence that month (the 31st skips April),
    /// except the implied start day, which lands on the month's last day.
    ByDate(Vec<i32>),
    /// The nth weekday: `ordinal` is `1..=4`, or `-1` for the last (the
    /// range an editor shows; [`RepeatSpec::to_rrule`] refuses the rest).
    ByDay { ordinal: i32, weekday: Weekday },
}

/// When a repeat stops.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepeatEnd {
    Never,
    /// The last day, inclusive, as `YYYY-MM-DD`. Written as a bare-date
    /// `UNTIL`: the whole of that day is inside the series, in its own zone.
    Until(String),
    /// A number of occurrences, `>= 1`.
    Count(u32),
}

/// A repeat as an editor shows it. Fields that do not apply to `freq` are
/// ignored by [`RepeatSpec::to_rrule`] and empty in what
/// [`RepeatSpec::from_rrule`] reads: `weekdays` is WEEKLY's, `monthly` is
/// MONTHLY's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepeatSpec {
    pub freq: Freq,
    /// Steps between occurrences, `>= 1`.
    pub interval: u32,
    /// WEEKLY only. Empty means the weekday the series starts on.
    pub weekdays: Vec<Weekday>,
    /// MONTHLY only.
    pub monthly: MonthlyBasis,
    pub end: RepeatEnd,
}

impl RepeatSpec {
    /// A repeat every `interval` steps of `freq`, with no day detail and no end.
    #[must_use]
    pub const fn every(freq: Freq, interval: u32) -> Self {
        Self {
            freq,
            interval,
            weekdays: Vec::new(),
            monthly: MonthlyBasis::ByDate(Vec::new()),
            end: RepeatEnd::Never,
        }
    }

    /// The canonical RRULE body (`FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6`),
    /// or `None` when the spec is no rule. A rule written here always parses.
    #[must_use]
    pub fn to_rrule(&self) -> Option<String> {
        if self.interval == 0 {
            return None;
        }
        let mut rule = ParsedRrule {
            freq: self.freq,
            interval: i64::from(self.interval),
            count: None,
            until: None,
            wkst: None,
            by_day: Vec::new(),
            by_month_day: Vec::new(),
            by_month: Vec::new(),
            by_year_day: Vec::new(),
            by_week_no: Vec::new(),
            by_set_pos: Vec::new(),
        };
        match self.freq {
            Freq::Weekly => {
                let mut days = self.weekdays.clone();
                days.sort_unstable();
                days.dedup();
                rule.by_day = days
                    .into_iter()
                    .map(|day| DayRule {
                        ordinal: None,
                        day: day.engine_index(),
                    })
                    .collect();
            }
            Freq::Monthly => match &self.monthly {
                MonthlyBasis::ByDate(days) => {
                    let mut days: Vec<i64> = days.iter().map(|day| i64::from(*day)).collect();
                    days.sort_by_key(|day| (*day < 0, *day));
                    days.dedup();
                    rule.by_month_day = days;
                }
                MonthlyBasis::ByDay { ordinal, weekday } => {
                    // The editor's own range (first to fourth, last): what
                    // `from_rrule` reads back.
                    if !matches!(ordinal, 1..=4 | -1) {
                        return None;
                    }
                    rule.by_day = vec![DayRule {
                        ordinal: Some(i64::from(*ordinal)),
                        day: weekday.engine_index(),
                    }];
                }
            },
            Freq::Daily | Freq::Yearly => {}
        }
        match &self.end {
            RepeatEnd::Never => {}
            RepeatEnd::Count(count) => rule.count = Some(i64::from(*count)),
            RepeatEnd::Until(date) => {
                let digits: String = date.chars().filter(char::is_ascii_digit).collect();
                if date.len() != 10 || digits.len() != 8 {
                    return None;
                }
                rule.until = Some(digits);
            }
        }
        let text = rule.to_canonical();
        // The ONE parser has the last word: a spec that is no rule is no rule
        // (a count of 0 reads as once; a made-up day is refused), and the
        // text handed back is exactly what the engine will expand.
        let parsed = rrule::parse(&text)?;
        let honoured = match &self.end {
            RepeatEnd::Count(count) => parsed.count == Some(i64::from(*count)),
            _ => true,
        };
        honoured.then_some(text)
    }

    /// The rule as an editor shows it, or `None` when it is outside that:
    /// the editor shows "Custom", read-only, and keeps the stored text.
    #[must_use]
    pub fn from_rrule(text: &str) -> Option<Self> {
        let rule = rrule::parse(text)?;
        if !(rule.by_month.is_empty()
            && rule.by_year_day.is_empty()
            && rule.by_week_no.is_empty()
            && rule.by_set_pos.is_empty())
        {
            return None;
        }
        // WKST names the week a fortnightly list of days is read in; the
        // editor writes none, which is Monday, so any other start differs.
        // With no days listed the series is the anchor's own weekday, which
        // no week start moves.
        if rule.wkst.is_some_and(|wkst| wkst != 1)
            && rule.freq == Freq::Weekly
            && rule.interval > 1
            && !rule.by_day.is_empty()
        {
            return None;
        }
        let mut spec = Self::every(rule.freq, u32::try_from(rule.interval).ok()?);
        match rule.freq {
            Freq::Daily | Freq::Yearly => {
                if !(rule.by_day.is_empty() && rule.by_month_day.is_empty()) {
                    return None;
                }
            }
            Freq::Weekly => {
                if !rule.by_month_day.is_empty()
                    || rule.by_day.iter().any(|day| day.ordinal.is_some())
                {
                    return None;
                }
                let mut days: Vec<Weekday> = rule
                    .by_day
                    .iter()
                    .map(|day| Weekday::from_engine_index(day.day))
                    .collect::<Option<_>>()?;
                days.sort_unstable();
                days.dedup();
                spec.weekdays = days;
            }
            Freq::Monthly => match (rule.by_day.as_slice(), rule.by_month_day.as_slice()) {
                ([], days) => {
                    let mut days: Vec<i32> = days
                        .iter()
                        .map(|day| i32::try_from(*day).ok())
                        .collect::<Option<_>>()?;
                    days.sort_by_key(|day| (*day < 0, *day));
                    spec.monthly = MonthlyBasis::ByDate(days);
                }
                ([day], []) => {
                    let ordinal = day
                        .ordinal
                        .filter(|ordinal| matches!(ordinal, 1..=4 | -1))?;
                    spec.monthly = MonthlyBasis::ByDay {
                        ordinal: i32::try_from(ordinal).ok()?,
                        weekday: Weekday::from_engine_index(day.day)?,
                    };
                }
                _ => return None,
            },
        }
        spec.end = match (rule.count, rule.until_bound()) {
            (Some(count), _) => RepeatEnd::Count(u32::try_from(count).ok()?),
            (None, None) => RepeatEnd::Never,
            (None, Some(rrule::Until::Date(_))) => {
                let text = rule.until.as_deref()?;
                let digits: String = text.chars().filter(char::is_ascii_digit).collect();
                if digits.len() != 8 {
                    return None;
                }
                RepeatEnd::Until(format!(
                    "{}-{}-{}",
                    &digits[0..4],
                    &digits[4..6],
                    &digits[6..8]
                ))
            }
            (None, Some(_)) => return None,
        };
        Some(spec)
    }
}
