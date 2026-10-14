//! A printed amount to signed minor units.
//!
//! Reads what banks print: thousands separators (`1,234.50`, `1.234,50`,
//! `1 234,50`, `1'234.50`), parentheses negatives, a leading or trailing minus,
//! currency symbols and codes on either side, and a `CR`/`DR` suffix. A cell
//! that is none of these is an error, never a guess.

use super::MAX_AMOUNT_MINOR;

/// Why a cell is not an amount.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmountError {
    /// No digits at all.
    Empty,
    Unreadable,
    TooLarge,
}

/// A read amount and whether the cell said which way it moved in words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadAmount {
    /// Signed minor units; negative is money out.
    pub minor: i64,
    /// A `CR`/`DR` marker was present, so the sign is the bank's own.
    pub marked: bool,
}

/// Reads `text` as an amount with `exponent` minor-unit digits (2 for USD).
///
/// # Errors
/// [`AmountError`] when the cell is empty, not an amount, or too large.
pub fn parse(text: &str, exponent: u8) -> Result<ReadAmount, AmountError> {
    let mut rest: &str = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{a0}');
    if rest.is_empty() {
        return Err(AmountError::Empty);
    }
    let mut negative = false;
    let mut marked = false;
    // Parentheses: (12.30) is money out.
    if let Some(inner) = rest.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
        negative = true;
        rest = inner.trim();
    }
    // A CR/DR suffix.
    let upper = rest.to_ascii_uppercase();
    if let Some(stripped) = upper.strip_suffix("DR") {
        negative = !negative;
        marked = true;
        rest = rest[..stripped.len()].trim_end();
    } else if let Some(stripped) = upper.strip_suffix("CR") {
        marked = true;
        rest = rest[..stripped.len()].trim_end();
    }
    let (rest, lead) = strip_sign(rest);
    negative ^= lead;
    let rest = strip_currency(rest, true);
    let (rest, lead_again) = strip_sign(rest);
    negative ^= lead_again;
    let rest = strip_currency(rest, false);
    let (core, trailing) = strip_trailing_sign(rest);
    negative ^= trailing;
    let core = strip_currency(core, false).trim();
    let core: String = core
        .chars()
        .filter(|c| !matches!(c, ' ' | '\'' | '\u{a0}' | '\u{202f}'))
        .collect();
    if core.is_empty() || !core.chars().any(|c| c.is_ascii_digit()) {
        return Err(AmountError::Empty);
    }
    if !core
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
    {
        return Err(AmountError::Unreadable);
    }
    let magnitude = magnitude_minor(&core, exponent)?;
    if magnitude > MAX_AMOUNT_MINOR {
        return Err(AmountError::TooLarge);
    }
    Ok(ReadAmount {
        minor: if negative { -magnitude } else { magnitude },
        marked,
    })
}

fn strip_sign(text: &str) -> (&str, bool) {
    let text = text.trim_start();
    match text.chars().next() {
        Some('-' | '\u{2212}') => (
            text[text.chars().next().map_or(0, char::len_utf8)..].trim_start(),
            true,
        ),
        Some('+') => (text[1..].trim_start(), false),
        _ => (text, false),
    }
}

fn strip_trailing_sign(text: &str) -> (&str, bool) {
    let text = text.trim_end();
    if let Some(core) = text
        .strip_suffix('-')
        .or_else(|| text.strip_suffix('\u{2212}'))
    {
        (core.trim_end(), true)
    } else if let Some(core) = text.strip_suffix('+') {
        (core.trim_end(), false)
    } else {
        (text, false)
    }
}

/// ISO codes a statement prints beside an amount.
const CODES: [&str; 20] = [
    "USD", "CAD", "EUR", "GBP", "AUD", "NZD", "JPY", "CHF", "MXN", "INR", "CNY", "HKD", "SEK",
    "NOK", "DKK", "SGD", "ZAR", "BRL", "KRW", "ILS",
];
/// Letters that are a currency only when glued to a `$` (`CA$`, `US$`, `C$`).
const DOLLARS: [&str; 9] = ["CA", "US", "AU", "NZ", "HK", "MX", "C", "A", "S"];

/// Whether `mark` (the text beside the digits) is a currency symbol or code and
/// nothing else. A merchant's `ROW 0` or `ATM 100` is not an amount.
fn is_currency(mark: &str) -> bool {
    let letters: String = mark
        .chars()
        .filter(char::is_ascii_alphabetic)
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let symbol = mark
        .chars()
        .any(|c| matches!(c, '$' | '€' | '£' | '¥' | '₹' | '₩'));
    let other = mark.chars().any(|c| {
        !(c.is_ascii_alphabetic() || c == ' ' || matches!(c, '$' | '€' | '£' | '¥' | '₹' | '₩'))
    });
    !other
        && (letters.is_empty()
            || CODES.contains(&letters.as_str())
            || (symbol && DOLLARS.contains(&letters.as_str())))
}

/// Drops a currency symbol or code from the front (or, when `front` is false,
/// the back) of `text`.
fn strip_currency(text: &str, front: bool) -> &str {
    let is_mark =
        |c: char| matches!(c, '$' | '€' | '£' | '¥' | '₹' | '₩' | ' ') || c.is_ascii_alphabetic();
    let text = text.trim();
    if front {
        let end = text
            .char_indices()
            .find(|&(_, c)| !is_mark(c))
            .map_or(text.len(), |(at, _)| at);
        if is_currency(&text[..end]) {
            text[end..].trim_start()
        } else {
            text
        }
    } else {
        let start = text
            .char_indices()
            .rev()
            .find(|&(_, c)| !is_mark(c))
            .map_or(0, |(at, c)| at + c.len_utf8());
        if is_currency(&text[start..]) {
            text[..start].trim_end()
        } else {
            text
        }
    }
}

fn magnitude_minor(core: &str, exponent: u8) -> Result<i64, AmountError> {
    let exponent = usize::from(exponent);
    let last_dot = core.rfind('.');
    let last_comma = core.rfind(',');
    let dots = core.matches('.').count();
    let commas = core.matches(',').count();
    let decimal_at: Option<usize> = match (last_dot, last_comma) {
        (None, None) => None,
        (Some(dot), Some(comma)) => Some(dot.max(comma)),
        (Some(at), None) => decimal_or_thousands(core, at, dots, '.', exponent),
        (None, Some(at)) => decimal_or_thousands(core, at, commas, ',', exponent),
    };
    let (int_part, frac_part) = match decimal_at {
        Some(at) => (&core[..at], &core[at + 1..]),
        None => (core, ""),
    };
    // Whatever separators remain in the integer part are thousands marks; they
    // must sit between groups of three.
    let groups: Vec<&str> = int_part.split(['.', ',']).collect();
    if groups.len() > 1 {
        let (head, tail) = groups.split_first().ok_or(AmountError::Unreadable)?;
        if head.is_empty() || head.len() > 3 || tail.iter().any(|group| group.len() != 3) {
            return Err(AmountError::Unreadable);
        }
    }
    if frac_part.contains(['.', ',']) {
        return Err(AmountError::Unreadable);
    }
    let int_digits: String = int_part.chars().filter(char::is_ascii_digit).collect();
    let (kept, extra) = if frac_part.len() > exponent {
        frac_part.split_at(exponent)
    } else {
        (frac_part, "")
    };
    if extra.chars().any(|c| c != '0') {
        return Err(AmountError::Unreadable);
    }
    let mut digits = int_digits;
    digits.push_str(kept);
    for _ in kept.len()..exponent {
        digits.push('0');
    }
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return Ok(0);
    }
    if digits.len() > 15 {
        return Err(AmountError::TooLarge);
    }
    digits.parse::<i64>().map_err(|_| AmountError::Unreadable)
}

/// Where the decimal point is when the text has only one kind of separator, or
/// `None` when every such separator is a thousands mark.
fn decimal_or_thousands(
    core: &str,
    last: usize,
    count: usize,
    separator: char,
    exponent: usize,
) -> Option<usize> {
    let after = core.len() - last - 1;
    if count > 1 {
        return None;
    }
    if separator == '.' {
        // North American default: a lone dot is a decimal point, except where
        // the currency has no minor unit and three digits follow.
        return if exponent == 0 && after == 3 {
            None
        } else {
            Some(last)
        };
    }
    // A lone comma: three digits after it is a thousands mark; one or two
    // (within the currency's exponent) is a decimal comma.
    if after == 3 || exponent == 0 {
        None
    } else {
        Some(last)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> Result<i64, AmountError> {
        parse(text, 2).map(|amount| amount.minor)
    }

    #[test]
    fn common_shapes() {
        assert_eq!(p("12.30"), Ok(1230));
        assert_eq!(p("-12.3"), Ok(-1230));
        assert_eq!(p("(1,234.50)"), Ok(-123_450));
        assert_eq!(p("$1,234.50"), Ok(123_450));
        assert_eq!(p("-$5.00"), Ok(-500));
        assert_eq!(p("$-5.00"), Ok(-500));
        assert_eq!(p("12.30-"), Ok(-1230));
        assert_eq!(p("USD 7"), Ok(700));
        assert_eq!(p("CA$ 7.5"), Ok(750));
        assert_eq!(p("1.234,50"), Ok(123_450));
        assert_eq!(p("1 234,50"), Ok(123_450));
        assert_eq!(p("12,50"), Ok(1250));
        assert_eq!(p("1,234"), Ok(123_400));
        assert_eq!(p("1'234.00"), Ok(123_400));
        assert_eq!(p(".5"), Ok(50));
        assert_eq!(p("\u{2212}3.00"), Ok(-300));
        assert_eq!(p("0.00"), Ok(0));
    }

    #[test]
    fn credit_and_debit_suffixes_are_marked() {
        assert_eq!(
            parse("45.00 DR", 2),
            Ok(ReadAmount {
                minor: -4500,
                marked: true
            })
        );
        assert_eq!(
            parse("45.00CR", 2),
            Ok(ReadAmount {
                minor: 4500,
                marked: true
            })
        );
    }

    #[test]
    fn what_is_not_an_amount_is_an_error_not_a_guess() {
        assert_eq!(p(""), Err(AmountError::Empty));
        assert_eq!(p("n/a"), Err(AmountError::Empty));
        assert_eq!(p("01/05/2024"), Err(AmountError::Unreadable));
        assert_eq!(p("2024-01-05"), Err(AmountError::Unreadable));
        assert_eq!(p("12.345"), Err(AmountError::Unreadable));
        assert_eq!(p("1,23,456.00"), Err(AmountError::Unreadable));
        assert_eq!(p("99999999999999.99"), Err(AmountError::TooLarge));
        // A merchant with a number is not an amount.
        assert_eq!(p("ROW 0"), Err(AmountError::Unreadable));
        assert_eq!(p("ATM 100"), Err(AmountError::Unreadable));
        assert_eq!(p("CHECK 1042"), Err(AmountError::Unreadable));
    }

    #[test]
    fn a_currency_without_minor_units_reads_a_dot_as_thousands() {
        assert_eq!(parse("1,234", 0).map(|a| a.minor), Ok(1234));
        assert_eq!(parse("1.234", 0).map(|a| a.minor), Ok(1234));
    }
}
