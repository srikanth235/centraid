//! THE FOLDS EVERY MONEY SCREEN SHARES: months, days, finished amounts, the
//! three states of a read, the chrome. Pure, and never arithmetic the core did
//! not do: an amount is the core's, formatted by [`kit::money`], and the only
//! sums here are counts and basis points for a bar's length, which are drawing,
//! not figures.

use centraid_api_proto::core_v1 as wire;
use wire::status_chip::Tone;

use crate::kit::civil;
use crate::kit::money::{self, Amount};
use crate::kit::read::Reading;
use crate::strings::{Locale, fill, money as words};

/// The locale amounts are drawn in. The vault does not name one yet, so every
/// amount is English-formatted; the one place to change it is here.
pub const AMOUNT_LOCALE: &str = "en-US";

const MONTHS: i64 = 12;

// --- Amounts -----------------------------------------------------------------

/// The core's amount as the formatter's.
#[must_use]
pub fn amount(amount: &wire::MoneyAmount) -> Amount {
    Amount::new(amount.minor, &amount.currency, amount.exponent)
}

/// A core amount, finished; empty when there is none.
#[must_use]
pub fn text(amount: Option<&wire::MoneyAmount>) -> String {
    amount.map_or_else(String::new, |a| {
        money::format(&self::amount(a), AMOUNT_LOCALE)
    })
}

/// A core amount, finished, with the sign of a gain.
#[must_use]
pub fn signed(amount: Option<&wire::MoneyAmount>) -> String {
    amount.map_or_else(String::new, |a| {
        money::format_signed(&self::amount(a), AMOUNT_LOCALE)
    })
}

/// NET is money out or over plan; NEUTRAL is ink.
#[must_use]
pub fn sign_tone(amount: Option<&wire::MoneyAmount>) -> Tone {
    if amount.is_some_and(|a| a.minor < 0) {
        Tone::Net
    } else {
        Tone::Neutral
    }
}

#[must_use]
pub fn figure(label: &str, amount: Option<&wire::MoneyAmount>, tone: Tone) -> wire::MoneyFigure {
    wire::MoneyFigure {
        label: label.to_owned(),
        amount: text(amount),
        tone: tone as i32,
    }
}

#[must_use]
pub fn choice(key: &str, label: &str, selected: bool, detail: &str) -> wire::MoneyChoice {
    wire::MoneyChoice {
        key: key.to_owned(),
        label: label.to_owned(),
        selected,
        detail: detail.to_owned(),
    }
}

#[must_use]
pub fn chip(label: String, tone: Tone) -> wire::StatusChip {
    wire::StatusChip {
        label,
        tone: tone as i32,
    }
}

/// "1 row" / "3 rows": a count with its noun.
#[must_use]
pub fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

// --- Months ------------------------------------------------------------------

/// `2026-10` of a `YYYY-MM-DD` day.
#[must_use]
pub fn month_of(day: &str) -> String {
    day.chars().take(7).collect()
}

fn month_number(month: &str) -> Option<u32> {
    month.get(5..7)?.parse().ok()
}

/// `October 2026`; the input unchanged when it is not a month.
#[must_use]
pub fn month_label(locale: Locale, month: &str) -> String {
    let Some(number) = month_number(month) else {
        return month.to_owned();
    };
    let name = civil::month_name(locale, number);
    if name.is_empty() {
        month.to_owned()
    } else {
        format!("{name} {}", &month[..4])
    }
}

/// `Oct`.
#[must_use]
pub fn month_short(locale: Locale, month: &str) -> String {
    month_number(month)
        .map(|number| civil::month_name(locale, number).chars().take(3).collect())
        .unwrap_or_else(|| month.to_owned())
}

/// `month` moved by `months` (negative goes back); itself when it is not a month.
#[must_use]
pub fn shift_month(month: &str, months: i64) -> String {
    let (Some(year), Some(number)) = (
        month.get(..4).and_then(|y| y.parse::<i64>().ok()),
        month_number(month),
    ) else {
        return month.to_owned();
    };
    let index = year * MONTHS + i64::from(number) - 1 + months;
    format!(
        "{:04}-{:02}",
        index.div_euclid(MONTHS),
        index.rem_euclid(MONTHS) + 1
    )
}

/// The month sheet's choices: `through` and the eleven before it, newest first.
#[must_use]
pub fn month_options(locale: Locale, through: &str, selected: &str) -> Vec<wire::MoneyChoice> {
    (0..MONTHS)
        .map(|back| {
            let month = shift_month(through, -back);
            choice(&month, &month_label(locale, &month), month == selected, "")
        })
        .collect()
}

// --- Days --------------------------------------------------------------------

/// `Today` / `Yesterday` / `Mon 12 October`.
#[must_use]
pub fn day_heading(locale: Locale, day: &str, today: &str) -> String {
    if today.is_empty() {
        civil::day_month(locale, day)
    } else {
        civil::relative_day(locale, day, today)
    }
}

/// `Oct 14`: a short date for a meta line.
#[must_use]
pub fn day_short(locale: Locale, day: &str) -> String {
    let (Some(month), Some(dom)) = (
        month_number(day),
        day.get(8..).and_then(|d| d.parse::<u32>().ok()),
    ) else {
        return day.to_owned();
    };
    let name: String = civil::month_name(locale, month).chars().take(3).collect();
    format!("{name} {dom}")
}

/// `today`, `yesterday` or `Oct 14`: a day inside a sentence.
#[must_use]
pub fn day_words(locale: Locale, day: &str, today: &str) -> String {
    if day == today {
        words::word_today(locale)
    } else if civil::plus_days(today, -1).as_deref() == Some(day) {
        words::word_yesterday(locale)
    } else {
        day_short(locale, day)
    }
}

/// `Sep 15 to Oct 14`; empty when either end is missing.
#[must_use]
pub fn span(locale: Locale, first: Option<&str>, last: Option<&str>) -> String {
    match (first, last) {
        (Some(first), Some(last)) if !first.is_empty() && !last.is_empty() => format!(
            "{} {} {}",
            day_short(locale, first),
            words::to_word(locale),
            day_short(locale, last)
        ),
        _ => String::new(),
    }
}

// --- Words for the core's enums ----------------------------------------------

#[must_use]
pub fn cadence_words(locale: Locale, cadence: i32) -> String {
    use wire::MoneyCadence as C;
    match C::try_from(cadence).unwrap_or(C::Unspecified) {
        C::Weekly => words::cadence_weekly(locale),
        C::Biweekly => words::cadence_biweekly(locale),
        C::Monthly => words::cadence_monthly(locale),
        C::Quarterly => words::cadence_quarterly(locale),
        C::Yearly => words::cadence_yearly(locale),
        C::Unspecified => String::new(),
    }
}

#[must_use]
pub fn match_kind_word(locale: Locale, kind: i32) -> String {
    use wire::MoneyMatchKind as K;
    match K::try_from(kind).unwrap_or(K::Unspecified) {
        K::Is => words::kind_is(locale),
        K::Matches => words::kind_matches(locale),
        _ => words::kind_contains(locale),
    }
}

/// The word the vault's `rule.add` takes for a match kind.
#[must_use]
pub fn match_kind_key(kind: i32) -> &'static str {
    use wire::MoneyMatchKind as K;
    match K::try_from(kind).unwrap_or(K::Unspecified) {
        K::Is => "is",
        K::Matches => "matches",
        _ => "contains",
    }
}

/// The copy for a definition key the core names (`money.def.*`).
#[must_use]
pub fn definition(locale: Locale, key: &str) -> Option<wire::MoneyFact> {
    let (label, detail) = match key {
        "money.def.spending" => (
            words::def_spending_label(locale),
            words::def_spending_detail(locale),
        ),
        "money.def.refund_credit" => (
            words::def_refund_label(locale),
            words::def_refund_detail(locale),
        ),
        "money.def.in_out_net" => (
            words::def_in_out_label(locale),
            words::def_in_out_detail(locale),
        ),
        "money.def.savings_rate" => (
            words::def_savings_label(locale),
            words::def_savings_detail(locale),
        ),
        "money.def.balance" => (
            words::def_balance_label(locale),
            words::def_balance_detail(locale),
        ),
        "money.def.checkpoint" => (
            words::def_checkpoint_label(locale),
            words::def_checkpoint_detail(locale),
        ),
        "money.def.planned" => (
            words::def_planned_label(locale),
            words::def_planned_detail(locale),
        ),
        "money.def.forecast" => (
            words::def_forecast_label(locale),
            words::def_forecast_detail(locale),
        ),
        "money.def.recurring" => (
            words::def_recurring_label(locale),
            words::def_recurring_detail(locale),
        ),
        "money.def.transfer" => (
            words::def_transfer_label(locale),
            words::def_transfer_detail(locale),
        ),
        _ => return None,
    };
    Some(wire::MoneyFact {
        label,
        detail,
        ..wire::MoneyFact::default()
    })
}

/// The definitions the core names, in its order, the unknown ones left out.
#[must_use]
pub fn definitions(locale: Locale, keys: &[String]) -> Vec<wire::MoneyFact> {
    keys.iter()
        .filter_map(|key| definition(locale, key))
        .collect()
}

/// A sentence with `{n}` filled.
#[must_use]
pub fn with_n(template: String, n: impl ToString) -> String {
    fill(&template, &[("n", &n.to_string())])
}

// --- The three states of a read ------------------------------------------------

/// What a screen holds of its read: nothing yet, a failure, a gate, or data.
pub(crate) enum Phase<T> {
    Loading,
    Failed,
    Denied,
    Ready(T),
}

impl<T> Phase<T> {
    pub(crate) fn of(reading: Reading<T>) -> Self {
        match reading {
            Reading::Data(data) => Self::Ready(data),
            Reading::Denied(_) => Self::Denied,
            Reading::Failed => Self::Failed,
        }
    }

    pub(crate) fn map<U>(self, f: impl FnOnce(T) -> U) -> Phase<U> {
        match self {
            Self::Loading => Phase::Loading,
            Self::Failed => Phase::Failed,
            Self::Denied => Phase::Denied,
            Self::Ready(data) => Phase::Ready(f(data)),
        }
    }

    pub(crate) fn data(&self) -> Option<&T> {
        match self {
            Self::Ready(data) => Some(data),
            _ => None,
        }
    }
}

/// The gate drawn when the vault will not let Money read.
#[must_use]
pub fn denied(locale: Locale) -> wire::Denied {
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: words::denied_scope(locale),
    }
}

/// A page's chrome: its title, and the back control saying where it came from.
#[must_use]
pub fn chrome(locale: Locale, title: String, parent: &str) -> wire::MoneyPageChrome {
    wire::MoneyPageChrome {
        title,
        back_label: if parent.is_empty() {
            words::app_title(locale)
        } else {
            parent.to_owned()
        },
        retry: words::retry(locale),
    }
}

/// A status line for a refused write: the core's sentence, else ours.
#[must_use]
pub fn refusal(locale: Locale, sentence: &str) -> wire::StatusLine {
    wire::StatusLine {
        sentence: if sentence.trim().is_empty() {
            words::write_refused(locale)
        } else {
            sentence.to_owned()
        },
        refused: true,
        ..wire::StatusLine::default()
    }
}

/// A status line for a committed write.
#[must_use]
pub fn done(sentence: String) -> wire::StatusLine {
    wire::StatusLine {
        sentence,
        ..wire::StatusLine::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months_step_across_a_year() {
        assert_eq!(shift_month("2026-01", -1), "2025-12");
        assert_eq!(shift_month("2026-12", 1), "2027-01");
        assert_eq!(shift_month("2026-10", -11), "2025-11");
        assert_eq!(shift_month("nope", 1), "nope");
    }

    #[test]
    fn a_month_has_words() {
        assert_eq!(month_label(Locale::En, "2026-10"), "October 2026");
        assert_eq!(month_short(Locale::En, "2026-10"), "Oct");
        assert_eq!(day_short(Locale::En, "2026-10-04"), "Oct 4");
        assert_eq!(day_words(Locale::En, "2026-10-04", "2026-10-04"), "today");
        assert_eq!(
            day_words(Locale::En, "2026-10-03", "2026-10-04"),
            "yesterday"
        );
        assert_eq!(
            span(Locale::En, Some("2026-09-15"), Some("2026-10-14")),
            "Sep 15 to Oct 14"
        );
        assert_eq!(span(Locale::En, None, Some("2026-10-14")), "");
    }

    #[test]
    fn the_month_sheet_is_twelve_months_newest_first() {
        let options = month_options(Locale::En, "2026-10", "2026-09");
        assert_eq!(options.len(), 12);
        assert_eq!(options[0].key, "2026-10");
        assert_eq!(options[11].key, "2025-11");
        assert!(options[1].selected && !options[0].selected);
    }

    #[test]
    fn an_amount_is_the_formatters_and_a_loss_is_net() {
        let out = wire::MoneyAmount {
            minor: -4250,
            currency: "USD".to_owned(),
            exponent: 2,
        };
        assert_eq!(text(Some(&out)), "-$42.50");
        assert_eq!(sign_tone(Some(&out)), Tone::Net);
        assert_eq!(signed(Some(&out)), "-$42.50");
        assert_eq!(text(None), "");
    }
}
