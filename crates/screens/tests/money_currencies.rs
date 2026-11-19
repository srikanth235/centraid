//! MONEY IN EVERY CURRENCY (#1202, S12): amounts are minor units at the currency's own exponent,
//! a symbol is the table's, and a code the table has no symbol for is spelled, never invented.
//! `contracts/screens/money-render.json` holds the US-dollar law; these hold the rest.

use centraid_screens::kit::money::{Amount, format, format_signed, parse, sum_by_currency};

const NBSP: &str = "\u{a0}";

#[test]
fn a_zero_decimal_currency_shows_no_decimals_and_keeps_its_symbol() {
    // 1,234,567 yen is 1,234,567 minor units: dividing by 100 was the bug this guards.
    let yen = Amount::new(1_234_567, "JPY", 0);
    assert_eq!(format(&yen, "en-US"), "¥1,234,567");
    assert_eq!(format(&yen, "ja-JP"), "¥1,234,567");
    assert_eq!(format(&Amount::new(-500, "JPY", 0), "en-US"), "-¥500");
    assert_eq!(format(&Amount::new(0, "JPY", 0), "en-US"), "¥0");
    assert_eq!(
        format(&Amount::new(1_500_000, "KRW", 0), "en-US"),
        "₩1,500,000"
    );
    assert_eq!(format_signed(&yen, "en-US"), "+¥1,234,567");
}

#[test]
fn a_three_decimal_currency_keeps_three_places_and_is_spelled() {
    assert_eq!(
        format(&Amount::new(1_234_567, "KWD", 3), "en-US"),
        "1,234.567 KWD"
    );
    assert_eq!(format(&Amount::new(5, "BHD", 3), "en-US"), "0.005 BHD");
}

#[test]
fn non_dollar_symbols_are_the_tables_and_other_dollars_are_told_apart() {
    for (code, want) in [
        ("EUR", "€12.34"),
        ("GBP", "£12.34"),
        ("INR", "₹12.34"),
        ("CAD", "CA$12.34"),
        ("AUD", "A$12.34"),
        ("MXN", "MX$12.34"),
        ("BRL", "R$12.34"),
        ("NZD", "NZ$12.34"),
        ("HKD", "HK$12.34"),
        ("CNY", "CN¥12.34"),
        // No symbol of its own in the table: spelled after the amount.
        ("CHF", "12.34 CHF"),
        ("SEK", "12.34 SEK"),
        ("SGD", "12.34 SGD"),
    ] {
        assert_eq!(format(&Amount::new(1234, code, 2), "en-US"), want, "{code}");
    }
}

#[test]
fn the_locale_moves_the_separators_and_the_symbol_never_the_digits() {
    let euro = Amount::new(123_456_789, "EUR", 2);
    assert_eq!(format(&euro, "de-DE"), format!("1.234.567,89{NBSP}€"));
    assert_eq!(
        format(&euro, "fr-FR"),
        format!("1\u{202f}234\u{202f}567,89{NBSP}€")
    );
    assert_eq!(format(&euro, "en-GB"), "€1,234,567.89");
    // An empty or unknown locale is English, as stated.
    assert_eq!(format(&euro, ""), "€1,234,567.89");
    assert_eq!(format(&euro, "xx-YY"), "€1,234,567.89");
    // A spelled code in a suffix locale keeps the ordinary space.
    assert_eq!(
        format(&Amount::new(123_456, "CHF", 2), "de-CH"),
        "1.234,56 CHF"
    );
}

#[test]
fn nothing_adds_across_currencies_and_each_keeps_its_exponent() {
    let sums = sum_by_currency(&[
        Amount::new(100, "USD", 2),
        Amount::new(250, "JPY", 0),
        Amount::new(50, "USD", 2),
        Amount::new(750, "JPY", 0),
    ]);
    let mut shown: Vec<String> = sums.iter().map(|a| format(a, "en-US")).collect();
    shown.sort();
    assert_eq!(shown, ["$1.50", "¥1,000"]);
}

#[test]
fn what_a_member_types_is_read_at_the_currencys_exponent() {
    assert_eq!(parse("1500", 0), Some(1500), "yen has no cents");
    // With no minor unit a point can only be grouping, so a yen is never read as a fraction.
    assert_eq!(parse("1.500", 0), Some(1500));
    assert_eq!(parse("1,500", 0), Some(1500));
    assert_eq!(parse("12.345", 3), Some(12_345));
    assert_eq!(parse("12.345", 2), None);
}
