//! CIVIL TIME, IN THE VAULT'S ZONE — the birthday rail's arithmetic
//! (D-1020-PE7).
//!
//! People has two different clocks and v0 reads the host's for both.
//!
//! 1. **Cadence is an ELAPSED-TIME question.** "Overdue to reconnect" is
//!    `daysSince(last_contacted_at ?? created_at) > cadence_days`
//!    (`format.ts:3`-`:5`), and days-since is instant arithmetic: two instants,
//!    a difference in milliseconds, floored onto whole days. No zone is
//!    involved and none is wanted, so [`days_since`] takes both instants.
//! 2. **A birthday is a CIVIL-DATE question**, and v0's `daysUntilMonthDay`
//!    (`format.ts:53`-`:71`) builds `new Date(now)` and reads
//!    `getFullYear()`/`getMonth()`/`getDate()` off it — **the HOST's local
//!    zone**. That is the one the VPS breaks: a gateway in UTC and a member in
//!    UTC−07:00 disagree about what day it is for seven hours of every day, so
//!    a birthday reminder fires a day early or a day late depending on which
//!    machine answered the query (`docs/cron-timezone.md:21`, census §A6 —
//!    "a VPS runs UTC"). The automations lane's rule is that civil time is the
//!    **vault's** zone; this module takes the civil date as an argument so
//!    there is no clock in this crate to read the wrong one from.
//!
//! **THE LEAP DAY IS CLAMPED, NOT SKIPPED.** `02-29` in a common year resolves
//! to 28 February, so a leap-day birthday still fires every year
//! (`format.ts:51`-`:52`, and `occurrence`'s month-overflow check at `:62`-`:67`
//! is what implements it). The fixture case is in [`tests`].

/// A civil date in the vault's own zone: the answer to "what day is it *there*".
///
/// Deliberately not an instant. The caller resolves the vault's zone once, at
/// the edge that knows it, and hands the date down — so a handler cannot read a
/// host clock even by accident.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CivilDate {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

impl CivilDate {
    #[must_use]
    pub const fn new(year: i32, month: u32, day: u32) -> Self {
        Self { year, month, day }
    }

    /// A `YYYY-MM-DD` text, or `None`. Only the exact ten-character shape is
    /// accepted, as v0's `floorDate` accepts only `^\d{4}-\d{2}-\d{2}$`
    /// (#1020 apps seam 5: a malformed bound must not narrow anything).
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return None;
        }
        let year = text.get(0..4)?.parse::<i32>().ok()?;
        let month = text.get(5..7)?.parse::<u32>().ok()?;
        let day = text.get(8..10)?.parse::<u32>().ok()?;
        if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
            return None;
        }
        Some(Self::new(year, month, day))
    }

    /// The civil date an ISO instant falls on, in the zone whose offset from
    /// UTC is `offset_minutes`. The vault's zone offset is the caller's to
    /// resolve; this is the lowering.
    #[must_use]
    pub fn of_instant(instant: &str, offset_minutes: i64) -> Option<Self> {
        let millis = parse_instant(instant)?;
        Some(Self::from_days(
            (millis + offset_minutes * 60_000).div_euclid(DAY_MS),
        ))
    }

    /// Days since the civil epoch, 1970-01-01. Howard Hinnant's
    /// `days_from_civil`, as `crates/vault::clock` spells it.
    #[must_use]
    pub const fn to_days(self) -> i64 {
        let year = if self.month <= 2 {
            self.year as i64 - 1
        } else {
            self.year as i64
        };
        let era = if year >= 0 { year } else { year - 399 } / 400;
        let year_of_era = year - era * 400;
        let month = self.month as i64;
        let day_of_year =
            (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + self.day as i64 - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        era * 146_097 + day_of_era - 719_468
    }

    /// The inverse, `civil_from_days`.
    #[must_use]
    pub const fn from_days(days: i64) -> Self {
        let shifted = days + 719_468;
        let era = if shifted >= 0 {
            shifted
        } else {
            shifted - 146_096
        } / 146_097;
        let day_of_era = shifted - era * 146_097;
        let year_of_era =
            (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let year = year_of_era + era * 400;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let month_prime = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
        let month = if month_prime < 10 {
            month_prime + 3
        } else {
            month_prime - 9
        };
        Self {
            year: (if month <= 2 { year + 1 } else { year }) as i32,
            month: month as u32,
            day: day as u32,
        }
    }
}

const DAY_MS: i64 = 86_400_000;

/// What [`days_until_month_day`] answers for an unparseable `MM-DD`.
///
/// v0 returns `Number.MAX_SAFE_INTEGER` (`format.ts:55`) so the row sorts last
/// rather than first; the port keeps the behaviour and names the number, because
/// a magic 9,007,199,254,740,991 in a sort comparator is the kind of thing a
/// reader takes for a bug.
pub const DAYS_UNSET: i64 = 9_007_199_254_740_991;

const fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

const fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// The next occurrence of an annual `MM-DD`, as whole days from `today`.
///
/// `0` is today. **February 29 clamps to 28 February in a common year**, so a
/// leap-day birthday still fires. An `MM-DD` that does not parse answers
/// [`DAYS_UNSET`].
#[must_use]
pub fn days_until_month_day(today: CivilDate, month_day: &str) -> i64 {
    let Some((month, day)) = parse_month_day(month_day) else {
        return DAYS_UNSET;
    };
    let occurrence = |year: i32| -> CivilDate {
        // v0 builds `new Date(year, month - 1, day)` and checks whether the
        // month rolled over; the clamp is the same fact stated forwards.
        CivilDate::new(year, month, day.min(days_in_month(year, month)))
    };
    let mut next = occurrence(today.year);
    if next < today {
        next = occurrence(today.year + 1);
    }
    next.to_days() - today.to_days()
}

/// `MM-DD`, exactly. A month of 0, a month above 12 and a day of 0 are all
/// "unset" rather than clamped: v0 reads them through `Number` and returns its
/// sentinel on a falsy value, which is the same set.
#[must_use]
pub fn parse_month_day(month_day: &str) -> Option<(u32, u32)> {
    let (month, day) = month_day.split_once('-')?;
    let month = month.parse::<u32>().ok()?;
    let day = day.parse::<u32>().ok()?;
    if month == 0 || month > 12 || day == 0 || day > 31 {
        return None;
    }
    Some((month, day))
}

/// Milliseconds since the epoch for an ISO instant the vault wrote, or `None`.
///
/// Hand-rolled for the reason Docs' parity mapping records: this crate's only
/// dependencies are the kit and `serde`, and date arithmetic is not a reason to
/// add one. Only the shape the vault writes is accepted.
#[must_use]
pub fn parse_instant(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[10] != b'T' || !text.ends_with('Z') {
        return None;
    }
    let field = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let date = CivilDate::new(
        i32::try_from(field(0, 4)?).ok()?,
        u32::try_from(field(5, 7)?).ok()?,
        u32::try_from(field(8, 10)?).ok()?,
    );
    let (hour, minute, second) = (field(11, 13)?, field(14, 16)?, field(17, 19)?);
    let millis = if bytes[19] == b'.' {
        field(20, 23).unwrap_or(0)
    } else {
        0
    };
    Some((date.to_days() * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + millis)
}

/// Whole days between an instant and `now_ms`, floored, never negative.
///
/// v0's `daysSince` (`format.ts:7`-`:11`): an absent or unparseable instant is
/// `0`, which reads as "today" and therefore as never overdue.
#[must_use]
pub fn days_since(instant: Option<&str>, now_ms: i64) -> i64 {
    let Some(at) = instant.and_then(parse_instant) else {
        return 0;
    };
    ((now_ms - at).div_euclid(DAY_MS)).max(0)
}

/// Days since a person was last contacted, falling back to when they were added.
///
/// **A person never contacted counts from when they were ADDED**, so a fresh
/// contact reads as on-track rather than as infinitely overdue
/// (`dashboard.ts:5`-`:6`).
#[must_use]
pub fn days_since_contact(
    last_contacted_at: Option<&str>,
    created_at: Option<&str>,
    now_ms: i64,
) -> i64 {
    days_since(last_contacted_at.or(created_at), now_ms)
}

/// **A CADENCE OF ZERO IS "NO CADENCE", NEVER "OVERDUE EVERY DAY"**
/// (`dashboard.ts:11`-`:13`, `format.ts:20`-`:32`).
///
/// And the comparison is strictly greater: overdue only AFTER the cadence day,
/// not on it.
#[must_use]
pub fn is_overdue(
    cadence_days: i64,
    last_contacted_at: Option<&str>,
    created_at: Option<&str>,
    now_ms: i64,
) -> bool {
    cadence_days > 0 && days_since_contact(last_contacted_at, created_at, now_ms) > cadence_days
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_civil_date_round_trips_through_its_day_number() {
        for text in [
            "1970-01-01",
            "2000-02-29",
            "2024-12-31",
            "2099-06-01",
            "1899-03-01",
        ] {
            let date = CivilDate::parse(text).expect("a well-formed date");
            assert_eq!(CivilDate::from_days(date.to_days()), date, "{text}");
        }
        assert_eq!(CivilDate::parse("2023-02-29"), None, "not a real day");
        assert_eq!(CivilDate::parse("2023-13-01"), None);
        assert_eq!(
            CivilDate::parse("2023-1-01"),
            None,
            "ten characters exactly"
        );
    }

    /// THE LEAP-DAY CASE (D-1020-PE7). A 29 February birthday fires on 28
    /// February in a common year and on the day itself in a leap year.
    #[test]
    fn a_leap_day_birthday_clamps_to_the_twenty_eighth_rather_than_vanishing() {
        // 2025 is a common year: from 1 February, the birthday is 27 days away.
        assert_eq!(
            days_until_month_day(CivilDate::new(2025, 2, 1), "02-29"),
            27
        );
        // On 28 February 2025 it is TODAY, not eleven months away.
        assert_eq!(
            days_until_month_day(CivilDate::new(2025, 2, 28), "02-29"),
            0
        );
        // 2024 is a leap year: the real day exists and is used.
        assert_eq!(
            days_until_month_day(CivilDate::new(2024, 2, 28), "02-29"),
            1
        );
        // And the day AFTER this year's occurrence rolls to next year's.
        assert_eq!(
            days_until_month_day(CivilDate::new(2025, 3, 1), "02-29"),
            364,
            "1 March 2025 to 28 February 2026"
        );
    }

    #[test]
    fn an_unset_month_day_sorts_last_rather_than_first() {
        assert_eq!(
            days_until_month_day(CivilDate::new(2025, 6, 1), ""),
            DAYS_UNSET
        );
        assert_eq!(
            days_until_month_day(CivilDate::new(2025, 6, 1), "00-00"),
            DAYS_UNSET
        );
        assert_eq!(
            days_until_month_day(CivilDate::new(2025, 6, 1), "13-01"),
            DAYS_UNSET
        );
        // A row with no date must not lead the "nearest first" rail.
        assert!(DAYS_UNSET > days_until_month_day(CivilDate::new(2025, 6, 1), "06-01"));
    }

    /// THE ZONE IS THE VAULT'S, AND IT CHANGES THE ANSWER. Same instant, two
    /// zones, two different civil days — which is exactly the reminder firing a
    /// day early on a VPS that runs UTC.
    #[test]
    fn the_same_instant_is_two_different_days_in_two_zones() {
        let instant = "2025-08-14T04:00:00.000Z";
        let utc = CivilDate::of_instant(instant, 0).expect("parses");
        let los_angeles = CivilDate::of_instant(instant, -7 * 60).expect("parses");
        assert_eq!(utc, CivilDate::new(2025, 8, 14));
        assert_eq!(los_angeles, CivilDate::new(2025, 8, 13));
        // A birthday on 08-14 is TODAY in the vault's UTC and TOMORROW in
        // UTC-07:00. One of those two answers is the member's, and it is not
        // the host's to choose.
        assert_eq!(days_until_month_day(utc, "08-14"), 0);
        assert_eq!(days_until_month_day(los_angeles, "08-14"), 1);
    }

    #[test]
    fn cadence_is_elapsed_time_and_zero_is_never() {
        let now = parse_instant("2025-06-30T12:00:00.000Z").expect("parses");
        let ten_days_ago = "2025-06-20T12:00:00.000Z";
        assert_eq!(days_since(Some(ten_days_ago), now), 10);
        // Strictly greater: on the cadence day itself, not yet overdue.
        assert!(!is_overdue(10, Some(ten_days_ago), None, now));
        assert!(is_overdue(9, Some(ten_days_ago), None, now));
        // ZERO IS NO CADENCE.
        assert!(!is_overdue(0, Some("2019-01-01T00:00:00.000Z"), None, now));
        // Never contacted counts from when they were added.
        assert_eq!(days_since_contact(None, Some(ten_days_ago), now), 10);
        // An unparseable instant reads as today, so it is never overdue.
        assert_eq!(days_since(Some("yesterday"), now), 0);
        assert_eq!(days_since(None, now), 0);
        // And a FUTURE instant does not go negative.
        assert_eq!(days_since(Some("2030-01-01T00:00:00.000Z"), now), 0);
    }
}
