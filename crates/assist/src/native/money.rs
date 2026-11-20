//! AN AMOUNT AS A PERSON SAYS IT, read with its currency (the owner's ruling of 2026-11-20: the assistant
//! handles money in many currencies, and every amount it reads or writes carries one).
//!
//! `₹2.5 lakh`, `1.2 crore`, `$1,200`, `€40`, `1,500 rupees`, `2,50,000 INR`, `-$45.50`, `12k USD`: a sign, a
//! currency symbol or code or name, the figure with its separators, and a scale word (thousand, lakh, crore,
//! million, billion). The figure is read as an exact decimal, never a float: the result is the whole number of
//! MINOR units of the currency, by the exponent ISO 4217 gives that currency (two for the dollar, none for the yen,
//! three for the dinar). A figure with more places than the currency has is refused, never rounded: it would store
//! another sum than the one stated.
//!
//! What is stated is kept apart from what is meant: [`Stated`] says the currency the text names (if it names one) and
//! whether it wrote a sign, and the caller decides what a currency that is not the row's means (an account's opening
//! balance refuses it; a plan takes it as its own).

use centraid_apps_kit::money::minor_units;

/// The currency words a person says, and the codes each may be: the vault's own codes decide which one is meant.
const WORDS: [(&str, &[&str]); 29] = [
    ("dollar", &["USD", "CAD", "AUD", "NZD", "SGD", "HKD"]),
    ("buck", &["USD"]),
    ("euro", &["EUR"]),
    ("pound", &["GBP"]),
    ("sterling", &["GBP"]),
    ("quid", &["GBP"]),
    (
        "peso",
        &["MXN", "COP", "ARS", "CLP", "PHP", "UYU", "DOP", "CUP"],
    ),
    ("rupee", &["INR", "PKR", "LKR", "NPR"]),
    ("yen", &["JPY"]),
    ("yuan", &["CNY"]),
    ("renminbi", &["CNY"]),
    ("franc", &["CHF", "XOF", "XAF"]),
    ("krona", &["SEK", "ISK"]),
    ("krone", &["NOK", "DKK"]),
    ("won", &["KRW"]),
    ("baht", &["THB"]),
    ("real", &["BRL"]),
    ("rand", &["ZAR"]),
    ("dirham", &["AED", "MAD"]),
    ("riyal", &["SAR", "QAR"]),
    ("shekel", &["ILS"]),
    ("lira", &["TRY"]),
    ("ruble", &["RUB"]),
    ("rouble", &["RUB"]),
    ("zloty", &["PLN"]),
    ("forint", &["HUF"]),
    ("dong", &["VND"]),
    ("ringgit", &["MYR"]),
    ("rupiah", &["IDR"]),
];

/// The currency symbols an amount may start with, and the codes each names.
pub(crate) const SYMBOLS: [(char, &[&str]); 5] = [
    ('$', &["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN"]),
    ('\u{20ac}', &["EUR"]),
    ('\u{a3}', &["GBP"]),
    ('\u{a5}', &["JPY", "CNY"]),
    ('\u{20b9}', &["INR"]),
];

/// The characters a currency symbol is, for a caller that trims them off a figure.
pub(crate) const SYMBOL_CHARS: [char; 5] = ['$', '\u{20ac}', '\u{a3}', '\u{a5}', '\u{20b9}'];

/// A scale word after a figure, and the power of ten it is.
fn scale_of(word: &str) -> Option<u32> {
    match word.to_lowercase().trim_end_matches('.') {
        "k" | "thousand" | "thousands" => Some(3),
        "lakh" | "lakhs" | "lac" | "lacs" | "lk" => Some(5),
        "m" | "mn" | "mm" | "million" | "millions" => Some(6),
        "crore" | "crores" | "cr" => Some(7),
        "b" | "bn" | "billion" | "billions" => Some(9),
        _ => None,
    }
}

/// What a text says of an amount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stated {
    /// The figure in minor units of [`Stated::currency`] or, when the text names none, of the `currency` it was read
    /// in. Signed when the text wrote a sign; magnitude otherwise.
    pub minor: i64,
    /// The currency the text names (a symbol, a code or a name), settled to one ISO code; `None` when it names none.
    pub currency: Option<String>,
    /// Whether the text wrote a sign (`-`, `+`, `minus`, parentheses).
    pub signed: bool,
}

/// `Err` sentence for an amount nobody can read.
fn unreadable(field: &str, text: &str) -> String {
    format!(
        "error: {field} is an amount, optionally with a currency (50, $50, 50 EUR, 2.5 lakh INR); \"{}\" is not.",
        text.trim()
    )
}

/// The currency a symbol means among `held` and `row`: the row's own when the symbol can be it, else the one the
/// vault holds, else the symbol's only meaning (the dollar alone is the US one).
fn of_symbol(symbol: char, row: &str, held: &[String]) -> Result<String, String> {
    let family = SYMBOLS
        .iter()
        .find(|(known, _)| *known == symbol)
        .map_or(&[][..], |(_, codes)| *codes);
    if family.contains(&row) {
        return Ok(row.to_owned());
    }
    let among: Vec<&str> = family
        .iter()
        .copied()
        .filter(|code| held.iter().any(|have| have == code))
        .collect();
    match among.as_slice() {
        [only] => Ok((*only).to_owned()),
        [] => match family {
            [only] => Ok((*only).to_owned()),
            _ if symbol == '$' => Ok("USD".to_owned()),
            _ if symbol == '\u{a5}' => Ok("JPY".to_owned()),
            _ => Err(format!(
                "error: {symbol} names more than one currency ({}); write the amount with its code (50 {}).",
                family.join(", "),
                family.first().copied().unwrap_or("USD")
            )),
        },
        several => Err(format!(
            "error: {symbol} names more than one currency here ({}); write the amount with its code (50 {}).",
            several.join(", "),
            several[0]
        )),
    }
}

/// The singular of a currency word: `rupees`, `euros`, `pesos`.
fn singular(word: &str) -> String {
    let word = word.to_lowercase();
    match word.as_str() {
        "reais" => "real".to_owned(),
        "kronor" | "kronur" | "kronas" => "krona".to_owned(),
        "kroner" | "kronen" => "krone".to_owned(),
        other => other
            .strip_suffix("es")
            .filter(|rest| WORDS.iter().any(|(name, _)| name == rest))
            .or_else(|| other.strip_suffix('s'))
            .unwrap_or(other)
            .to_owned(),
    }
}

/// The ISO code a currency word or code means: a three-letter code is itself (upper case); a name is the one of its
/// codes the vault holds (the row's own first); with several held it is an error, with none held it is the name's
/// only code.
fn of_word(word: &str, row: &str, held: &[String]) -> Result<Option<String>, String> {
    let word = word.trim_matches(|c: char| !c.is_alphanumeric());
    if word.len() == 3 && word.chars().all(|c| c.is_ascii_alphabetic()) && scale_of(word).is_none()
    {
        let upper = word.to_ascii_uppercase();
        // `rup`, `usd`, `inr`: a code; the three letters of a name ("won") are a name before they are a code
        let name = WORDS.iter().any(|(name, _)| *name == word.to_lowercase());
        if !name {
            return Ok(Some(upper));
        }
    }
    let Some(codes) = WORDS
        .iter()
        .find(|(name, _)| *name == singular(word))
        .map(|(_, codes)| *codes)
    else {
        return Ok(None);
    };
    if codes.contains(&row) {
        return Ok(Some(row.to_owned()));
    }
    let among: Vec<&str> = codes
        .iter()
        .copied()
        .filter(|code| held.iter().any(|have| have == code))
        .collect();
    match (among.as_slice(), codes) {
        ([only], _) => Ok(Some((*only).to_owned())),
        ([], [only]) => Ok(Some((*only).to_owned())),
        ([], several) | (several, _) => Err(format!(
            "error: \"{word}\" could be {}; write the amount with its code (50 {}).",
            several.join(", "),
            several[0]
        )),
    }
}

/// The figure `digits` (with separators) as a whole and its fractional digits, grouped the way English or Indian
/// writing groups them (`1,200`, `2,50,000`), or `None`.
fn figure(text: &str) -> Option<(String, String)> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    if whole.is_empty() && fraction.is_empty() {
        return None;
    }
    let whole = if whole.contains(',') {
        let groups: Vec<&str> = whole.split(',').collect();
        let first_ok = (1..=3).contains(&groups[0].len());
        let last_ok = groups.last().is_some_and(|last| last.len() == 3);
        let middle_ok = groups[1..groups.len() - 1]
            .iter()
            .all(|group| group.len() == 2 || group.len() == 3);
        if !(first_ok && last_ok && middle_ok) {
            return None;
        }
        groups.concat()
    } else {
        whole.to_owned()
    };
    let digits = |part: &str| part.chars().all(|c| c.is_ascii_digit());
    (digits(&whole) && digits(fraction)).then_some((whole, fraction.to_owned()))
}

/// `whole.fraction` times ten to the `shift`, as a whole number; `None` when the fraction does not end before the
/// shift does (more places than the unit has) or the number does not fit.
fn shifted(whole: &str, fraction: &str, shift: u32) -> Option<i64> {
    let fraction = fraction.trim_end_matches('0');
    if fraction.len() > shift as usize {
        return None;
    }
    let padded = format!("{fraction:0<width$}", width = shift as usize);
    let joined = format!("{whole}{padded}");
    let trimmed = joined.trim_start_matches('0');
    if trimmed.is_empty() {
        return Some(0);
    }
    trimmed.parse::<i64>().ok()
}

/// Read `text` as an amount of the field `field`, for a row in `row_currency`; `held` are the currencies the vault
/// holds (what a symbol or a name is settled against).
///
/// # Errors
///
/// A sentence the model can act on, when the text is no amount, names two currencies, names one it cannot settle, or
/// has more places than the currency's minor unit.
pub fn read(
    field: &str,
    text: &str,
    row_currency: &str,
    held: &[String],
) -> Result<Stated, String> {
    let mut rest = text.trim();
    let mut negative = false;
    let mut signed = false;
    let mut currency: Option<String> = None;
    let say = |code: String, currency: &mut Option<String>| -> Result<(), String> {
        match currency {
            Some(had) if *had != code => Err(format!(
                "error: {field}: \"{}\" names {had} and {code}; one amount has one currency.",
                text.trim()
            )),
            _ => {
                *currency = Some(code);
                Ok(())
            }
        }
    };
    // `(45.50)` is an accountant's minus
    if let Some(inner) = rest
        .strip_prefix('(')
        .and_then(|inner| inner.strip_suffix(')'))
    {
        rest = inner.trim();
        negative = true;
        signed = true;
    }
    // sign, symbol, code or word, in front of the figure, in any order the person writes them
    loop {
        let before = rest;
        if let Some(after) = rest.strip_prefix(['-', '\u{2212}']) {
            negative = !negative;
            signed = true;
            rest = after.trim_start();
        } else if let Some(after) = rest.strip_prefix('+') {
            signed = true;
            rest = after.trim_start();
        } else if let Some(symbol) = rest.chars().next().filter(|c| SYMBOL_CHARS.contains(c)) {
            say(of_symbol(symbol, row_currency, held)?, &mut currency)?;
            rest = rest[symbol.len_utf8()..].trim_start();
        } else if rest.chars().next().is_some_and(char::is_alphabetic) {
            // a word in front: `Rs 500`, `INR 500`, `minus 40`, `USD -40`
            let end = rest
                .find(|c: char| !(c.is_alphabetic() || c == '.'))
                .unwrap_or(rest.len());
            let (word, after) = rest.split_at(end);
            if word.eq_ignore_ascii_case("minus") {
                negative = true;
                signed = true;
            } else if matches!(word.to_lowercase().trim_end_matches('.'), "rs" | "re") {
                say("INR".to_owned(), &mut currency)?;
            } else if let Some(code) = of_word(word, row_currency, held)? {
                say(code, &mut currency)?;
            } else {
                return Err(unreadable(field, text));
            }
            rest = after.trim_start();
        }
        if rest == before {
            break;
        }
    }
    // the figure, possibly with a scale glued on (`12k`, `2.5cr`)
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == ',' || c == '.'))
        .unwrap_or(rest.len());
    let (number, mut after) = rest.split_at(end);
    let (whole, fraction) = figure(number).ok_or_else(|| unreadable(field, text))?;
    let mut scale = 0;
    let glued_end = after
        .find(|c: char| !c.is_alphabetic())
        .unwrap_or(after.len());
    if glued_end > 0
        && let Some(power) = scale_of(&after[..glued_end])
    {
        scale = power;
        after = after[glued_end..].trim_start();
    } else {
        after = after.trim_start();
        // a scale word after a space: `2.5 lakh`
        let word_end = after
            .find(|c: char| !(c.is_alphabetic() || c == '.'))
            .unwrap_or(after.len());
        if word_end > 0
            && let Some(power) = scale_of(&after[..word_end])
        {
            scale = power;
            after = after[word_end..].trim_start();
        }
    }
    // the currency after the figure: a code or a name
    if !after.is_empty() {
        let end = after
            .find(|c: char| !c.is_alphabetic())
            .unwrap_or(after.len());
        let (word, tail) = after.split_at(end);
        if word.is_empty() || !tail.trim().is_empty() {
            return Err(unreadable(field, text));
        }
        let code = of_word(word, row_currency, held)?.ok_or_else(|| unreadable(field, text))?;
        say(code, &mut currency)?;
    }
    let in_force = currency.as_deref().unwrap_or(row_currency);
    let places = minor_units(&in_force.to_ascii_uppercase());
    let overflow = || format!("error: {field}: \"{}\" is too large.", text.trim());
    let minor = shifted(&whole, &fraction, u32::from(places) + scale)
        .ok_or_else(|| {
            format!(
                "error: {field}: {in_force} has {places} decimal places; \"{}\" has more.",
                text.trim()
            )
        })
        .and_then(|minor| {
            (minor <= i64::MAX / 2)
                .then_some(minor)
                .ok_or_else(overflow)
        })?;
    Ok(Stated {
        minor: if negative { -minor } else { minor },
        currency,
        signed,
    })
}

/// A currency as a person says it (`INR`, `rupees`, `euro`, a symbol), settled to one ISO code.
///
/// # Errors
///
/// A sentence when the text is none, or names several currencies the vault holds.
pub fn currency(text: &str, row_currency: &str, held: &[String]) -> Result<String, String> {
    let said = text.trim().trim_matches('"').trim();
    let refuse = || {
        format!(
            "error: a currency is a three-letter code like USD or a name like euros; \"{said}\" is not."
        )
    };
    if let Some(symbol) = said.chars().next().filter(|c| SYMBOL_CHARS.contains(c))
        && said.chars().count() == 1
    {
        return of_symbol(symbol, row_currency, held);
    }
    of_word(said, row_currency, held)?.ok_or_else(refuse)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held(codes: &[&str]) -> Vec<String> {
        codes.iter().map(|code| (*code).to_owned()).collect()
    }

    fn minor(text: &str, row: &str, vault: &[&str]) -> (i64, Option<String>) {
        let stated = read("amount", text, row, &held(vault)).expect(text);
        (stated.minor, stated.currency)
    }

    #[test]
    fn indian_scale_words_are_exact() {
        assert_eq!(
            minor("\u{20b9}2.5 lakh", "INR", &["INR"]),
            (25_000_000, Some("INR".into()))
        );
        assert_eq!(minor("1.2 crore", "INR", &["INR"]), (1_200_000_000, None));
        assert_eq!(minor("2,50,000", "INR", &["INR"]), (25_000_000, None));
        assert_eq!(
            minor("3 lakhs INR", "INR", &["INR"]),
            (30_000_000, Some("INR".into()))
        );
        assert_eq!(minor("2.5cr", "INR", &["INR"]).0, 2_500_000_000);
    }

    #[test]
    fn symbols_codes_and_names_settle_to_one_currency() {
        assert_eq!(
            minor("$1,200", "USD", &["USD"]),
            (120_000, Some("USD".into()))
        );
        assert_eq!(
            minor("\u{20ac}40", "USD", &["USD"]),
            (4_000, Some("EUR".into()))
        );
        assert_eq!(
            minor("1,500 rupees", "INR", &["INR", "USD"]),
            (150_000, Some("INR".into()))
        );
        assert_eq!(
            minor("40 euros", "USD", &["USD", "EUR"]),
            (4_000, Some("EUR".into()))
        );
        assert_eq!(minor("Rs. 500", "INR", &[]), (50_000, Some("INR".into())));
        assert_eq!(
            minor("USD 12k", "USD", &[]),
            (1_200_000, Some("USD".into()))
        );
        // a `$` in a vault of two dollars is the row's own
        assert_eq!(
            minor("$5", "CAD", &["USD", "CAD"]),
            (500, Some("CAD".into()))
        );
    }

    #[test]
    fn the_minor_unit_is_the_currencys_own() {
        assert_eq!(minor("1500 JPY", "USD", &[]), (1_500, Some("JPY".into())));
        assert_eq!(minor("1.5 KWD", "KWD", &[]), (1_500, Some("KWD".into())));
        assert_eq!(minor("45.5", "USD", &[]), (4_550, None));
        let refused = read("amount", "45.555", "USD", &[]).expect_err("three places");
        assert!(refused.contains("2 decimal places"), "{refused}");
        let refused = read("amount", "1.5 JPY", "USD", &[]).expect_err("yen has none");
        assert!(refused.contains("0 decimal places"), "{refused}");
    }

    #[test]
    fn a_sign_is_stated_or_it_is_not() {
        let out = read("amount", "-$45.50", "USD", &[]).expect("signed");
        assert_eq!((out.minor, out.signed), (-4_550, true));
        let out = read("amount", "(12)", "USD", &[]).expect("parentheses");
        assert_eq!((out.minor, out.signed), (-1_200, true));
        let out = read("amount", "45", "USD", &[]).expect("plain");
        assert_eq!((out.minor, out.signed), (4_500, false));
    }

    #[test]
    fn a_currency_is_a_code_a_name_or_a_symbol() {
        let vault = held(&["USD", "INR"]);
        assert_eq!(currency("eur", "USD", &vault).as_deref(), Ok("EUR"));
        assert_eq!(currency("rupees", "USD", &vault).as_deref(), Ok("INR"));
        assert_eq!(currency("\u{20b9}", "USD", &vault).as_deref(), Ok("INR"));
        assert!(currency("parsnips", "USD", &vault).is_err());
        assert!(currency("", "USD", &vault).is_err());
    }

    #[test]
    fn what_is_no_amount_is_refused_and_two_currencies_are_one_too_many() {
        for text in ["fifty", "1e3", "12 parsnips", "", "$", "1,2,3", "5 USD EUR"] {
            assert!(read("amount", text, "USD", &[]).is_err(), "{text}");
        }
        let both = read("amount", "\u{20ac}5 USD", "USD", &[]).expect_err("two");
        assert!(both.contains("EUR and USD"), "{both}");
        let several = read("amount", "5 pesos", "USD", &held(&["MXN", "COP"])).expect_err("which");
        assert!(several.contains("MXN, COP"), "{several}");
    }
}
