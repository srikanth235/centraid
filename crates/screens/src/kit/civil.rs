//! A CIVIL DAY, IN WORDS, and the arithmetic on one that needs no zone.
//!
//! Every input is a `YYYY-MM-DD` (or `YYYY-MM-DDTHH:MM`) the core already
//! placed in the member's zone, and `today` is the core's answer, never the
//! device clock's UTC day. A day that does not parse is `None` or comes back as
//! itself, never a guess: `2026-02-31` is not the 3rd of March.

use crate::strings::{Locale, shared};

/// Days since 1970-01-01 for `YYYY-MM-DD`, or `None` when it is not one real day.
#[must_use]
pub fn epoch_day_of(day: &str) -> Option<i64> {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = day.get(0..4)?.parse().ok()?;
    let month: i64 = day.get(5..7)?.parse().ok()?;
    let dom: i64 = day.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&dom) {
        return None;
    }
    let epoch = days_from_civil(year, month, dom);
    // The round trip is the validation: the formula accepts the 31st of any
    // month and answers the day after the month's last.
    (civil_day_of(epoch) == day).then_some(epoch)
}

/// `YYYY-MM-DD` for days since 1970-01-01.
#[must_use]
pub fn civil_day_of(epoch_day: i64) -> String {
    let (year, month, day) = civil_from_days(epoch_day);
    format!("{year:04}-{month:02}-{day:02}")
}

/// `day` moved by `days`, or `None` when `day` does not parse.
#[must_use]
pub fn plus_days(day: &str, days: i64) -> Option<String> {
    epoch_day_of(day).map(|epoch| civil_day_of(epoch + days))
}

/// ISO weekday of `day`: 1 is Monday, 7 is Sunday.
#[must_use]
pub fn iso_weekday_of(day: &str) -> Option<u32> {
    // 1970-01-01 was a Thursday, ISO 4.
    epoch_day_of(day).map(|epoch| u32::try_from((epoch + 3).rem_euclid(7)).unwrap_or(0) + 1)
}

/// The day of the month of `day`, 1 to 31.
#[must_use]
pub fn day_of_month_of(day: &str) -> Option<u32> {
    epoch_day_of(day)?;
    day.get(8..10)?.parse().ok()
}

/// Howard Hinnant's `days_from_civil`: the March-first year makes the leap day
/// fall out of the arithmetic.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let month_prime = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Howard Hinnant's `civil_from_days`, proleptic Gregorian.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// `Wed`, or empty for a day that does not parse.
#[must_use]
pub fn weekday_short(locale: Locale, day: &str) -> String {
    match iso_weekday_of(day) {
        Some(1) => shared::weekday_mon(locale),
        Some(2) => shared::weekday_tue(locale),
        Some(3) => shared::weekday_wed(locale),
        Some(4) => shared::weekday_thu(locale),
        Some(5) => shared::weekday_fri(locale),
        Some(6) => shared::weekday_sat(locale),
        Some(7) => shared::weekday_sun(locale),
        _ => String::new(),
    }
}

/// `March` for 3, or empty outside 1..=12.
#[must_use]
pub fn month_name(locale: Locale, month: u32) -> String {
    match month {
        1 => shared::month_01(locale),
        2 => shared::month_02(locale),
        3 => shared::month_03(locale),
        4 => shared::month_04(locale),
        5 => shared::month_05(locale),
        6 => shared::month_06(locale),
        7 => shared::month_07(locale),
        8 => shared::month_08(locale),
        9 => shared::month_09(locale),
        10 => shared::month_10(locale),
        11 => shared::month_11(locale),
        12 => shared::month_12(locale),
        _ => String::new(),
    }
}

/// `March` out of a `YYYY-MM-…` stamp, or empty.
#[must_use]
pub fn month_of(locale: Locale, stamp: &str) -> String {
    stamp
        .get(5..7)
        .and_then(|digits| digits.parse().ok())
        .map(|month| month_name(locale, month))
        .unwrap_or_default()
}

/// `Wed 11`: weekday AND day of month, because a bare weekday is ambiguous past
/// a week.
#[must_use]
pub fn dated(locale: Locale, day: &str) -> String {
    match (weekday_short(locale, day), day_of_month_of(day)) {
        (weekday, Some(dom)) if !weekday.is_empty() => format!("{weekday} {dom}"),
        _ => day.to_owned(),
    }
}

/// `Wed 11 March`, or the input when it is not a day.
#[must_use]
pub fn day_month(locale: Locale, day: &str) -> String {
    let weekday = weekday_short(locale, day);
    let Some(dom) = day_of_month_of(day).filter(|_| !weekday.is_empty()) else {
        return day.to_owned();
    };
    format!("{weekday} {dom} {}", month_of(locale, day))
}

/// `Today`, `Tomorrow`, `Yesterday`, else `Wed 11 March`.
#[must_use]
pub fn relative_day(locale: Locale, day: &str, today: &str) -> String {
    if day == today {
        shared::today(locale)
    } else if plus_days(today, 1).as_deref() == Some(day) {
        shared::tomorrow(locale)
    } else if plus_days(today, -1).as_deref() == Some(day) {
        shared::yesterday(locale)
    } else {
        day_month(locale, day)
    }
}

/// `1st`, `2nd`, `3rd`, `4th` … `11th`, `12th`, `13th` … `21st`.
#[must_use]
pub fn ordinal(n: u32) -> String {
    let suffix = match (n % 100, n % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

/// How the phone words a time of day: its own 12 or 24 hour setting
/// (`Environment.hour_cycle_12`), decided once here and nowhere else.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HourCycle {
    /// `09:00`, `21:05`: the default, and what a shell that never says gets.
    #[default]
    H24,
    /// `9:00 AM`, `9:05 PM`, `12:00 AM` at midnight, `12:00 PM` at noon.
    H12,
}

impl HourCycle {
    /// The cycle the phone's `hour_cycle_12` flag names.
    #[must_use]
    pub fn of(twelve: bool) -> Self {
        if twelve { Self::H12 } else { Self::H24 }
    }
}

/// `08:15` out of `YYYY-MM-DDTHH:MM…`, or empty. Always 24-hour: this is the
/// machine reading the screens compare and parse (midnight, minutes of the day).
/// What a member reads goes through [`clock_for`].
#[must_use]
pub fn clock(local_iso: &str) -> String {
    if local_iso.len() >= 16 && local_iso.as_bytes()[10] == b'T' {
        local_iso.get(11..16).unwrap_or_default().to_owned()
    } else {
        String::new()
    }
}

/// The time of day in `YYYY-MM-DDTHH:MM…` as the phone words it: `08:15`, or
/// `8:15 AM` on a 12-hour phone. Empty when `local_iso` has no time.
#[must_use]
pub fn clock_for(locale: Locale, local_iso: &str, cycle: HourCycle) -> String {
    let hhmm = clock(local_iso);
    time_for(locale, &hhmm, cycle)
}

/// A bare `HH:MM` (a task's due time) as the phone words it; anything that is
/// not one comes back as it was, never a guess.
#[must_use]
pub fn time_for(locale: Locale, hhmm: &str, cycle: HourCycle) -> String {
    if cycle == HourCycle::H24 {
        return hhmm.to_owned();
    }
    let (Some(hour), Some(minute)) = (
        hhmm.get(0..2).and_then(|h| h.parse::<u32>().ok()),
        hhmm.get(3..5),
    ) else {
        return hhmm.to_owned();
    };
    if hhmm.len() != 5 || hhmm.as_bytes()[2] != b':' || hour > 23 {
        return hhmm.to_owned();
    }
    let marker = if hour < 12 {
        shared::clock_am(locale)
    } else {
        shared::clock_pm(locale)
    };
    let shown = match hour % 12 {
        0 => 12,
        other => other,
    };
    format!("{shown}:{minute} {marker}")
}

/// `08:15 – 09:45`, `08:15` with no end, or `All day` (12-hour on a 12-hour phone).
#[must_use]
pub fn span(locale: Locale, start: &str, end: &str, all_day: bool, cycle: HourCycle) -> String {
    if all_day {
        return shared::all_day(locale);
    }
    let (from, to) = (
        clock_for(locale, start, cycle),
        clock_for(locale, end, cycle),
    );
    if to.is_empty() {
        from
    } else {
        format!("{from} – {to}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::En;

    #[test]
    fn a_day_that_is_not_one_is_none() {
        assert_eq!(epoch_day_of("2026-02-31"), None);
        assert_eq!(epoch_day_of("2026-13-01"), None);
        assert_eq!(epoch_day_of("tomorrow"), None);
        assert_eq!(epoch_day_of("2024-02-29"), Some(19_782));
    }

    #[test]
    fn days_step_across_months_years_and_leap_days() {
        assert_eq!(plus_days("2026-12-31", 1).as_deref(), Some("2027-01-01"));
        assert_eq!(plus_days("2024-02-28", 1).as_deref(), Some("2024-02-29"));
        assert_eq!(plus_days("2026-03-01", -1).as_deref(), Some("2026-02-28"));
        assert_eq!(plus_days("2026-03-01", 120).as_deref(), Some("2026-06-29"));
    }

    #[test]
    fn the_weekday_is_isos_monday_first_even_before_1970() {
        assert_eq!(iso_weekday_of("1970-01-01"), Some(4));
        assert_eq!(iso_weekday_of("2026-03-11"), Some(3));
        assert_eq!(iso_weekday_of("1969-12-31"), Some(3));
    }

    #[test]
    fn a_day_in_words_is_relative_near_today_and_dated_beyond() {
        assert_eq!(relative_day(EN, "2026-03-11", "2026-03-11"), "Today");
        assert_eq!(relative_day(EN, "2026-03-12", "2026-03-11"), "Tomorrow");
        assert_eq!(relative_day(EN, "2026-03-10", "2026-03-11"), "Yesterday");
        assert_eq!(relative_day(EN, "2026-03-20", "2026-03-11"), "Fri 20 March");
        assert_eq!(dated(EN, "2026-03-11"), "Wed 11");
        assert_eq!(day_month(EN, "nope"), "nope");
    }

    #[test]
    fn ordinals_know_the_teens() {
        let said: Vec<_> = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31]
            .map(ordinal)
            .to_vec();
        assert_eq!(
            said,
            [
                "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"
            ]
        );
    }

    #[test]
    fn a_span_is_a_clock_range_a_clock_or_all_day() {
        assert_eq!(
            span(
                EN,
                "2026-03-11T08:15",
                "2026-03-11T09:45",
                false,
                HourCycle::H24
            ),
            "08:15 – 09:45"
        );
        assert_eq!(
            span(EN, "2026-03-11T08:15", "", false, HourCycle::H24),
            "08:15"
        );
        assert_eq!(span(EN, "", "", true, HourCycle::H24), "All day");
        assert_eq!(clock("2026-03-11"), "");
    }

    #[test]
    fn a_time_is_worded_in_the_cycle_the_phone_keeps() {
        let day = |hhmm: &str| format!("2026-03-11T{hhmm}");
        let said = |hhmm: &str, cycle| clock_for(EN, &day(hhmm), cycle);
        let h24 = [
            "00:00", "00:05", "01:00", "09:00", "11:59", "12:00", "13:00", "23:59",
        ];
        assert_eq!(h24.map(|t| said(t, HourCycle::H24)), h24);
        assert_eq!(
            h24.map(|t| said(t, HourCycle::H12)),
            [
                "12:00 AM", "12:05 AM", "1:00 AM", "9:00 AM", "11:59 AM", "12:00 PM", "1:00 PM",
                "11:59 PM"
            ]
        );
        assert_eq!(said("21:05", HourCycle::H12), "9:05 PM");
    }

    #[test]
    fn a_time_that_is_not_one_comes_back_as_it_was() {
        assert_eq!(clock_for(EN, "2026-03-11", HourCycle::H12), "");
        assert_eq!(time_for(EN, "", HourCycle::H12), "");
        assert_eq!(time_for(EN, "soon", HourCycle::H12), "soon");
        assert_eq!(time_for(EN, "24:00", HourCycle::H12), "24:00");
        assert_eq!(time_for(EN, "09:00", HourCycle::H12), "9:00 AM");
        assert_eq!(time_for(EN, "09:00", HourCycle::H24), "09:00");
    }

    #[test]
    fn a_span_follows_the_cycle_too() {
        assert_eq!(
            span(
                EN,
                "2026-03-11T09:00",
                "2026-03-11T13:30",
                false,
                HourCycle::H12
            ),
            "9:00 AM – 1:30 PM"
        );
        assert_eq!(
            span(EN, "2026-03-11T09:00", "", false, HourCycle::H12),
            "9:00 AM"
        );
    }
}
