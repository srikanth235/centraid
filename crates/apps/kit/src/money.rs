//! MONEY KEEPS ITS CURRENCY (#996 ruling R22, drift ONT-23; ported for #1020).
//!
//! v0's doctrine, verbatim from `packages/core/src/money/index.ts:1-14`:
//! Tally's `pairwise` accumulated minor units into a map keyed by *party alone*
//! and the dashboard labelled the sum with the vault's base currency, so a EUR
//! 100 debt and a USD 100 debt read as one 200 — a number true in no currency,
//! rendered as if it were. **The fix is a type, not a check.**
//!
//! Three things the Rust port fixes rather than reproduces, each a finding
//! against v0 recorded in the receipt:
//!
//! - **`Money` is an f64 in disguise in v0** (#1020, apps seam 1):
//!   `money()` calls `Math.round` on a JS number and `valuate` computes
//!   `round(minor * rate_scaled / 10**rate_scale)` in floating point. Here the
//!   amount is an `i64` of minor units and the conversion is integer
//!   arithmetic — but the *rounding mode* is pinned to JS's, because the parity
//!   fixtures compare odd pennies. See [`js_round_div`].
//! - **A currency is a code, not a string.** [`Currency`] uppercases on
//!   construction the way `money()` does, and carries its own minor-unit
//!   exponent.
//! - **Formatting takes an explicit locale.** v0's formatter divides minor
//!   units by 100 unconditionally and passes `undefined` as the locale, so JPY
//!   and KWD are already wrong and the same vault renders differently on two
//!   devices (#1020, apps seam 2). [`format_money`] takes the locale as an
//!   argument and reads the exponent off the code. Parity fixtures for
//!   formatting are therefore **not** generated from v0.

use std::collections::BTreeMap;

use crate::error::{KitError, KitResult};

/// An ISO 4217 code, upper case.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Currency(String);

impl Currency {
    /// Uppercases, as `money(minor, currency)` does (`money/index.ts:42`).
    pub fn new(code: &str) -> Self {
        Self(code.to_ascii_uppercase())
    }

    pub fn code(&self) -> &str {
        &self.0
    }

    /// The number of digits after the decimal point for this code.
    pub fn minor_units(&self) -> u8 {
        minor_units(&self.0)
    }
}

impl std::fmt::Display for Currency {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&self.0)
    }
}

/// The ISO 4217 minor-unit exponent, for the codes the product can reach.
///
/// v0 has no such table, which is the bug: `packages/design/src/format.ts:38`
/// divides by 100 for every currency. Two decimals is the default because it is
/// the answer for the overwhelming majority of codes; the exceptions listed
/// here are the ones a member of this product plausibly holds money in. An
/// unlisted code getting 2 is a *stated* default, not a guess that hides.
pub fn minor_units(code: &str) -> u8 {
    match code {
        // Zero-decimal currencies.
        "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "PYG" | "RWF" | "UGX"
        | "UYI" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 0,
        // Three-decimal currencies.
        "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
        // Four-decimal currencies.
        "CLF" | "UYW" => 4,
        _ => 2,
    }
}

/// An amount in the minor units of ONE currency.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Money {
    pub amount_minor: i64,
    pub currency: Currency,
}

/// An amount of one currency. The constructor named after v0's `money()`.
pub fn money(amount_minor: i64, currency: &str) -> Money {
    Money {
        amount_minor,
        currency: Currency::new(currency),
    }
}

pub fn zero_money(currency: &str) -> Money {
    money(0, currency)
}

impl Money {
    pub fn is_zero(&self) -> bool {
        self.amount_minor == 0
    }

    pub fn negated(&self) -> Self {
        Self {
            amount_minor: -self.amount_minor,
            currency: self.currency.clone(),
        }
    }
}

/// Adds two amounts of the SAME currency. Different currencies are an error —
/// this is the addition ONT-23 was doing silently (`money/index.ts:58-65`).
pub fn add_money(left: &Money, right: &Money) -> KitResult<Money> {
    if left.currency != right.currency {
        return Err(KitError::CurrencyMismatch {
            left: left.currency.0.clone(),
            right: right.currency.0.clone(),
        });
    }
    Ok(Money {
        amount_minor: left.amount_minor + right.amount_minor,
        currency: left.currency.clone(),
    })
}

/// A position that may span currencies: at most one entry per currency, sorted
/// by currency, zero entries dropped. Never summed into one number.
///
/// **The sort is code-point order, and v0's is `localeCompare`**
/// (`money/index.ts:70`; #1020, apps seam 4). For the three-letter ASCII
/// upper-case codes ISO 4217 defines, ICU collation and byte order agree on
/// every pair, so the two orders are the same order for every value this type
/// can hold. Documented rather than reconciled: the divergence is unreachable,
/// and a `localeCompare` port would need ICU in the core for nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MoneyBag(Vec<Money>);

impl MoneyBag {
    pub const fn empty() -> Self {
        Self(Vec::new())
    }

    /// A bag from any number of amounts, folded per currency.
    pub fn of(amounts: impl IntoIterator<Item = Money>) -> Self {
        let mut totals: BTreeMap<Currency, i64> = BTreeMap::new();
        for amount in amounts {
            *totals.entry(amount.currency).or_insert(0) += amount.amount_minor;
        }
        Self(
            totals
                .into_iter()
                .filter(|(_, amount)| *amount != 0)
                .map(|(currency, amount_minor)| Money {
                    amount_minor,
                    currency,
                })
                .collect(),
        )
    }

    pub fn entries(&self) -> &[Money] {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn plus(&self, amount: Money) -> Self {
        Self::of(self.0.iter().cloned().chain(std::iter::once(amount)))
    }

    pub fn plus_bag(&self, other: &Self) -> Self {
        Self::of(self.0.iter().chain(other.0.iter()).cloned())
    }

    pub fn negated(&self) -> Self {
        Self(self.0.iter().map(Money::negated).collect())
    }

    /// The currencies a position is held in, sorted. A bag of more than one is
    /// what no single figure can honestly summarise without a rate.
    pub fn currencies(&self) -> Vec<Currency> {
        self.0
            .iter()
            .map(|amount| amount.currency.clone())
            .collect()
    }

    /// Only the entries on one side of zero, sign preserved.
    pub fn filtered(&self, keep: impl Fn(&Money) -> bool) -> Self {
        Self(
            self.0
                .iter()
                .filter(|amount| keep(amount))
                .cloned()
                .collect(),
        )
    }

    /// The amount held in `currency`, zero when the bag holds none of it.
    pub fn in_currency(&self, currency: &str) -> Money {
        let wanted = Currency::new(currency);
        self.0
            .iter()
            .find(|amount| amount.currency == wanted)
            .cloned()
            .unwrap_or(Money {
                amount_minor: 0,
                currency: wanted,
            })
    }
}

/// A rate actually used to produce a valuation — never implied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValuationRate {
    pub from: Currency,
    pub to: Currency,
    /// `rate_scaled / 10^rate_scale`, the vault's fixed-point pair.
    pub rate_scaled: i64,
    pub rate_scale: u32,
    pub source: String,
    pub effective_at: String,
}

/// A single figure over a position, and the reason it can be one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Valuation {
    Valued {
        total: Money,
        rates: Vec<ValuationRate>,
        components: MoneyBag,
    },
    Unavailable {
        /// v0's only reason, and there is no rate plane in the product yet.
        reason: &'static str,
        currencies: Vec<Currency>,
        components: MoneyBag,
    },
}

impl Valuation {
    pub fn components(&self) -> &MoneyBag {
        match self {
            Self::Valued { components, .. } | Self::Unavailable { components, .. } => components,
        }
    }

    fn rates(&self) -> &[ValuationRate] {
        match self {
            Self::Valued { rates, .. } => rates,
            Self::Unavailable { .. } => &[],
        }
    }
}

/// `Math.round`, in integers.
///
/// JS rounds half **away from zero toward +∞**: `Math.round(-0.5)` is `-0` (so
/// `0`), `Math.round(2.5)` is `3`, `Math.round(-2.5)` is `-2`. That is
/// `floor(x + 0.5)`, and `floor((2n + d) / 2d)` is the same thing over integers
/// for a positive denominator. Written as its own function with a table test
/// copied from JS outputs, because a rounding mode is a format decision and
/// "improving" it moves every odd penny in the parity fixtures.
pub fn js_round_div(numerator: i128, denominator: i128) -> i128 {
    assert!(denominator > 0, "a scale is a positive power of ten");
    // Rust's `/` truncates toward zero; `div_euclid` with a positive divisor is
    // floor division, which is what `Math.round`'s `floor(x + 0.5)` needs on
    // the negative side.
    (2 * numerator + denominator).div_euclid(2 * denominator)
}

/// Value a position in `base`.
///
/// With nothing to convert — an empty position, or one held entirely in `base`
/// — the answer is `Valued` with **no rates**, because no rate was used. With
/// more than one currency and no rate source, the answer is `Unavailable`:
/// there is no rate plane in the product, and inventing one is exactly the
/// arithmetic ONT-23 filed (`money/index.ts:150-158`).
pub fn valuate(bag: &MoneyBag, base: &str, rates: &[ValuationRate]) -> KitResult<Valuation> {
    let wanted = Currency::new(base);
    let foreign: Vec<&Money> = bag
        .entries()
        .iter()
        .filter(|amount| amount.currency != wanted)
        .collect();
    if foreign.is_empty() {
        return Ok(Valuation::Valued {
            total: bag.in_currency(wanted.code()),
            rates: Vec::new(),
            components: bag.clone(),
        });
    }
    let mut converted = vec![bag.in_currency(wanted.code())];
    let mut used = Vec::new();
    for amount in foreign {
        let Some(rate) = rates
            .iter()
            .find(|rate| rate.from == amount.currency && rate.to == wanted)
        else {
            return Ok(Valuation::Unavailable {
                reason: "no-rate-source",
                currencies: bag.currencies(),
                components: bag.clone(),
            });
        };
        used.push(rate.clone());
        let scale = 10_i128
            .checked_pow(rate.rate_scale)
            .expect("a vault rate scale is small; RATE_SCALE is 6 in v0");
        let minor = js_round_div(
            i128::from(amount.amount_minor) * i128::from(rate.rate_scaled),
            scale,
        );
        converted.push(Money {
            amount_minor: i64::try_from(minor).map_err(|_| {
                KitError::Door("a converted amount overflowed i64 minor units".to_owned())
            })?,
            currency: wanted.clone(),
        });
    }
    let mut total = Money {
        amount_minor: 0,
        currency: wanted.clone(),
    };
    for amount in &converted {
        total = add_money(&total, amount)?;
    }
    Ok(Valuation::Valued {
        total,
        rates: used,
        components: bag.clone(),
    })
}

/// `owed` less `owe`, as one valuation.
///
/// Two valuations do not subtract as numbers — each is a position first and a
/// figure second — so the difference is taken over the COMPONENTS and valued
/// once, which is what keeps "unavailable minus unavailable" from becoming a
/// number (`money/index.ts:215-219`).
pub fn net_valuation(owed: &Valuation, owe: &Valuation, base: &str) -> KitResult<Valuation> {
    let components = owed.components().plus_bag(&owe.components().negated());
    let mut rates = owed.rates().to_vec();
    rates.extend(owe.rates().iter().cloned());
    valuate(&components, base, &rates)
}

/// One amount, rendered for one **named** locale.
///
/// Deliberately small: a code, a sign, and the minor units placed by the code's
/// own exponent. It is not `Intl.NumberFormat` and does not pretend to be —
/// what it fixes is the two things v0's formatter gets wrong, the hard-coded
/// 100 and the host locale. `locale` selects the group and decimal separators;
/// an unknown locale falls back to the `en` shape, stated rather than guessed.
pub fn format_money(amount: &Money, locale: &str) -> String {
    let exponent = u32::from(amount.currency.minor_units());
    let divisor = 10_i128.pow(exponent);
    let minor = i128::from(amount.amount_minor);
    let negative = minor < 0;
    let magnitude = minor.abs();
    let whole = magnitude / divisor;
    let fraction = magnitude % divisor;
    let (group, decimal) = separators(locale);
    let mut digits = whole.to_string();
    digits = group_digits(&digits, group);
    let body = if exponent == 0 {
        digits
    } else {
        format!(
            "{digits}{decimal}{fraction:0width$}",
            width = exponent as usize
        )
    };
    let sign = if negative { "-" } else { "" };
    format!("{sign}{code} {body}", code = amount.currency.code())
}

/// The group and decimal separators of the locales the product ships copy in.
/// One table, so a surface cannot restate it.
fn separators(locale: &str) -> (char, char) {
    let language = locale.split(['-', '_']).next().unwrap_or("en");
    match language {
        "de" | "es" | "it" | "nl" | "pt" | "id" | "tr" | "da" => ('.', ','),
        "fr" | "ru" | "pl" | "cs" | "sv" | "nb" | "fi" | "uk" => ('\u{202f}', ','),
        _ => (',', '.'),
    }
}

fn group_digits(digits: &str, group: char) -> String {
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    let bytes = digits.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 && (bytes.len() - index).is_multiple_of(3) {
            out.push(group);
        }
        out.push(char::from(*byte));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table is copied from JS: `Math.round(x)` for each numerator over
    /// each denominator, taken from the same expression v0 evaluates.
    #[test]
    fn js_rounding_is_half_away_from_zero_toward_positive_infinity() {
        // (numerator, denominator, what `Math.round(n / d)` answers)
        let cases: [(i128, i128, i128); 12] = [
            (5, 10, 1),    // Math.round(0.5) === 1
            (-5, 10, 0),   // Math.round(-0.5) === -0
            (25, 10, 3),   // Math.round(2.5) === 3
            (-25, 10, -2), // Math.round(-2.5) === -2
            (15, 10, 2),
            (-15, 10, -1),
            (14, 10, 1),
            (-14, 10, -1),
            (0, 10, 0),
            (100, 10, 10),
            (-100, 10, -10),
            (1, 3, 0),
        ];
        for (numerator, denominator, expected) in cases {
            assert_eq!(
                js_round_div(numerator, denominator),
                expected,
                "round({numerator}/{denominator})"
            );
        }
    }

    #[test]
    fn adding_two_currencies_is_the_error_ont23_filed() {
        let outcome = add_money(&money(100, "EUR"), &money(100, "USD"));
        assert!(matches!(outcome, Err(KitError::CurrencyMismatch { .. })));
    }

    #[test]
    fn a_bag_drops_zeros_folds_per_currency_and_sorts_by_code() {
        let bag = MoneyBag::of([
            money(100, "usd"),
            money(50, "EUR"),
            money(-50, "EUR"),
            money(20, "GBP"),
            money(1, "USD"),
        ]);
        assert_eq!(
            bag.entries(),
            &[money(20, "GBP"), money(101, "USD")],
            "EUR netted to zero and was dropped; the rest sort GBP before USD"
        );
    }

    #[test]
    fn usd_100_plus_eur_100_is_unavailable_and_names_its_components() {
        let bag = MoneyBag::of([money(10_000, "USD"), money(10_000, "EUR")]);
        let valuation = valuate(&bag, "USD", &[]).unwrap();
        match valuation {
            Valuation::Unavailable {
                reason,
                components,
                currencies,
            } => {
                assert_eq!(reason, "no-rate-source");
                assert_eq!(components, bag);
                assert_eq!(currencies, vec![Currency::new("EUR"), Currency::new("USD")]);
            }
            other => panic!("a position spanning currencies is not valued: {other:?}"),
        }
    }

    #[test]
    fn a_position_wholly_in_base_is_valued_with_no_rate() {
        let bag = MoneyBag::of([money(500, "USD")]);
        let valuation = valuate(&bag, "usd", &[]).unwrap();
        assert!(matches!(
            valuation,
            Valuation::Valued { ref rates, .. } if rates.is_empty()
        ));
    }

    #[test]
    fn a_conversion_rounds_the_way_javascript_rounds() {
        let rate = ValuationRate {
            from: Currency::new("EUR"),
            to: Currency::new("USD"),
            // 1.105 at scale 3: 105 minor EUR is 116.025 minor USD.
            rate_scaled: 1_105,
            rate_scale: 3,
            source: "test".to_owned(),
            effective_at: "2026-01-01T00:00:00.000Z".to_owned(),
        };
        let bag = MoneyBag::of([money(105, "EUR")]);
        let valuation = valuate(&bag, "USD", &[rate]).unwrap();
        match valuation {
            Valuation::Valued { total, .. } => assert_eq!(total.amount_minor, 116),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn unavailable_minus_unavailable_never_becomes_a_number() {
        let owed = valuate(
            &MoneyBag::of([money(100, "USD"), money(100, "EUR")]),
            "USD",
            &[],
        )
        .unwrap();
        let owe = valuate(&MoneyBag::of([money(40, "EUR")]), "USD", &[]).unwrap();
        let net = net_valuation(&owed, &owe, "USD").unwrap();
        assert!(matches!(net, Valuation::Unavailable { .. }));
        assert_eq!(
            net.components().entries(),
            &[money(60, "EUR"), money(100, "USD")]
        );
    }

    #[test]
    fn the_minor_unit_table_is_what_v0s_formatter_lacks() {
        assert_eq!(
            format_money(&money(1_234_567, "USD"), "en-US"),
            "USD 12,345.67"
        );
        // JPY has no minor unit; v0 would print "¥12,345.67" for 1,234,567.
        assert_eq!(
            format_money(&money(1_234_567, "JPY"), "en-US"),
            "JPY 1,234,567"
        );
        // KWD has three; v0 would print 12,345.67.
        assert_eq!(
            format_money(&money(1_234_567, "KWD"), "en-US"),
            "KWD 1,234.567"
        );
        // The locale is explicit, never the host's.
        assert_eq!(
            format_money(&money(-1_234_567, "EUR"), "de-DE"),
            "-EUR 12.345,67"
        );
    }
}
