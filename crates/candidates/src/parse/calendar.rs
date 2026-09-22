//! Dates, the way the corpus publishes them.
//!
//! The world's day is Monday 2026-06-15 (`crates/evalsuite/README.md`, "What a
//! temporal phrase means"). This module resolves only what the README says a
//! parser may resolve — weekday names and day-of-month ordinals, "case by
//! case" — and leaves every NAMED period as a window terminal for the
//! executor, because a parser that expanded `this week` into two dates would
//! be a second definition of the convention.

/// The world's today, as (year, month, day).
pub const TODAY: (i64, u32, u32) = (2026, 6, 15);

/// Days from the civil epoch (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn today_days() -> i64 {
    days_from_civil(TODAY.0, TODAY.1, TODAY.2)
}

pub fn iso(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// ISO weekday, Monday = 1.
pub fn weekday(days: i64) -> u32 {
    (((days % 7) + 10) % 7 + 1) as u32
}

/// The next occurrence of `target` (Monday = 1), today counting as today.
pub fn next_weekday(target: u32) -> i64 {
    let today = today_days();
    let mut delta = (target as i64 - weekday(today) as i64 + 7) % 7;
    if delta == 0 {
        delta = 0; // "on Monday" said on a Monday is today
    }
    today + delta
}

/// The next day-of-month with that number, this month or the next.
pub fn next_day_of_month(day: u32) -> i64 {
    let (y, m, _) = TODAY;
    let here = days_from_civil(y, m, day);
    if here >= today_days() {
        here
    } else if m == 12 {
        days_from_civil(y + 1, 1, day)
    } else {
        days_from_civil(y, m + 1, day)
    }
}

/// A bare clock hour the way a member says it: one to seven is the afternoon.
pub fn hour24(hour: u32, meridiem: Option<&str>) -> u32 {
    match meridiem {
        Some("am") => {
            if hour == 12 {
                0
            } else {
                hour
            }
        }
        Some("pm") => {
            if hour == 12 {
                12
            } else {
                hour + 12
            }
        }
        _ => {
            if (1..=7).contains(&hour) {
                hour + 12
            } else {
                hour
            }
        }
    }
}
