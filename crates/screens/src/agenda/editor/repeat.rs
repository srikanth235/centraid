//! THE CUSTOM REPEAT RULE, as the sheet edits it and as the vault stores it.
//!
//! [`Spec`] is what the sheet holds while it is open: it keeps the fields the
//! chosen frequency does not use, so flipping Weekly to Monthly and back loses
//! nothing. [`to_rrule`] and [`from_rrule`] are the whole mapping to RRULE text,
//! and they are the vault's: a [`Spec`] becomes a `centraid_vault::time::RepeatSpec`
//! and that writes (or reads) the rule, so a rule written here is one the engine
//! expands and one read here is the rule that was stored. A rule the vault's
//! editor seam cannot show (a `BYSETPOS` from an import, a `BYMONTH`, a list of
//! nth weekdays, a `UNTIL` with a time of day) is `None`: the sheet opens it
//! read-only rather than showing a different rule than the stored one.
//!
//! The words a rule is read in live in `strings::agenda_repeat`.

use centraid_vault::time::{Freq as VaultFreq, MonthlyBasis, RepeatEnd, RepeatSpec, Weekday};

use crate::kit::civil;

/// The seven day tokens, Monday first.
pub const WEEKDAYS: [&str; 7] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
/// The ordinals "On the" offers: first to fourth, and last (`-1`). The vault's
/// editor seam has no fifth: a month does not always have one.
pub const ORDINALS: [i32; 5] = [1, 2, 3, 4, -1];
/// The last day of the month, as `BYMONTHDAY` spells it.
pub const LAST_DAY: i32 = -1;
/// The most steps one repeat may skip.
pub const MAX_INTERVAL: i32 = 99;
/// The most times a repeat may run.
pub const MAX_COUNT: i32 = 999;
/// A new "after N times" starts here.
pub const DEFAULT_COUNT: i32 = 10;

/// How often the rule repeats.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Freq {
    pub const ALL: [Self; 4] = [Self::Daily, Self::Weekly, Self::Monthly, Self::Yearly];

    /// The key the sheet's choice list uses.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
            Self::Yearly => "yearly",
        }
    }

    #[must_use]
    pub fn of_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|freq| freq.key() == key)
    }

    const fn vault(self) -> VaultFreq {
        match self {
            Self::Daily => VaultFreq::Daily,
            Self::Weekly => VaultFreq::Weekly,
            Self::Monthly => VaultFreq::Monthly,
            Self::Yearly => VaultFreq::Yearly,
        }
    }

    const fn of_vault(freq: VaultFreq) -> Self {
        match freq {
            VaultFreq::Daily => Self::Daily,
            VaultFreq::Weekly => Self::Weekly,
            VaultFreq::Monthly => Self::Monthly,
            VaultFreq::Yearly => Self::Yearly,
        }
    }
}

/// A monthly rule's two shapes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MonthMode {
    /// On days of the month: `BYMONTHDAY`.
    Date,
    /// "On the" first Monday: a positional `BYDAY`.
    Nth,
}

impl MonthMode {
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Date => "date",
            Self::Nth => "nth",
        }
    }

    #[must_use]
    pub fn of_key(key: &str) -> Option<Self> {
        [Self::Date, Self::Nth]
            .into_iter()
            .find(|mode| mode.key() == key)
    }
}

/// How the rule ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Never,
    /// On a day, inclusive.
    On,
    /// After a number of times.
    After,
}

impl End {
    pub const ALL: [Self; 3] = [Self::Never, Self::On, Self::After];

    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::On => "on",
            Self::After => "after",
        }
    }

    #[must_use]
    pub fn of_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|end| end.key() == key)
    }
}

/// What the Custom repeat sheet holds while it is open. Fields the chosen
/// frequency does not use keep their values, so flipping Weekly to Monthly and
/// back loses nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spec {
    pub freq: Freq,
    pub interval: i32,
    /// Weekly: the days, any subset of [`WEEKDAYS`].
    pub weekdays: Vec<&'static str>,
    pub month_mode: MonthMode,
    /// Monthly by date: `1..=31` and [`LAST_DAY`].
    pub month_days: Vec<i32>,
    /// Monthly "On the": one of [`ORDINALS`].
    pub ordinal: i32,
    pub nth_day: &'static str,
    pub end: End,
    /// `YYYY-MM-DD`, empty until picked.
    pub until_day: String,
    pub count: i32,
}

/// Why a spec is not a rule yet. Each says one sentence in `strings`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Problem {
    Interval,
    Weekday,
    MonthDay,
    Until,
    UntilBefore,
    Count,
    /// The vault would not take the rule: no sentence of its own to give.
    Rule,
}

/// The token of an ISO weekday (1 is Monday).
#[must_use]
pub fn weekday_token(day: &str) -> &'static str {
    civil::iso_weekday_of(day)
        .and_then(|iso| usize::try_from(iso - 1).ok())
        .and_then(|at| WEEKDAYS.get(at))
        .copied()
        .unwrap_or(WEEKDAYS[0])
}

impl Spec {
    /// A new custom rule for an event or task starting on `start_day`: every
    /// week, on that weekday, never ending.
    #[must_use]
    pub fn starting(start_day: &str) -> Self {
        let dom = civil::day_of_month_of(start_day)
            .and_then(|dom| i32::try_from(dom).ok())
            .unwrap_or(1);
        Self {
            freq: Freq::Weekly,
            interval: 1,
            weekdays: vec![weekday_token(start_day)],
            month_mode: MonthMode::Date,
            month_days: vec![dom],
            // The start's own place in the month; a fifth is the last.
            ordinal: match (dom - 1) / 7 + 1 {
                nth @ 1..=4 => nth,
                _ => LAST_DAY,
            },
            nth_day: weekday_token(start_day),
            end: End::Never,
            until_day: String::new(),
            count: DEFAULT_COUNT,
        }
    }

    /// The weekdays, Monday first, each once.
    #[must_use]
    pub fn sorted_weekdays(&self) -> Vec<&'static str> {
        WEEKDAYS
            .into_iter()
            .filter(|day| self.weekdays.contains(day))
            .collect()
    }

    /// The month days in order, the last day after the 31st, each once.
    #[must_use]
    pub fn sorted_month_days(&self) -> Vec<i32> {
        let mut days: Vec<i32> = self
            .month_days
            .iter()
            .copied()
            .filter(|day| (1..=31).contains(day) || *day == LAST_DAY)
            .collect();
        days.sort_by_key(|day| if *day == LAST_DAY { 32 } else { *day });
        days.dedup();
        days
    }

    /// Whether the sheet's weekday row is in play.
    #[must_use]
    pub fn weekly(&self) -> bool {
        self.freq == Freq::Weekly
    }

    /// Whether the monthly rows are in play.
    #[must_use]
    pub fn monthly(&self) -> bool {
        self.freq == Freq::Monthly
    }

    /// The first thing wrong with the spec, if anything. `start_day` is the day
    /// the series starts on: a repeat may not end before it.
    ///
    /// # Errors
    ///
    /// The [`Problem`] that says what is missing.
    pub fn check(&self, start_day: &str) -> Result<(), Problem> {
        if !(1..=MAX_INTERVAL).contains(&self.interval) {
            return Err(Problem::Interval);
        }
        if self.weekly() && self.sorted_weekdays().is_empty() {
            return Err(Problem::Weekday);
        }
        if self.monthly()
            && self.month_mode == MonthMode::Date
            && self.sorted_month_days().is_empty()
        {
            return Err(Problem::MonthDay);
        }
        match self.end {
            End::Never => Ok(()),
            End::On => {
                if civil::epoch_day_of(&self.until_day).is_none() {
                    Err(Problem::Until)
                } else if !start_day.is_empty()
                    && civil::epoch_day_of(start_day).is_some()
                    && self.until_day.as_str() < start_day
                {
                    Err(Problem::UntilBefore)
                } else {
                    Ok(())
                }
            }
            End::After => {
                if (1..=MAX_COUNT).contains(&self.count) {
                    Ok(())
                } else {
                    Err(Problem::Count)
                }
            }
        }
    }
}

/// THE RULE A SPEC WRITES, in the vault's canonical spelling.
///
/// # Errors
///
/// The [`Problem`] that keeps the spec from being a rule.
pub fn to_rrule(spec: &Spec, start_day: &str) -> Result<String, Problem> {
    spec.check(start_day)?;
    let monthly = match spec.month_mode {
        MonthMode::Date => MonthlyBasis::ByDate(spec.sorted_month_days()),
        MonthMode::Nth => MonthlyBasis::ByDay {
            ordinal: spec.ordinal,
            weekday: Weekday::from_token(spec.nth_day).ok_or(Problem::Rule)?,
        },
    };
    let end = match spec.end {
        End::Never => RepeatEnd::Never,
        End::On => RepeatEnd::Until(spec.until_day.clone()),
        End::After => RepeatEnd::Count(u32::try_from(spec.count).map_err(|_| Problem::Count)?),
    };
    RepeatSpec {
        freq: spec.freq.vault(),
        interval: u32::try_from(spec.interval).map_err(|_| Problem::Interval)?,
        weekdays: spec
            .sorted_weekdays()
            .into_iter()
            .filter_map(Weekday::from_token)
            .collect(),
        monthly,
        end,
    }
    .to_rrule()
    .ok_or(Problem::Rule)
}

/// THE SPEC A STORED RULE OPENS AS, or `None` when the sheet cannot hold it
/// without changing what it means. `start_day` fills what the rule leaves to
/// the series' own start (a weekly rule with no `BYDAY` is its weekday).
#[must_use]
pub fn from_rrule(rule: &str, start_day: &str) -> Option<Spec> {
    let read = RepeatSpec::from_rrule(rule)?;
    let mut spec = Spec::starting(start_day);
    spec.freq = Freq::of_vault(read.freq);
    spec.interval = i32::try_from(read.interval)
        .ok()
        .filter(|steps| (1..=MAX_INTERVAL).contains(steps))?;
    if !read.weekdays.is_empty() {
        spec.weekdays = read
            .weekdays
            .iter()
            .map(|day| {
                WEEKDAYS
                    .iter()
                    .find(|token| **token == day.token())
                    .copied()
            })
            .collect::<Option<_>>()?;
    }
    match read.monthly {
        MonthlyBasis::ByDay { ordinal, weekday } => {
            spec.month_mode = MonthMode::Nth;
            spec.ordinal = ordinal;
            spec.nth_day = WEEKDAYS
                .iter()
                .find(|token| **token == weekday.token())
                .copied()?;
        }
        MonthlyBasis::ByDate(days) if !days.is_empty() => {
            if !days
                .iter()
                .all(|day| (1..=31).contains(day) || *day == LAST_DAY)
            {
                return None;
            }
            spec.month_mode = MonthMode::Date;
            spec.month_days = days;
        }
        MonthlyBasis::ByDate(_) if spec.freq == Freq::Monthly => {
            // A monthly rule with no day lands on the start's day of the month;
            // past the 28th that is the month's last day in the short months,
            // which "on the 31st" is not, so the sheet does not claim it.
            let dom = civil::day_of_month_of(start_day).filter(|dom| *dom <= 28)?;
            spec.month_mode = MonthMode::Date;
            spec.month_days = vec![i32::try_from(dom).ok()?];
        }
        MonthlyBasis::ByDate(_) => {}
    }
    match read.end {
        RepeatEnd::Never => {}
        RepeatEnd::Until(day) => {
            spec.end = End::On;
            spec.until_day = day;
        }
        RepeatEnd::Count(count) => {
            spec.end = End::After;
            spec.count = i32::try_from(count)
                .ok()
                .filter(|n| (1..=MAX_COUNT).contains(n))?;
        }
    }
    Some(spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "2099-06-15";

    #[test]
    fn a_spec_and_its_rule_round_trip() {
        for rule in [
            "FREQ=DAILY",
            "FREQ=DAILY;INTERVAL=3;COUNT=5",
            "FREQ=WEEKLY;BYDAY=MO,FR",
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20991231",
            "FREQ=MONTHLY;BYMONTHDAY=1,15,-1",
            "FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR",
            "FREQ=MONTHLY;BYDAY=2MO;COUNT=12",
            "FREQ=YEARLY;INTERVAL=2",
        ] {
            let spec = from_rrule(rule, START).unwrap_or_else(|| panic!("{rule} opens"));
            let written = to_rrule(&spec, START).unwrap_or_else(|p| panic!("{rule}: {p:?}"));
            assert_eq!(
                from_rrule(&written, START),
                Some(spec),
                "{rule} written as {written}"
            );
        }
    }

    #[test]
    fn a_rule_the_sheet_cannot_hold_does_not_open() {
        for rule in [
            "FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR",
            "FREQ=YEARLY;BYMONTH=3",
            "FREQ=DAILY;BYDAY=MO",
            "FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=MO",
            "FREQ=MONTHLY;BYDAY=1MO,2TU",
            "FREQ=HOURLY",
            "garbage",
        ] {
            assert_eq!(from_rrule(rule, START), None, "{rule}");
        }
        // No pin on the 31st would mean a different rule in a short month.
        assert_eq!(from_rrule("FREQ=MONTHLY", "2099-01-31"), None);
        assert!(from_rrule("FREQ=MONTHLY", START).is_some());
    }

    #[test]
    fn a_weekly_rule_with_no_day_is_the_start_weekday() {
        let spec = from_rrule("FREQ=WEEKLY;INTERVAL=3", START).expect("opens");
        // 15 June 2099 is a Monday.
        assert_eq!(spec.weekdays, ["MO"]);
    }

    #[test]
    fn unfinished_specs_say_what_is_missing() {
        let mut spec = Spec::starting(START);
        spec.weekdays.clear();
        assert_eq!(to_rrule(&spec, START), Err(Problem::Weekday));
        spec.freq = Freq::Monthly;
        spec.month_days.clear();
        assert_eq!(to_rrule(&spec, START), Err(Problem::MonthDay));
        spec.month_mode = MonthMode::Nth;
        assert!(to_rrule(&spec, START).is_ok());
        spec.interval = 0;
        assert_eq!(to_rrule(&spec, START), Err(Problem::Interval));
        spec.interval = 1;
        spec.end = End::On;
        assert_eq!(to_rrule(&spec, START), Err(Problem::Until));
        spec.until_day = "2099-06-01".into();
        assert_eq!(to_rrule(&spec, START), Err(Problem::UntilBefore));
        spec.end = End::After;
        spec.count = 0;
        assert_eq!(to_rrule(&spec, START), Err(Problem::Count));
    }
}
