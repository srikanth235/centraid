//! Whole-day arithmetic on `YYYY-MM-DD` — the one calendar fact a read here
//! needs that the core's answers do not already carry.
//!
//! "Tomorrow" and "this week" are ranges of the member's local days. The
//! agenda answer states `today` in the device's zone and every event's
//! `local_days`; all that is left is to count forward from `today`, which is
//! pure arithmetic and needs no zone.

/// Days since 1970-01-01 of a proleptic Gregorian civil date (Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date of a day count (Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn parse(day: &str) -> Option<(i64, i64, i64)> {
    let mut parts = day.get(..10)?.split('-');
    let year = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let date: i64 = parts.next()?.parse().ok()?;
    ((1..=12).contains(&month) && (1..=31).contains(&date)).then_some((year, month, date))
}

/// `day` plus `n` days, as `YYYY-MM-DD`; `None` when `day` is not a date.
pub(in crate::assist) fn add_days(day: &str, n: i64) -> Option<String> {
    let (year, month, date) = parse(day)?;
    let (year, month, date) = civil_from_days(days_from_civil(year, month, date) + n);
    Some(format!("{year:04}-{month:02}-{date:02}"))
}

/// `month` (`YYYY-MM`) of the day before `day`'s month began: the last month.
pub(in crate::assist) fn previous_month(day: &str) -> Option<String> {
    let (year, month, _) = parse(day)?;
    let (year, month) = if month == 1 {
        (year - 1, 12)
    } else {
        (year, month - 1)
    };
    Some(format!("{year:04}-{month:02}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_add_across_months_years_and_leap_days() {
        assert_eq!(add_days("2026-10-01", 1).as_deref(), Some("2026-10-02"));
        assert_eq!(add_days("2026-10-31", 1).as_deref(), Some("2026-11-01"));
        assert_eq!(add_days("2026-12-31", 1).as_deref(), Some("2027-01-01"));
        assert_eq!(add_days("2028-02-28", 1).as_deref(), Some("2028-02-29"));
        assert_eq!(add_days("2026-02-28", 1).as_deref(), Some("2026-03-01"));
        assert_eq!(add_days("2026-03-01", -1).as_deref(), Some("2026-02-28"));
        assert_eq!(add_days("2026-10-01", 6).as_deref(), Some("2026-10-07"));
        assert_eq!(
            add_days("2026-10-01T09:00:00.000Z", 0).as_deref(),
            Some("2026-10-01")
        );
    }

    #[test]
    fn a_non_date_is_none() {
        assert_eq!(add_days("tomorrow", 1), None);
        assert_eq!(add_days("2026-13-01", 1), None);
        assert_eq!(add_days("", 1), None);
    }

    #[test]
    fn the_previous_month_wraps_the_year() {
        assert_eq!(previous_month("2026-10-01").as_deref(), Some("2026-09"));
        assert_eq!(previous_month("2026-01-15").as_deref(), Some("2025-12"));
    }

    #[test]
    fn the_round_trip_holds_over_a_wide_range() {
        for days in (-800_000..800_000).step_by(997) {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
    }
}
