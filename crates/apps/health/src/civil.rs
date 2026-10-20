//! CIVIL DAYS, AS THE PHONE STATED THEM.
//!
//! A day here is `YYYY-MM-DD` as the health store reckoned it in the device's zone (R-1129-8):
//! the vault keeps what the store said and the caller states `today`, so nothing in this crate
//! reads a zone or a clock. These are the proleptic-Gregorian conversions the folds need — a day
//! as a count of days, a day's month, and the steps between them — and nothing else.

/// Days since 1970-01-01 for a civil date (Howard Hinnant's `days_from_civil`).
#[must_use]
pub const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_index = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The civil date of a count of days since 1970-01-01.
#[must_use]
pub const fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

/// A day of the calendar as its count, or `None` when the text is not one: the shape is
/// `YYYY-MM-DD` and the date exists (`2026-02-30` does not).
#[must_use]
pub fn parse_day(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let part = &text[range];
        part.bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    if !(1..=12).contains(&month) || day < 1 {
        return None;
    }
    let count = days_from_civil(year, month, day);
    (civil_from_days(count) == (year, month, day)).then_some(count)
}

/// The `YYYY-MM-DD` of a count of days.
#[must_use]
pub fn format_day(days: i64) -> String {
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The first day of the month a day falls in.
#[must_use]
pub const fn month_start(days: i64) -> i64 {
    let (year, month, _) = civil_from_days(days);
    days_from_civil(year, month, 1)
}

/// The first day of the month `delta` months from the one `days` falls in.
#[must_use]
pub const fn month_start_shifted(days: i64, delta: i64) -> i64 {
    let (year, month, _) = civil_from_days(days);
    let index = year * 12 + (month - 1) + delta;
    days_from_civil(index.div_euclid(12), index.rem_euclid(12) + 1, 1)
}

/// The last day of the month a day falls in.
#[must_use]
pub const fn month_end(days: i64) -> i64 {
    month_start_shifted(days, 1) - 1
}

/// An instant as the vault spells one, `YYYY-MM-DDTHH:MM:SS.sssZ`, from a UTC instant with or
/// without a fraction: the spelling `core_activity.started_at` holds, so two instants compare as
/// text in time order. `None` for anything else (an offset, a missing `Z`).
#[must_use]
pub fn utc_instant(text: &str) -> Option<String> {
    let body = text.strip_suffix('Z')?;
    let (clock, fraction) = match body.split_once('.') {
        Some((clock, fraction)) => (clock, fraction),
        None => (body, ""),
    };
    let bytes = clock.as_bytes();
    if bytes.len() != 19 || bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    parse_day(&clock[..10])?;
    let field = |range: std::ops::Range<usize>, most: i64| -> Option<()> {
        let part = &clock[range];
        (part.bytes().all(|byte| byte.is_ascii_digit()) && part.parse::<i64>().ok()? <= most)
            .then_some(())
    };
    field(11..13, 23)?;
    field(14..16, 59)?;
    field(17..19, 59)?;
    if fraction.len() > 9 || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let millis: String = fraction.chars().chain("000".chars()).take(3).collect();
    Some(format!("{clock}.{millis}Z"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_day_round_trips_and_a_day_the_calendar_has_not_got_is_refused() {
        for day in ["1970-01-01", "2024-02-29", "2026-10-20", "2000-12-31"] {
            assert_eq!(format_day(parse_day(day).expect(day)), day);
        }
        assert_eq!(parse_day("1970-01-01"), Some(0));
        for bad in [
            "2026-02-30",
            "2025-02-29",
            "2026-13-01",
            "2026-1-01",
            "20261020",
            "",
        ] {
            assert_eq!(parse_day(bad), None, "{bad}");
        }
    }

    #[test]
    fn months_step_across_years_and_end_on_their_last_day() {
        let day = parse_day("2026-01-15").unwrap();
        assert_eq!(format_day(month_start(day)), "2026-01-01");
        assert_eq!(format_day(month_start_shifted(day, -1)), "2025-12-01");
        assert_eq!(format_day(month_start_shifted(day, -13)), "2024-12-01");
        assert_eq!(
            format_day(month_end(parse_day("2024-02-03").unwrap())),
            "2024-02-29"
        );
    }

    #[test]
    fn an_instant_is_spelled_with_milliseconds_and_an_offset_is_refused() {
        assert_eq!(
            utc_instant("2026-10-19T22:00:00Z").as_deref(),
            Some("2026-10-19T22:00:00.000Z")
        );
        assert_eq!(
            utc_instant("2026-10-19T22:00:00.5Z").as_deref(),
            Some("2026-10-19T22:00:00.500Z")
        );
        assert_eq!(
            utc_instant("2026-10-19T22:00:00.123456Z").as_deref(),
            Some("2026-10-19T22:00:00.123Z")
        );
        for bad in [
            "2026-10-20T00:00:00+02:00",
            "2026-10-19 22:00:00Z",
            "2026-10-19T24:00:00Z",
            "2026-02-30T00:00:00Z",
        ] {
            assert_eq!(utc_instant(bad), None, "{bad}");
        }
    }
}
