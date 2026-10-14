//! Printed dates, and which order a column uses.
//!
//! A cell is read into a [`Shape`] without choosing an order: a year-first or
//! month-named date is unambiguous, and `05/06/2024` is [`Shape::Numeric`]
//! until the column says whether the month comes first. The order is decided
//! over the **whole column** ([`decide`]): one day greater than 12 in either
//! slot settles it, and a column that never settles it is [`DateOrder::Ask`] —
//! the plan carries the question and the member answers it. A first-row guess
//! is exactly the bug this exists to avoid.

use serde::{Deserialize, Serialize};

use crate::civil;

/// Which slot of a slash date is the month.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DateOrder {
    /// `MM/DD/YYYY`.
    Mdy,
    /// `DD/MM/YYYY`.
    Dmy,
    /// The file prints year first (or names the month): there is nothing to ask.
    Ymd,
    /// The column cannot say; the member picks.
    Ask,
}

/// One cell, read without choosing an order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// A real day whose parts are unambiguous.
    Ymd(i32, u32, u32),
    /// `a`/`b`/`year`: which of `a`, `b` is the month is the order's to say.
    Numeric {
        a: u32,
        b: u32,
        year: i32,
    },
    Invalid,
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

fn month_of(word: &str) -> Option<u32> {
    let lower = word.to_ascii_lowercase();
    let head = lower.get(..3)?;
    let at = MONTHS.iter().position(|month| *month == head)?;
    // "Sept", "June" and the full names; nothing else starting with a month.
    let full = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ][at];
    (lower == head || lower == full || (lower == "sept" && at == 8))
        .then(|| u32::try_from(at + 1).unwrap_or(1))
}

fn year_of(token: &str) -> Option<i32> {
    match token.len() {
        4 => token.parse().ok(),
        2 => {
            let two: i32 = token.parse().ok()?;
            Some(if two < 70 { 2000 + two } else { 1900 + two })
        }
        _ => None,
    }
}

/// Reads one cell.
#[must_use]
pub fn shape(text: &str) -> Shape {
    // Drop a time of day: any whitespace-separated word holding a colon, an
    // AM/PM marker, or a `T` between digits ("2024-01-05T10:22:00Z").
    let mut cleaned = String::with_capacity(text.len());
    let chars: Vec<char> = text.trim().chars().collect();
    for (at, &c) in chars.iter().enumerate() {
        let between_digits = c == 'T'
            && at > 0
            && chars[at - 1].is_ascii_digit()
            && chars.get(at + 1).is_some_and(char::is_ascii_digit);
        cleaned.push(if between_digits { ' ' } else { c });
    }
    let words: Vec<&str> = cleaned
        .split_whitespace()
        .filter(|word| {
            !word.contains(':')
                && !word.eq_ignore_ascii_case("am")
                && !word.eq_ignore_ascii_case("pm")
        })
        .collect();
    let joined = words.join(" ");
    let tokens: Vec<&str> = joined
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();
    let numeric = |token: &str| token.chars().all(|c| c.is_ascii_digit());
    // A month by name: "Jan 5, 2024", "5-Jan-24", "January 5 2024".
    if let Some(month) = tokens.iter().find_map(|token| month_of(token)) {
        let numbers: Vec<&str> = tokens.iter().copied().filter(|t| numeric(t)).collect();
        let (day, year) = match numbers.as_slice() {
            [first, second] if first.len() == 4 => (second.parse().ok(), year_of(first)),
            [first, second] => (first.parse().ok(), year_of(second)),
            _ => return Shape::Invalid,
        };
        return match (day, year) {
            (Some(day), Some(year)) if civil::is_valid(year, month, day) => {
                Shape::Ymd(year, month, day)
            }
            _ => Shape::Invalid,
        };
    }
    if !tokens.iter().all(|t| numeric(t)) {
        return Shape::Invalid;
    }
    match tokens.as_slice() {
        [compact] if compact.len() == 8 => {
            let year = compact[..4].parse().ok();
            let month = compact[4..6].parse().ok();
            let day = compact[6..].parse().ok();
            match (year, month, day) {
                (Some(y), Some(m), Some(d)) if civil::is_valid(y, m, d) => Shape::Ymd(y, m, d),
                _ => Shape::Invalid,
            }
        }
        [first, second, third] if first.len() == 4 => {
            match (first.parse(), second.parse(), third.parse()) {
                (Ok(y), Ok(m), Ok(d)) if civil::is_valid(y, m, d) => Shape::Ymd(y, m, d),
                _ => Shape::Invalid,
            }
        }
        [first, second, third]
            if matches!(third.len(), 2 | 4) && first.len() <= 2 && second.len() <= 2 =>
        {
            match (first.parse(), second.parse(), year_of(third)) {
                (Ok(a), Ok(b), Some(year))
                    if (1..=31).contains(&a)
                        && (1..=31).contains(&b)
                        && (1900..=2199).contains(&year) =>
                {
                    Shape::Numeric { a, b, year }
                }
                _ => Shape::Invalid,
            }
        }
        _ => Shape::Invalid,
    }
}

/// The real day a shape names under `order`, as `YYYY-MM-DD`.
#[must_use]
pub fn resolve(shape: Shape, order: DateOrder) -> Option<String> {
    match shape {
        Shape::Ymd(y, m, d) => Some(civil::format(y, m, d)),
        Shape::Numeric { a, b, year } => {
            let (month, day) = match order {
                DateOrder::Mdy => (a, b),
                DateOrder::Dmy => (b, a),
                DateOrder::Ymd | DateOrder::Ask => return None,
            };
            civil::is_valid(year, month, day).then(|| civil::format(year, month, day))
        }
        Shape::Invalid => None,
    }
}

/// Decides the order of a column from every cell in it.
///
/// Counts the cells each order would make impossible (a month of 13, a 31st of
/// April). The order with strictly fewer impossible cells wins; a column where
/// both orders fit every cell — or both fail the same number — is
/// [`DateOrder::Ask`]. A column with no slash dates at all is [`DateOrder::Ymd`].
#[must_use]
pub fn decide(shapes: impl IntoIterator<Item = Shape>) -> DateOrder {
    let mut numeric = 0usize;
    let mut bad_mdy = 0usize;
    let mut bad_dmy = 0usize;
    for shape in shapes {
        if let Shape::Numeric { .. } = shape {
            numeric += 1;
            if resolve(shape, DateOrder::Mdy).is_none() {
                bad_mdy += 1;
            }
            if resolve(shape, DateOrder::Dmy).is_none() {
                bad_dmy += 1;
            }
        }
    }
    if numeric == 0 {
        return DateOrder::Ymd;
    }
    match bad_mdy.cmp(&bad_dmy) {
        std::cmp::Ordering::Less => DateOrder::Mdy,
        std::cmp::Ordering::Greater => DateOrder::Dmy,
        std::cmp::Ordering::Equal => DateOrder::Ask,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(text: &str, order: DateOrder) -> Option<String> {
        resolve(shape(text), order)
    }

    #[test]
    fn unambiguous_shapes() {
        assert_eq!(
            day("2024-01-05", DateOrder::Ymd).as_deref(),
            Some("2024-01-05")
        );
        assert_eq!(
            day("2024/1/5", DateOrder::Ymd).as_deref(),
            Some("2024-01-05")
        );
        assert_eq!(
            day("20240105", DateOrder::Ymd).as_deref(),
            Some("2024-01-05")
        );
        assert_eq!(
            day("2024-01-05T10:22:00Z", DateOrder::Ymd).as_deref(),
            Some("2024-01-05")
        );
        assert_eq!(
            day("Jan 5, 2024", DateOrder::Ymd).as_deref(),
            Some("2024-01-05")
        );
        assert_eq!(
            day("5-Jan-24", DateOrder::Ymd).as_deref(),
            Some("2024-01-05")
        );
        assert_eq!(
            day("5 September 2024", DateOrder::Ymd).as_deref(),
            Some("2024-09-05")
        );
        assert_eq!(day("2024-02-30", DateOrder::Ymd), None);
        assert_eq!(day("hello", DateOrder::Ymd), None);
    }

    #[test]
    fn slash_dates_follow_the_order_and_a_time_is_dropped() {
        assert_eq!(
            day("03/04/2024", DateOrder::Mdy).as_deref(),
            Some("2024-03-04")
        );
        assert_eq!(
            day("03/04/2024", DateOrder::Dmy).as_deref(),
            Some("2024-04-03")
        );
        assert_eq!(
            day("13/04/2024 08:15 PM", DateOrder::Dmy).as_deref(),
            Some("2024-04-13")
        );
        assert_eq!(day("13/04/2024", DateOrder::Mdy), None);
        assert_eq!(
            day("03/04/24", DateOrder::Mdy).as_deref(),
            Some("2024-03-04")
        );
    }

    #[test]
    fn a_day_over_twelve_anywhere_in_the_column_decides_it() {
        let cells = ["03/04/2024", "05/06/2024", "21/06/2024"];
        assert_eq!(decide(cells.iter().map(|c| shape(c))), DateOrder::Dmy);
        let cells = ["03/04/2024", "06/21/2024"];
        assert_eq!(decide(cells.iter().map(|c| shape(c))), DateOrder::Mdy);
    }

    #[test]
    fn a_column_that_fits_both_asks_and_never_guesses() {
        let cells = ["03/04/2024", "05/06/2024", "11/12/2024"];
        assert_eq!(decide(cells.iter().map(|c| shape(c))), DateOrder::Ask);
        assert_eq!(decide(std::iter::empty()), DateOrder::Ymd);
    }
}
