//! Civil dates as plain `YYYY-MM-DD` text and day arithmetic over them.
//!
//! A statement prints a day, not an instant (R-1099-2), so the import never
//! touches a zone. These are the only date functions the plan needs: validity,
//! a day count for `|days| <= 3`, and a shifted window.

/// Days in `month` of `year` (proleptic Gregorian); 0 for a month outside 1..=12.
#[must_use]
pub fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Whether year, month and day name a real day in 1900..=2199.
#[must_use]
pub fn is_valid(year: i32, month: u32, day: u32) -> bool {
    (1900..=2199).contains(&year) && day >= 1 && day <= days_in_month(year, month)
}

/// `YYYY-MM-DD`.
#[must_use]
pub fn format(year: i32, month: u32, day: u32) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

/// Parses exactly `YYYY-MM-DD` into a real day.
#[must_use]
pub fn parse(text: &str) -> Option<(i32, u32, u32)> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i32 = text.get(0..4)?.parse().ok()?;
    let month: u32 = text.get(5..7)?.parse().ok()?;
    let day: u32 = text.get(8..10)?.parse().ok()?;
    is_valid(year, month, day).then_some((year, month, day))
}

/// Days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
#[must_use]
pub fn day_number(year: i32, month: u32, day: u32) -> i64 {
    let y = i64::from(if month <= 2 { year - 1 } else { year });
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The day count of a `YYYY-MM-DD` text.
#[must_use]
pub fn day_number_of(text: &str) -> Option<i64> {
    let (y, m, d) = parse(text)?;
    Some(day_number(y, m, d))
}

/// The inverse of [`day_number`], as `(year, month, day)`.
#[must_use]
pub fn from_day_number_parts(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (
        i32::try_from(y).unwrap_or(0),
        u32::try_from(m).unwrap_or(0),
        u32::try_from(d).unwrap_or(0),
    )
}

/// The inverse of [`day_number`], as `YYYY-MM-DD`.
#[must_use]
pub fn from_day_number(days: i64) -> String {
    let (y, m, d) = from_day_number_parts(days);
    format(y, m, d)
}

/// `text` shifted by `days` (negative goes back).
#[must_use]
pub fn shift(text: &str, days: i64) -> Option<String> {
    Some(from_day_number(day_number_of(text)? + days))
}

/// `YYYY-MM` of a `YYYY-MM-DD` (or longer) text.
#[must_use]
pub fn month_of(day: &str) -> &str {
    day.get(..7).unwrap_or(day)
}

/// Splits `YYYY-MM`.
#[must_use]
pub fn parse_month(month: &str) -> Option<(i32, u32)> {
    let bytes = month.as_bytes();
    if bytes.len() != 7 || bytes[4] != b'-' {
        return None;
    }
    let year: i32 = month.get(0..4)?.parse().ok()?;
    let number: u32 = month.get(5..7)?.parse().ok()?;
    ((1900..=2199).contains(&year) && (1..=12).contains(&number)).then_some((year, number))
}

/// The month `delta` months from `month` (negative goes back), as `YYYY-MM`.
#[must_use]
pub fn add_months(month: &str, delta: i32) -> Option<String> {
    let (year, number) = parse_month(month)?;
    let index = year * 12 + i32::try_from(number).ok()? - 1 + delta;
    let (year, number) = (index.div_euclid(12), index.rem_euclid(12) + 1);
    Some(format!("{year:04}-{number:02}"))
}

/// The first day of `month` as the text a posted-at range starts with.
#[must_use]
pub fn month_start_stamp(month: &str) -> String {
    format!("{month}-01T00:00:00Z")
}

/// Days in a `YYYY-MM` month.
#[must_use]
pub fn month_length(month: &str) -> u32 {
    parse_month(month).map_or(0, |(year, number)| days_in_month(year, number))
}

/// The day of the month (1-based) of a `YYYY-MM-DD` text.
#[must_use]
pub fn day_of_month(day: &str) -> Option<u32> {
    parse(day).map(|(_, _, d)| d)
}

/// The weekday of a day number, Monday = 0.
#[must_use]
pub fn weekday(day_number: i64) -> u32 {
    // 1970-01-01 was a Thursday.
    u32::try_from((day_number + 3).rem_euclid(7)).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_numbers_round_trip_and_leap_days_are_real() {
        assert_eq!(day_number(1970, 1, 1), 0);
        assert_eq!(from_day_number(day_number(2024, 2, 29)), "2024-02-29");
        assert_eq!(shift("2024-03-01", -1).as_deref(), Some("2024-02-29"));
        assert_eq!(shift("2023-12-31", 1).as_deref(), Some("2024-01-01"));
        assert!(parse("2023-02-29").is_none());
        assert!(parse("2024-02-29").is_some());
    }

    #[test]
    fn months_add_across_years_and_weekdays_count_from_monday() {
        assert_eq!(add_months("2024-01", -1).as_deref(), Some("2023-12"));
        assert_eq!(add_months("2024-11", 3).as_deref(), Some("2025-02"));
        assert_eq!(month_length("2024-02"), 29);
        assert_eq!(weekday(day_number(2024, 1, 1)), 0);
        assert_eq!(weekday(day_number(2024, 1, 7)), 6);
    }
}
