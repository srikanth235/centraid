//! TEMPORAL MEANING IS VALIDATED AT THE BOUNDARY (#996 R21, drift ONT-31).
//!
//! `schedule.add_task` accepted `due_at: "banana"`. The row stored, the reader
//! found a due date it could not parse, and completion then had nothing to
//! advance — an unparseable instant is indistinguishable from no instant at
//! read time, so the task simply stopped recurring and nothing said why.
//!
//! The four readings a vault column may carry are named here, once, and every
//! writer asks this module which one it is holding:
//!
//! | Reading | Example | What it is |
//! |---|---|---|
//! | [`Kind::Instant`] | `2026-03-01T09:00:00Z`, `…+05:30` | a point on the line |
//! | [`Kind::FloatingDateTime`] | `2026-03-01T09:00` | a wall clock with no zone |
//! | [`Kind::LocalDate`] | `2026-03-01` | a whole day |
//! | [`Kind::MonthDay`] | `02-29` | a yearless anniversary |
//!
//! **The calendar is checked, not just the shape**: February 31 is refused for
//! every reading, and February 29 is accepted as a month-day (an anniversary
//! has no year to be non-leap in) while `2027-02-29` is not.

/// One of the four readings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Instant,
    FloatingDateTime,
    LocalDate,
    MonthDay,
}

impl Kind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Instant => "instant",
            Self::FloatingDateTime => "floating-datetime",
            Self::LocalDate => "local-date",
            Self::MonthDay => "month-day",
        }
    }

    const fn sentence(self) -> &'static str {
        match self {
            Self::Instant => "an instant (2026-03-01T09:00:00Z)",
            Self::FloatingDateTime => "a floating local time (2026-03-01T09:00)",
            Self::LocalDate => "a date (2026-03-01)",
            Self::MonthDay => "a month and day (02-29)",
        }
    }
}

const DAYS_IN_MONTH: [i64; 12] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// A real day of a real month — the check "February 31" fails and the shape
/// check does not. `year == None` is a yearless anniversary, where the 29th of
/// February is always real.
const fn is_real_date(year: Option<i64>, month: i64, day: i64) -> bool {
    if month < 1 || month > 12 || day < 1 {
        return false;
    }
    let limit = match year {
        Some(year) if month == 2 && !is_leap_year(year) => 28,
        _ => DAYS_IN_MONTH[(month - 1) as usize],
    };
    day <= limit
}

const fn is_clock_time(hour: i64, minute: i64, second: i64) -> bool {
    hour <= 23 && minute <= 59 && second <= 59
}

fn number(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Which of the four readings `value` carries, or `None` when it carries none.
///
/// **The one place a temporal string is judged**; every entry point calls it
/// rather than writing its own pattern.
#[must_use]
pub fn classify(value: &str) -> Option<Kind> {
    let bytes = value.as_bytes();
    // `YYYY-MM-DDTHH:MM(:SS(.f{1,9})?)?(Z|±HH:MM)?`
    if bytes.len() >= 16 && bytes[4] == b'-' && bytes[7] == b'-' && bytes[10] == b'T' {
        if bytes[13] != b':' {
            return None;
        }
        let year = number(value.get(0..4)?)?;
        let month = number(value.get(5..7)?)?;
        let day = number(value.get(8..10)?)?;
        let hour = number(value.get(11..13)?)?;
        let minute = number(value.get(14..16)?)?;
        let mut cursor = 16;
        let mut second = 0;
        if bytes.get(cursor) == Some(&b':') {
            second = number(value.get(cursor + 1..cursor + 3)?)?;
            cursor += 3;
            if bytes.get(cursor) == Some(&b'.') {
                let fraction: String = bytes[cursor + 1..]
                    .iter()
                    .take_while(|byte| byte.is_ascii_digit())
                    .map(|byte| char::from(*byte))
                    .collect();
                if fraction.is_empty() || fraction.len() > 9 {
                    return None;
                }
                cursor += 1 + fraction.len();
            }
        }
        if !is_real_date(Some(year), month, day) || !is_clock_time(hour, minute, second) {
            return None;
        }
        let zone = &value[cursor..];
        return match zone {
            "" => Some(Kind::FloatingDateTime),
            "Z" => Some(Kind::Instant),
            _ => {
                let zone_bytes = zone.as_bytes();
                let shaped = zone_bytes.len() == 6
                    && matches!(zone_bytes[0], b'+' | b'-')
                    && zone_bytes[3] == b':'
                    && zone_bytes[1..3].iter().all(u8::is_ascii_digit)
                    && zone_bytes[4..6].iter().all(u8::is_ascii_digit);
                shaped.then_some(Kind::Instant)
            }
        };
    }
    // `YYYY-MM-DD`
    if bytes.len() == 10 && bytes[4] == b'-' && bytes[7] == b'-' {
        let year = number(value.get(0..4)?)?;
        let month = number(value.get(5..7)?)?;
        let day = number(value.get(8..10)?)?;
        return is_real_date(Some(year), month, day).then_some(Kind::LocalDate);
    }
    // `MM-DD`
    if bytes.len() == 5 && bytes[2] == b'-' {
        let month = number(value.get(0..2)?)?;
        let day = number(value.get(3..5)?)?;
        return is_real_date(None, month, day).then_some(Kind::MonthDay);
    }
    None
}

/// True when `value` reads as one of `allowed`.
#[must_use]
pub fn is_temporal(value: &str, allowed: &[Kind]) -> bool {
    classify(value).is_some_and(|kind| allowed.contains(&kind))
}

/// The owner-facing refusal. It says what arrived and what the field takes,
/// because "invalid date" is the sentence that made ONT-31 survive three
/// releases.
#[must_use]
pub fn refusal(field: &str, value: &str, allowed: &[Kind]) -> String {
    let wanted: Vec<&str> = allowed.iter().map(|kind| kind.sentence()).collect();
    format!(
        "{field}: {} is not a time this vault can read — {field} takes {}.",
        serde_json::Value::String(value.to_owned()),
        wanted.join(", or ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_four_readings_are_told_apart() {
        assert_eq!(classify("2026-03-01T09:00:00Z"), Some(Kind::Instant));
        assert_eq!(classify("2026-03-01T09:00:00+05:30"), Some(Kind::Instant));
        assert_eq!(classify("2026-03-01T09:00"), Some(Kind::FloatingDateTime));
        assert_eq!(
            classify("2026-03-01T09:00:00.123"),
            Some(Kind::FloatingDateTime)
        );
        assert_eq!(classify("2026-03-01"), Some(Kind::LocalDate));
        assert_eq!(classify("02-29"), Some(Kind::MonthDay));
    }

    #[test]
    fn the_calendar_is_checked_not_only_the_shape() {
        assert_eq!(classify("2026-02-31"), None);
        assert_eq!(classify("2027-02-29"), None);
        assert_eq!(classify("2028-02-29"), Some(Kind::LocalDate));
        assert_eq!(classify("2026-13-01"), None);
        assert_eq!(classify("2026-03-01T25:00:00Z"), None);
        assert_eq!(classify("banana"), None);
    }

    #[test]
    fn the_refusal_says_what_the_field_takes() {
        let message = refusal(
            "due_at",
            "banana",
            &[Kind::Instant, Kind::FloatingDateTime, Kind::LocalDate],
        );
        assert_eq!(
            message,
            // v0 joins with ", or " between EVERY member
            // (`temporalRefusal`, `temporal.ts:113`), not Oxford-style. The
            // sentence is compared by the corpus, so the seam is the join.
            "due_at: \"banana\" is not a time this vault can read — due_at takes an instant \
             (2026-03-01T09:00:00Z), or a floating local time (2026-03-01T09:00), or a date \
             (2026-03-01)."
        );
    }
}
