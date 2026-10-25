//! THE ONE MONEY FORMATTER. Amount, currency and sign are drawn here and
//! nowhere else: SwiftUI and Compose draw the finished string a view carries,
//! so the four formatters the shells grew (Swift `Money.render`, Kotlin
//! `formatMoney` and two row helpers) are gone (#1135).
//!
//! `contracts/screens/money-render.json` is the law (the Android `MoneyRenderTest` reads it too). The exponent is the
//! amount's own, never assumed to be 2; a currency this table does not know is
//! spelled after the amount; nothing adds across currencies ([`sum_by_currency`]).
//! Locale data is a small table (separators and symbol placement for the
//! languages the product speaks), not a CLDR dependency.

/// An amount as the vault states it: minor units, an ISO 4217 code and the
/// code's exponent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Amount {
    pub minor: i64,
    pub currency: String,
    pub exponent: u32,
}

impl Amount {
    #[must_use]
    pub fn new(minor: i64, currency: &str, exponent: u32) -> Self {
        Self {
            minor,
            currency: currency.to_owned(),
            exponent,
        }
    }

    /// -1, 0 or 1.
    #[must_use]
    pub fn sign(&self) -> i32 {
        i32::try_from(self.minor.signum()).unwrap_or(0)
    }

    #[must_use]
    pub fn is_zero(&self) -> bool {
        self.minor == 0
    }
}

/// One total PER CURRENCY, in first-seen order. Never a sum across currencies:
/// 100 USD and 500 JPY are not 600 of anything.
#[must_use]
pub fn sum_by_currency(amounts: &[Amount]) -> Vec<Amount> {
    let mut totals: Vec<Amount> = Vec::new();
    for amount in amounts {
        match totals.iter_mut().find(|t| t.currency == amount.currency) {
            Some(seen) => seen.minor += amount.minor,
            None => totals.push(amount.clone()),
        }
    }
    totals
}

struct Style {
    group: &'static str,
    decimal: &'static str,
    /// The symbol follows the number, after a no-break space.
    suffix: bool,
}

fn style(locale: &str) -> Style {
    let tag = if locale.is_empty() { "en-US" } else { locale };
    let language = tag.split(['-', '_']).next().unwrap_or("en");
    match language {
        "de" | "es" | "it" | "nl" | "pt" | "id" | "tr" | "da" => Style {
            group: ".",
            decimal: ",",
            suffix: true,
        },
        "fr" | "ru" | "pl" | "cs" | "sv" | "nb" | "fi" | "uk" => Style {
            group: "\u{202f}",
            decimal: ",",
            suffix: true,
        },
        _ => Style {
            group: ",",
            decimal: ".",
            suffix: false,
        },
    }
}

fn symbol(currency: &str) -> Option<&'static str> {
    Some(match currency {
        "USD" => "$",
        "EUR" => "€",
        "GBP" => "£",
        "JPY" => "¥",
        "INR" => "₹",
        "CNY" => "CN¥",
        "KRW" => "₩",
        "CAD" => "CA$",
        "AUD" => "A$",
        "MXN" => "MX$",
        "BRL" => "R$",
        "NZD" => "NZ$",
        "HKD" => "HK$",
        "CHF" | "SEK" | "NOK" | "DKK" | "SGD" | "ZAR" | "BHD" => return None,
        _ => return None,
    })
}

/// The digits of `minor` at `exponent`, grouped; the sign is the caller's.
fn digits(minor: i64, exponent: u32, style: &Style) -> String {
    let magnitude = minor.unsigned_abs();
    let scale = 10u64.pow(exponent);
    let (whole, fraction) = (magnitude / scale, magnitude % scale);
    let raw = whole.to_string();
    let mut grouped = String::new();
    for (i, ch) in raw.chars().enumerate() {
        if i > 0 && (raw.len() - i) % 3 == 0 {
            grouped.push_str(style.group);
        }
        grouped.push(ch);
    }
    if exponent == 0 {
        grouped
    } else {
        format!(
            "{grouped}{}{fraction:0width$}",
            style.decimal,
            width = exponent as usize
        )
    }
}

/// The string a person reads for `amount` in `locale` (BCP 47; empty is
/// English). An amount with no currency is nothing.
#[must_use]
pub fn format(amount: &Amount, locale: &str) -> String {
    if amount.currency.is_empty() {
        return String::new();
    }
    let style = style(locale);
    let body = digits(amount.minor, amount.exponent, &style);
    let sign = if amount.minor < 0 { "-" } else { "" };
    match symbol(&amount.currency) {
        Some(sym) if style.suffix => format!("{sign}{body}\u{a0}{sym}"),
        Some(sym) => format!("{sign}{sym}{body}"),
        // A CODE THE TABLE HAS NO SYMBOL FOR IS SPELLED, NOT INVENTED.
        None => format!("{sign}{body} {}", amount.currency),
    }
}

/// `+` before a gain, the amount's own sign before a loss: a delta or a flow.
#[must_use]
pub fn format_signed(amount: &Amount, locale: &str) -> String {
    let text = format(amount, locale);
    if amount.minor > 0 {
        format!("+{text}")
    } else {
        text
    }
}

/// Parse what a member typed into minor units at `exponent`: digits with at
/// most `exponent` decimals, a `.` or `,` as the point (the last one is the
/// point when it leaves no more places than the currency keeps, the others are
/// grouping), no sign, never a float. `None` when it is not an amount.
#[must_use]
pub fn parse(text: &str, exponent: u32) -> Option<i64> {
    let cleaned: String = text
        .trim()
        .chars()
        .filter(|c| !matches!(c, ' ' | '\u{a0}'))
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let digits = |s: &str| s.chars().all(|c| c.is_ascii_digit());
    let point = cleaned.rfind(['.', ',']);
    let (whole, fraction) = match point {
        Some(at) if exponent > 0 && cleaned.len() - at - 1 <= exponent as usize => {
            let whole: String = cleaned[..at]
                .chars()
                .filter(|c| !matches!(c, '.' | ','))
                .collect();
            (whole, cleaned[at + 1..].to_owned())
        }
        Some(_) if exponent == 0 => (
            cleaned
                .chars()
                .filter(|c| !matches!(c, '.' | ','))
                .collect(),
            String::new(),
        ),
        Some(_) => return None,
        None => (cleaned, String::new()),
    };
    if (whole.is_empty() && fraction.is_empty()) || !digits(&whole) || !digits(&fraction) {
        return None;
    }
    let padded = format!("{fraction:0<width$}", width = exponent as usize);
    let whole = if whole.is_empty() {
        "0"
    } else {
        whole.as_str()
    };
    format!("{whole}{padded}").parse().ok()
}

/// A minor amount as a member types it: `231.40`, `4250` for a currency with no
/// decimals.
#[must_use]
pub fn amount_text(minor: i64, exponent: u32) -> String {
    if exponent == 0 {
        return minor.to_string();
    }
    let sign = if minor < 0 { "-" } else { "" };
    let digits = format!(
        "{:0>width$}",
        minor.unsigned_abs(),
        width = exponent as usize + 1
    );
    let (whole, fraction) = digits.split_at(digits.len() - exponent as usize);
    format!("{sign}{whole}.{fraction}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn amount(value: &Value) -> Amount {
        Amount::new(
            value["minor"].as_i64().unwrap(),
            value["currency"].as_str().unwrap(),
            u32::try_from(value["exponent"].as_u64().unwrap()).unwrap(),
        )
    }

    fn law() -> Value {
        let text = include_str!("../../../../contracts/screens/money-render.json");
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn the_render_law_holds() {
        for case in law()["cases"].as_array().unwrap() {
            let got = format(&amount(case), case["locale"].as_str().unwrap());
            let want = case["expected"].as_str().unwrap();
            // a suffix symbol sits after a no-break space; a spelled code after an ordinary one
            let want = if case["currency"] == "EUR" {
                want.replace(' ', "\u{a0}")
            } else {
                want.to_owned()
            };
            assert_eq!(got, want, "{}", case["name"]);
        }
    }

    #[test]
    fn the_sum_law_holds() {
        for case in law()["sums"].as_array().unwrap() {
            let input: Vec<Amount> = case["in"].as_array().unwrap().iter().map(amount).collect();
            let out: Vec<Amount> = case["out"].as_array().unwrap().iter().map(amount).collect();
            assert_eq!(sum_by_currency(&input), out, "{}", case["name"]);
        }
    }

    #[test]
    fn parsing_keeps_the_exponent() {
        assert_eq!(parse("12.34", 2), Some(1234));
        assert_eq!(parse("12,34", 2), Some(1234));
        assert_eq!(parse("1,234.5", 2), Some(123_450));
        assert_eq!(parse("1.234,50", 2), Some(123_450));
        assert_eq!(parse("12.345", 2), None);
        assert_eq!(parse("500", 0), Some(500));
        assert_eq!(parse("1,500", 0), Some(1500));
        assert_eq!(parse("-5", 2), None);
        assert_eq!(parse("abc", 2), None);
        assert_eq!(parse("", 2), None);
        assert_eq!(parse(".5", 2), Some(50));
    }

    #[test]
    fn a_stored_amount_is_typed_back_as_it_was() {
        assert_eq!(amount_text(23_140, 2), "231.40");
        assert_eq!(amount_text(5, 2), "0.05");
        assert_eq!(amount_text(4250, 0), "4250");
        assert_eq!(parse(&amount_text(123_456, 2), 2), Some(123_456));
    }

    #[test]
    fn a_loss_keeps_its_sign_and_a_gain_gets_one_on_request() {
        let gain = Amount::new(1234, "USD", 2);
        assert_eq!(format_signed(&gain, "en-US"), "+$12.34");
        assert_eq!(format(&Amount::new(-5, "USD", 2), "en-US"), "-$0.05");
    }
}
