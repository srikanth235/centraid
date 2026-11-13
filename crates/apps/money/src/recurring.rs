//! RECURRING CHARGES, detected and never stored (#1099, wave 7; R-1099-14,
//! R-1099-36; month positions R-1119-1).
//!
//! A subscription or a bill is a merchant whose debits arrive on a fixed
//! cadence for about the same amount. Detection is a fold over the posted,
//! non-void debits of a bounded lookback ([`RECURRING_MONTHS`] month windows):
//! per account and merchant key ([`crate::rules::merchant_key`]), the amounts
//! are clustered (within [`AMOUNT_TOLERANCE_BP`] of a cluster's median, so two
//! plans from one merchant are two series), and each cluster is tried against
//! the cadences below.
//!
//! **A detected series is a value.** It carries an RRULE, checked by
//! `centraid_vault::time::rrule::assert_supported`, and is projected through
//! `centraid_vault::time::recurrence::expand`: there is no second expander and
//! no series row (R-1099-36).
//!
//! ## The cadences, and what the one engine can say
//!
//! Weekly, every second week, monthly on a day of the month, every third
//! month, yearly, and two month positions the vault's RRULE subset learned for
//! #1119 (R-1119-1, which supersedes R-1099-47):
//!
//! - **the nth weekday of the month**: the 1st to 4th, or the last, same
//!   weekday (`FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU`, `-1FR`);
//! - **the month's end**: the last day, or the last business day within the
//!   tolerance (`FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1`).
//!
//! A position must be matched in EVERY month between its first and last
//! match (a day of the month may miss one in four): its ±2 day window catches
//! most dates, so four unrelated charges would otherwise often fit one.
//!
//! Both are monthly to a member, so a series prints "every month" and reaches
//! the phone as [`Cadence::Monthly`]: the wire enum is unchanged. A plain
//! monthly day past the 28th is still not offered (`FREQ=MONTHLY` from the
//! 31st would clamp where the bank skips); a charge on the 30th or 31st is
//! offered as "the month's end" when it falls at the end of the months it is
//! in.
//!
//! ## What qualifies (R-1099-45)
//!
//! A cadence fits when expected dates anchored on one of the occurrences each
//! take the nearest unused occurrence within [`DAYS_TOLERANCE`] days; at least
//! [`MIN_OCCURRENCES`] match (two for yearly, because the lookback holds at
//! most two years' charges); at least three in four of the cluster's occurrences
//! are matched (a merchant visited at random is not a weekly bill); and no more
//! than one in four expected dates between the first and last match is missed.
//! **Rank** is the sum over matches of `1 / (days off + 1)`; the best cadence
//! of a cluster wins.
//!
//! ## Status precedence
//!
//! A projected occurrence that has a matching posted charge (within
//! [`DAYS_TOLERANCE`] days) is **paid**; otherwise it is **due** until
//! [`DAYS_TOLERANCE`] days after its date and **late** from then on.

use std::collections::{BTreeMap, BTreeSet};

use centraid_vault::time::recurrence::{ExpandInput, Semantics, expand};
use centraid_vault::time::rrule::assert_supported;

use crate::civil;
use crate::import::Direction;
use crate::queries::TxnRow;
use crate::rules::merchant_key;

/// Month windows the detector reads.
pub const RECURRING_MONTHS: usize = 13;
/// Occurrences a cadence needs to qualify (two for yearly).
pub const MIN_OCCURRENCES: usize = 3;
/// The fewest a yearly series may have: the lookback holds two years' worth.
pub const YEARLY_MIN_OCCURRENCES: usize = 2;
/// Days an occurrence may sit from its expected date.
pub const DAYS_TOLERANCE: i64 = 2;
/// How far an amount may sit from its cluster's median, in basis points.
pub const AMOUNT_TOLERANCE_BP: i64 = 750;
/// Projected occurrences expanded at once.
const EXPAND_MAX: usize = 400;

/// How often a series repeats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Cadence {
    Weekly,
    Biweekly,
    Monthly,
    Quarterly,
    Yearly,
}

impl Cadence {
    /// The words a row of the recurring list prints.
    #[must_use]
    pub const fn words(self) -> &'static str {
        match self {
            Self::Weekly => "every week",
            Self::Biweekly => "every 2 weeks",
            Self::Monthly => "every month",
            Self::Quarterly => "every 3 months",
            Self::Yearly => "every year",
        }
    }
}

/// What a cluster is tried against. A `Cadence` is how often (the wire's
/// word); a `Shape` is also WHERE in the period, so two shapes can be the same
/// cadence. **Declaration order is the tie-break** when two shapes rank
/// equally: the later one wins, so a plain monthly day beats a month position
/// that fits the same dates no better, and the Nth weekday beats the last one
/// (a charge that is both the 4th and the last Friday every month is the 4th).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Shape {
    Weekly,
    Biweekly,
    /// The last day of the month, or the last business day within tolerance.
    MonthEnd,
    /// The last such weekday of the month.
    LastWeekday,
    /// The 1st to 4th such weekday of the month.
    NthWeekday,
    /// A day of the month, 1 to 28.
    MonthDay,
    Quarterly,
    Yearly,
}

impl Shape {
    const ALL: [Self; 8] = [
        Self::Weekly,
        Self::Biweekly,
        Self::MonthEnd,
        Self::LastWeekday,
        Self::NthWeekday,
        Self::MonthDay,
        Self::Quarterly,
        Self::Yearly,
    ];

    const fn cadence(self) -> Cadence {
        match self {
            Self::Weekly => Cadence::Weekly,
            Self::Biweekly => Cadence::Biweekly,
            Self::MonthEnd | Self::LastWeekday | Self::NthWeekday | Self::MonthDay => {
                Cadence::Monthly
            }
            Self::Quarterly => Cadence::Quarterly,
            Self::Yearly => Cadence::Yearly,
        }
    }

    /// A month position (R-1119-1). Every charge proposes a pattern of its own
    /// (its weekday and ordinal, or the month's end) and a ±2 day window around
    /// a weekday-ordinal catches most dates, so four unrelated charges often
    /// fit one with a month to spare. A position therefore holds to a stricter
    /// standard than a day of the month: no expected date between its first
    /// and last match may go unmatched.
    const fn is_position(self) -> bool {
        matches!(self, Self::MonthEnd | Self::LastWeekday | Self::NthWeekday)
    }

    const fn minimum(self) -> usize {
        match self {
            Self::Yearly => YEARLY_MIN_OCCURRENCES,
            _ => MIN_OCCURRENCES,
        }
    }

    /// The expected date `k` periods from `anchor`, or none for a day the
    /// shape cannot be written for.
    fn expected(self, anchor: &str, k: i32) -> Option<String> {
        match self {
            Self::Weekly => civil::shift(anchor, i64::from(k) * 7),
            Self::Biweekly => civil::shift(anchor, i64::from(k) * 14),
            Self::MonthDay | Self::Quarterly | Self::Yearly => {
                let step = match self {
                    Self::MonthDay => 1,
                    Self::Quarterly => 3,
                    _ => 12,
                };
                let day = civil::day_of_month(anchor)?;
                if day > 28 {
                    return None;
                }
                let month = civil::add_months(civil::month_of(anchor), k * step)?;
                Some(format!("{month}-{day:02}"))
            }
            Self::MonthEnd => {
                let month = civil::add_months(civil::month_of(anchor), k)?;
                Some(format!("{month}-{:02}", civil::month_length(&month)))
            }
            Self::NthWeekday | Self::LastWeekday => {
                let (ordinal, weekday) = position_of(anchor)?;
                let month = civil::add_months(civil::month_of(anchor), k)?;
                if self == Self::NthWeekday {
                    // An anchor on the 5th is the LAST weekday, never the 5th:
                    // a month without a 5th has no occurrence.
                    if ordinal > 4 {
                        return None;
                    }
                    nth_weekday(&month, weekday, i64::from(ordinal))
                } else {
                    if !is_last_weekday(anchor)? {
                        return None;
                    }
                    nth_weekday(&month, weekday, -1)
                }
            }
        }
    }

    /// The RRULE for a series anchored on `anchor`.
    fn rrule(self, anchor: &str) -> Option<String> {
        let (_, weekday) = position_of(anchor)?;
        let token = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][weekday as usize];
        Some(match self {
            Self::Weekly => format!("FREQ=WEEKLY;INTERVAL=1;BYDAY={token}"),
            Self::Biweekly => format!("FREQ=WEEKLY;INTERVAL=2;BYDAY={token}"),
            Self::MonthEnd => "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1".to_owned(),
            Self::LastWeekday => format!("FREQ=MONTHLY;INTERVAL=1;BYDAY=-1{token}"),
            Self::NthWeekday => {
                let (ordinal, _) = position_of(anchor)?;
                format!("FREQ=MONTHLY;INTERVAL=1;BYDAY={ordinal}{token}")
            }
            Self::MonthDay => "FREQ=MONTHLY;INTERVAL=1".to_owned(),
            Self::Quarterly => "FREQ=MONTHLY;INTERVAL=3".to_owned(),
            Self::Yearly => "FREQ=YEARLY;INTERVAL=1".to_owned(),
        })
    }
}

/// `(ordinal, weekday)` of a day: the 1st to 5th such weekday of its month,
/// and Monday = 0.
fn position_of(day: &str) -> Option<(u32, u32)> {
    let (year, month, number) = civil::parse(day)?;
    Some((
        (number - 1) / 7 + 1,
        civil::weekday(civil::day_number(year, month, number)),
    ))
}

/// Whether `day` is the last such weekday of its month.
fn is_last_weekday(day: &str) -> Option<bool> {
    let (year, month, number) = civil::parse(day)?;
    Some(number + 7 > civil::days_in_month(year, month))
}

/// The `ordinal`th (1 to 4) or last (`-1`) `weekday` of `month`.
fn nth_weekday(month: &str, weekday: u32, ordinal: i64) -> Option<String> {
    let (year, number) = civil::parse_month(month)?;
    let length = i64::from(civil::days_in_month(year, number));
    let day = if ordinal > 0 {
        let first = i64::from(civil::weekday(civil::day_number(year, number, 1)));
        1 + (i64::from(weekday) - first).rem_euclid(7) + 7 * (ordinal - 1)
    } else {
        let last = i64::from(civil::weekday(civil::day_number(
            year,
            number,
            u32::try_from(length).ok()?,
        )));
        length - (last - i64::from(weekday)).rem_euclid(7)
    };
    (1..=length)
        .contains(&day)
        .then(|| format!("{month}-{day:02}"))
}

/// A detected series. A value: nothing about it is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Series {
    pub account_id: String,
    pub merchant_key: String,
    pub currency: String,
    pub cadence: Cadence,
    /// Checked by `assert_supported` and expanded by the vault's engine.
    pub rrule: String,
    /// The occurrence the schedule is anchored on (the RRULE's start).
    pub anchor: String,
    pub median_amount_minor: i64,
    /// The most common category among the matched rows.
    pub category_concept_id: Option<String>,
    /// The days of the matched rows, oldest first.
    pub occurrences: Vec<String>,
    /// The newest matched row's id and day.
    pub last_txn_id: String,
    pub last_seen: String,
    /// `1000 × Σ 1 / (days off + 1)` over the matches.
    pub rank_milli: i64,
}

/// Where a projected occurrence stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// Not seen yet, and not more than [`DAYS_TOLERANCE`] days past its date.
    Due,
    /// Not seen, and past that.
    Late,
    /// A matching charge posted.
    Paid,
}

/// One expected occurrence of a series.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Projected {
    pub expected_on: String,
    pub status: Status,
}

fn median(values: &mut [i64]) -> i64 {
    values.sort_unstable();
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        values[mid]
    } else {
        (values[mid - 1] + values[mid] + 1) / 2
    }
}

/// Amount clusters: sorted amounts, a new cluster when one is more than
/// [`AMOUNT_TOLERANCE_BP`] from the running cluster's median.
fn clusters<'a>(rows: &[&'a TxnRow]) -> Vec<Vec<&'a TxnRow>> {
    let mut sorted: Vec<&TxnRow> = rows.to_vec();
    sorted.sort_by(|a, b| (a.amount_minor, &a.txn_id).cmp(&(b.amount_minor, &b.txn_id)));
    let mut out: Vec<Vec<&TxnRow>> = Vec::new();
    for row in sorted {
        if let Some(last) = out.last_mut() {
            let mut amounts: Vec<i64> = last.iter().map(|r| r.amount_minor).collect();
            let centre = median(&mut amounts);
            if (row.amount_minor - centre).abs() * 10_000 <= centre * AMOUNT_TOLERANCE_BP {
                last.push(row);
                continue;
            }
        }
        out.push(vec![row]);
    }
    out
}

struct Fit {
    anchor: String,
    matched: Vec<(usize, i64)>,
    rank_milli: i64,
}

/// The best anchoring of `shape` over the occurrence days, if it qualifies.
fn fit(shape: Shape, days: &[String]) -> Option<Fit> {
    let numbers: Vec<i64> = days
        .iter()
        .filter_map(|d| civil::day_number_of(d))
        .collect();
    let (first, last) = (*numbers.first()?, *numbers.last()?);
    let mut best: Option<Fit> = None;
    for anchor in days {
        let mut expected: Vec<(i64, String)> = Vec::new();
        for k in -120..=120 {
            let Some(date) = shape.expected(anchor, k) else {
                continue;
            };
            let Some(number) = civil::day_number_of(&date) else {
                continue;
            };
            if number >= first - DAYS_TOLERANCE && number <= last + DAYS_TOLERANCE {
                expected.push((number, date));
            }
        }
        expected.sort();
        let mut used: BTreeSet<usize> = BTreeSet::new();
        let mut matched: Vec<(usize, i64)> = Vec::new();
        let mut missed_between: Vec<i64> = Vec::new();
        for (number, _) in &expected {
            let nearest = numbers
                .iter()
                .enumerate()
                .filter(|(at, n)| !used.contains(at) && (**n - number).abs() <= DAYS_TOLERANCE)
                .min_by_key(|(_, n)| (**n - number).abs());
            match nearest {
                Some((at, n)) => {
                    used.insert(at);
                    matched.push((at, (n - number).abs()));
                }
                None => missed_between.push(*number),
            }
        }
        if matched.len() < shape.minimum() || matched.len() * 4 < numbers.len() * 3 {
            continue;
        }
        // The anchor is the RRULE's start, so it must be one of the matches: a
        // stray charge that no expected date takes cannot start the series.
        let anchor_number = civil::day_number_of(anchor);
        if !matched
            .iter()
            .any(|(at, _)| Some(numbers[*at]) == anchor_number)
        {
            continue;
        }
        let first_match = matched
            .iter()
            .map(|(at, _)| numbers[*at])
            .min()
            .unwrap_or(first);
        let last_match = matched
            .iter()
            .map(|(at, _)| numbers[*at])
            .max()
            .unwrap_or(last);
        let missed = missed_between
            .iter()
            .filter(|n| **n > first_match && **n < last_match)
            .count();
        if missed * 4 > matched.len() + missed || (shape.is_position() && missed > 0) {
            continue;
        }
        let rank_milli: i64 = matched.iter().map(|(_, off)| 1000 / (off + 1)).sum();
        let candidate = Fit {
            anchor: anchor.clone(),
            matched,
            rank_milli,
        };
        let better = best.as_ref().is_none_or(|b| {
            (candidate.matched.len(), candidate.rank_milli) > (b.matched.len(), b.rank_milli)
        });
        if better {
            best = Some(candidate);
        }
    }
    best
}

/// Detects the series in `rows`: posted, non-void, unlinked debits on or
/// before `today`, as read from the lookback.
#[must_use]
pub fn detect(rows: &[TxnRow], linked: &BTreeSet<String>, today: &str) -> Vec<Series> {
    let mut groups: BTreeMap<(String, String, String), Vec<&TxnRow>> = BTreeMap::new();
    for row in rows {
        if row.status != "posted"
            || row.direction != Direction::Debit
            || linked.contains(&row.txn_id)
            || row.posted_on.as_str() > today
        {
            continue;
        }
        let key = merchant_key(&row.description);
        if key.is_empty() {
            continue;
        }
        groups
            .entry((row.account_id.clone(), key, row.currency.clone()))
            .or_default()
            .push(row);
    }
    let mut out = Vec::new();
    for ((account_id, key, currency), members) in groups {
        for cluster in clusters(&members) {
            let mut ordered = cluster.clone();
            ordered.sort_by(|a, b| (&a.posted_on, &a.txn_id).cmp(&(&b.posted_on, &b.txn_id)));
            let days: Vec<String> = ordered.iter().map(|r| r.posted_on.clone()).collect();
            let mut chosen: Option<(Shape, Fit)> = None;
            for shape in Shape::ALL {
                if let Some(found) = fit(shape, &days) {
                    let better = chosen.as_ref().is_none_or(|(old_shape, old)| {
                        (found.rank_milli, shape) > (old.rank_milli, *old_shape)
                    });
                    if better {
                        chosen = Some((shape, found));
                    }
                }
            }
            let Some((shape, found)) = chosen else {
                continue;
            };
            let cadence = shape.cadence();
            let Some(rrule) = shape.rrule(&found.anchor) else {
                continue;
            };
            if assert_supported(&rrule).is_err() {
                continue;
            }
            let matched_rows: Vec<&TxnRow> =
                found.matched.iter().map(|(at, _)| ordered[*at]).collect();
            let mut amounts: Vec<i64> = matched_rows.iter().map(|r| r.amount_minor).collect();
            let mut categories: BTreeMap<&str, usize> = BTreeMap::new();
            for row in &matched_rows {
                if let Some(category) = &row.category_concept_id {
                    *categories.entry(category).or_default() += 1;
                }
            }
            let category = categories
                .into_iter()
                .max_by_key(|(name, count)| (*count, std::cmp::Reverse(*name)))
                .map(|(name, _)| name.to_owned());
            let newest = matched_rows
                .iter()
                .max_by(|a, b| (&a.posted_on, &a.txn_id).cmp(&(&b.posted_on, &b.txn_id)))
                .copied();
            let Some(newest) = newest else { continue };
            let mut occurrences: Vec<String> =
                matched_rows.iter().map(|r| r.posted_on.clone()).collect();
            occurrences.sort();
            out.push(Series {
                account_id: account_id.clone(),
                merchant_key: key.clone(),
                currency: currency.clone(),
                cadence,
                rrule,
                anchor: found.anchor.clone(),
                median_amount_minor: median(&mut amounts),
                category_concept_id: category,
                occurrences,
                last_txn_id: newest.txn_id.clone(),
                last_seen: newest.posted_on.clone(),
                rank_milli: found.rank_milli,
            });
        }
    }
    out.sort_by(|a, b| {
        b.rank_milli.cmp(&a.rank_milli).then_with(|| {
            (&a.merchant_key, &a.account_id, a.median_amount_minor).cmp(&(
                &b.merchant_key,
                &b.account_id,
                b.median_amount_minor,
            ))
        })
    });
    out
}

impl Series {
    /// The expected dates in `[from, to)`, through the vault's one expander,
    /// each with its status as of `today`.
    #[must_use]
    pub fn project(&self, from: &str, to: &str, today: &str) -> Vec<Projected> {
        let input = ExpandInput::new(&self.rrule, &self.anchor, from, to)
            .with_semantics(Semantics::AllDay)
            .at_most(EXPAND_MAX);
        let seen: Vec<i64> = self
            .occurrences
            .iter()
            .filter_map(|d| civil::day_number_of(d))
            .collect();
        expand(&input)
            .into_iter()
            .filter_map(|occurrence| {
                let day: String = occurrence.start.chars().take(10).collect();
                let number = civil::day_number_of(&day)?;
                let status = if seen.iter().any(|s| (s - number).abs() <= DAYS_TOLERANCE) {
                    Status::Paid
                } else if civil::day_number_of(today)? <= number + DAYS_TOLERANCE {
                    Status::Due
                } else {
                    Status::Late
                };
                Some(Projected {
                    expected_on: day,
                    status,
                })
            })
            .collect()
    }

    /// The first expected date after `today` that is not already matched.
    #[must_use]
    pub fn next_due(&self, today: &str) -> Option<String> {
        let from = civil::shift(today, -DAYS_TOLERANCE)?;
        let to = civil::shift(today, 800)?;
        self.project(&from, &to, today)
            .into_iter()
            .find(|p| p.status != Status::Paid && p.status != Status::Late)
            .map(|p| p.expected_on)
    }
}

/// How many times a merchant appears in the lookback: the count a transaction
/// prints as "seen N times". Counts non-void rows of any account and either
/// direction under the same merchant key.
#[must_use]
pub fn seen_times(rows: &[TxnRow], description: &str) -> usize {
    let key = merchant_key(description);
    if key.is_empty() {
        return 0;
    }
    rows.iter()
        .filter(|r| !r.is_void() && merchant_key(&r.description) == key)
        .count()
}

/// One category's expected remaining charges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForecastLine {
    pub category_concept_id: Option<String>,
    pub amount_minor: i64,
    pub charges: usize,
}

/// The month-end forecast of one currency.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Forecast {
    pub currency: String,
    pub spent_so_far_minor: i64,
    /// Recurring charges expected after today and by the month's last day, at
    /// the series' median amount.
    pub expected_minor: i64,
    /// Spent so far plus expected.
    pub month_end_minor: i64,
    pub by_category: Vec<ForecastLine>,
}

/// Printed as its own definition: the month's spending so far plus the
/// recurring charges that have not yet posted and are due before the month
/// ends. A charge that already posted is in the spending, not in the expected.
#[must_use]
pub fn forecast(
    spent_so_far: &BTreeMap<String, i64>,
    series: &[Series],
    month: &str,
    today: &str,
    is_income: &dyn Fn(&str) -> bool,
) -> Vec<Forecast> {
    let Some(next_month) = civil::add_months(month, 1) else {
        return Vec::new();
    };
    let from = civil::shift(today, 1).unwrap_or_else(|| today.to_owned());
    let to = civil::month_start_stamp(&next_month)[..10].to_owned();
    let mut expected: BTreeMap<String, BTreeMap<Option<String>, (i64, usize)>> = BTreeMap::new();
    for one in series {
        if one.category_concept_id.as_deref().is_some_and(is_income) {
            continue;
        }
        let remaining = one
            .project(&from, &to, today)
            .into_iter()
            .filter(|p| p.status != Status::Paid)
            .count();
        if remaining == 0 {
            continue;
        }
        let slot = expected
            .entry(one.currency.clone())
            .or_default()
            .entry(one.category_concept_id.clone())
            .or_default();
        slot.0 += one.median_amount_minor * i64::try_from(remaining).unwrap_or(0);
        slot.1 += remaining;
    }
    let currencies: BTreeSet<&String> = spent_so_far.keys().chain(expected.keys()).collect();
    currencies
        .into_iter()
        .map(|currency| {
            let lines: Vec<ForecastLine> = expected
                .get(currency)
                .map(|m| {
                    m.iter()
                        .map(|(category, (amount, charges))| ForecastLine {
                            category_concept_id: category.clone(),
                            amount_minor: *amount,
                            charges: *charges,
                        })
                        .collect()
                })
                .unwrap_or_default();
            let expected_minor: i64 = lines.iter().map(|l| l.amount_minor).sum();
            let spent = spent_so_far.get(currency).copied().unwrap_or(0);
            Forecast {
                currency: currency.clone(),
                spent_so_far_minor: spent,
                expected_minor,
                month_end_minor: spent + expected_minor,
                by_category: lines,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, day: &str, amount: i64, description: &str) -> TxnRow {
        TxnRow {
            txn_id: id.into(),
            account_id: "A".into(),
            posted_on: day.into(),
            amount_minor: amount,
            currency: "USD".into(),
            direction: Direction::Debit,
            status: "posted".into(),
            description: description.into(),
            category_concept_id: None,
            external_id: None,
            display_name: None,
            display_name_source: None,
            memo: None,
            check_number: None,
            bank_type: None,
            imported_from: None,
        }
    }

    fn series_from(days: &[&str], amount: i64, name: &str) -> Vec<TxnRow> {
        days.iter()
            .enumerate()
            .map(|(at, day)| row(&format!("{name}{at}"), day, amount, name))
            .collect()
    }

    fn detect_only(rows: &[TxnRow]) -> Vec<Series> {
        detect(rows, &BTreeSet::new(), "2024-06-30")
    }

    #[test]
    fn a_weekly_charge_is_weekly_with_the_weekday_in_its_rrule() {
        let rows = series_from(
            &[
                "2024-05-06",
                "2024-05-13",
                "2024-05-20",
                "2024-05-27",
                "2024-06-03",
            ],
            2000,
            "GYM CLASS",
        );
        let found = detect_only(&rows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].cadence, Cadence::Weekly);
        assert_eq!(found[0].rrule, "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO");
        assert_eq!(found[0].median_amount_minor, 2000);
        assert_eq!(found[0].last_seen, "2024-06-03");
    }

    #[test]
    fn every_second_week_is_biweekly_not_weekly() {
        let rows = series_from(
            &[
                "2024-04-05",
                "2024-04-19",
                "2024-05-03",
                "2024-05-17",
                "2024-05-31",
            ],
            12000,
            "PAYROLL TAX",
        );
        let found = detect_only(&rows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].cadence, Cadence::Biweekly);
        assert_eq!(found[0].rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
    }

    #[test]
    fn a_monthly_charge_may_drift_two_days_and_vary_a_few_percent() {
        let mut rows = vec![
            row("a", "2024-03-15", 1599, "NETFLIX.COM"),
            row("b", "2024-04-17", 1599, "NETFLIX.COM"),
            row("c", "2024-05-14", 1650, "NETFLIX.COM"),
            row("d", "2024-06-15", 1599, "NETFLIX.COM"),
        ];
        let found = detect_only(&rows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].cadence, Cadence::Monthly);
        assert_eq!(found[0].rrule, "FREQ=MONTHLY;INTERVAL=1");
        assert_eq!(found[0].occurrences.len(), 4);
        // Three days off is too far.
        rows[1].posted_on = "2024-04-19".into();
        rows[2].posted_on = "2024-05-11".into();
        assert!(detect_only(&rows).is_empty());
    }

    #[test]
    fn quarterly_and_yearly_and_the_two_occurrence_yearly_minimum() {
        let quarterly = series_from(
            &["2023-09-10", "2023-12-10", "2024-03-10", "2024-06-10"],
            8000,
            "WATER BILL",
        );
        let found = detect_only(&quarterly);
        assert_eq!((found.len(), found[0].cadence), (1, Cadence::Quarterly));
        assert_eq!(found[0].rrule, "FREQ=MONTHLY;INTERVAL=3");
        let yearly = series_from(&["2023-06-20", "2024-06-20"], 9900, "DOMAIN RENEWAL");
        let found = detect(&yearly, &BTreeSet::new(), "2024-06-30");
        assert_eq!((found.len(), found[0].cadence), (1, Cadence::Yearly));
        assert_eq!(found[0].rrule, "FREQ=YEARLY;INTERVAL=1");
        // Two monthly occurrences are not a series.
        let two = series_from(&["2024-05-10", "2024-06-10"], 500, "ONE MORE");
        assert!(detect_only(&two).is_empty());
    }

    #[test]
    fn what_is_not_a_cadence_is_not_proposed() {
        // Daily coffee at one price: visited at random, not billed weekly.
        let days: Vec<String> = (1..=28).map(|d| format!("2024-05-{d:02}")).collect();
        let day_refs: Vec<&str> = days.iter().map(String::as_str).collect();
        assert!(detect_only(&series_from(&day_refs, 450, "COFFEE SHOP")).is_empty());
        // Dates that do not repeat.
        let scattered = series_from(
            &["2024-01-03", "2024-02-20", "2024-04-02", "2024-06-27"],
            700,
            "HARDWARE",
        );
        assert!(detect_only(&scattered).is_empty());
        // Amounts that do not agree.
        let varied = vec![
            row("a", "2024-04-10", 1000, "GAS CO"),
            row("b", "2024-05-10", 2500, "GAS CO"),
            row("c", "2024-06-10", 6000, "GAS CO"),
        ];
        assert!(detect_only(&varied).is_empty());
    }

    #[test]
    fn the_second_tuesday_of_the_month_is_offered_as_a_month_position() {
        let found = detect_only(&series_from(
            &["2024-04-09", "2024-05-14", "2024-06-11"],
            3000,
            "BOOK CLUB",
        ));
        assert_eq!(found.len(), 1);
        let one = &found[0];
        assert_eq!(
            one.cadence,
            Cadence::Monthly,
            "a month position is monthly on the wire"
        );
        assert_eq!(one.rrule, "FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU");
        assert_eq!(one.anchor, "2024-04-09");
        assert!(assert_supported(&one.rrule).is_ok());
        let projected = one.project("2024-06-01", "2024-09-01", "2024-06-30");
        assert_eq!(
            projected
                .iter()
                .map(|p| (p.expected_on.as_str(), p.status))
                .collect::<Vec<_>>(),
            vec![
                ("2024-06-11", Status::Paid),
                ("2024-07-09", Status::Due),
                ("2024-08-13", Status::Due),
            ]
        );
        assert_eq!(one.next_due("2024-06-30").as_deref(), Some("2024-07-09"));
    }

    #[test]
    fn each_ordinal_from_the_first_to_the_fourth_is_its_own_rule() {
        let rule_of = |days: &[&str]| {
            let found = detect_only(&series_from(days, 1200, "CLUB DUES"));
            assert_eq!(found.len(), 1, "{days:?}");
            found[0].rrule.clone()
        };
        assert_eq!(
            rule_of(&["2024-04-01", "2024-05-06", "2024-06-03"]),
            "FREQ=MONTHLY;INTERVAL=1;BYDAY=1MO"
        );
        assert_eq!(
            rule_of(&["2024-04-17", "2024-05-15", "2024-06-19"]),
            "FREQ=MONTHLY;INTERVAL=1;BYDAY=3WE"
        );
        // April's and June's 25th and 27th are also the LAST Thursday; May's
        // 23rd is not, so it is the 4th.
        assert_eq!(
            rule_of(&["2024-04-25", "2024-05-23", "2024-06-27"]),
            "FREQ=MONTHLY;INTERVAL=1;BYDAY=4TH"
        );
    }

    #[test]
    fn the_last_friday_is_the_last_when_the_month_has_a_fifth() {
        let found = detect_only(&series_from(
            &["2024-04-26", "2024-05-31", "2024-06-28"],
            4500,
            "TRIVIA NIGHT",
        ));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].rrule, "FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR");
        assert_eq!(
            found[0].next_due("2024-06-30").as_deref(),
            Some("2024-07-26")
        );
    }

    #[test]
    fn a_position_may_drift_two_days_and_no_further() {
        // Two days after the 2nd Tuesday of June is fine.
        let near = series_from(
            &["2024-04-09", "2024-05-14", "2024-06-13"],
            3000,
            "BOOK CLUB",
        );
        assert_eq!(
            detect_only(&near)[0].rrule,
            "FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU"
        );
        // Three days is not.
        let far = series_from(
            &["2024-04-09", "2024-05-14", "2024-06-14"],
            3000,
            "BOOK CLUB",
        );
        assert!(detect_only(&far).is_empty());
        // Nor are two months' worth a series.
        let two = series_from(&["2024-05-14", "2024-06-11"], 3000, "BOOK CLUB");
        assert!(detect_only(&two).is_empty());
    }

    #[test]
    fn a_charge_on_each_months_last_day_is_offered_as_the_months_end() {
        let found = detect_only(&series_from(
            &[
                "2024-02-29",
                "2024-03-31",
                "2024-04-30",
                "2024-05-31",
                "2024-06-30",
            ],
            3000,
            "RENT",
        ));
        assert_eq!(found.len(), 1);
        let one = &found[0];
        assert_eq!(one.cadence, Cadence::Monthly);
        assert_eq!(one.rrule, "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1");
        assert_eq!(one.anchor, "2024-02-29");
        assert_eq!(one.rank_milli, 5000);
        assert!(assert_supported(&one.rrule).is_ok());
        assert_eq!(one.next_due("2024-06-30").as_deref(), Some("2024-07-31"));
        let projected = one.project("2024-06-01", "2024-09-01", "2024-07-02");
        assert_eq!(
            projected
                .iter()
                .map(|p| (p.expected_on.as_str(), p.status))
                .collect::<Vec<_>>(),
            vec![
                ("2024-06-30", Status::Paid),
                ("2024-07-31", Status::Due),
                ("2024-08-31", Status::Due),
            ]
        );
    }

    #[test]
    fn the_last_business_day_counts_as_the_months_end_within_the_tolerance() {
        // Payroll on the last business day: June 30th is a Sunday and August
        // 31st a Saturday, so those months pay on the 28th and the 30th.
        let rows = series_from(
            &[
                "2024-05-31",
                "2024-06-28",
                "2024-07-31",
                "2024-08-30",
                "2024-09-30",
            ],
            250_000,
            "ACME PAYROLL DEBIT",
        );
        let found = detect(&rows, &BTreeSet::new(), "2024-10-05");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].rrule, "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1");
        assert_eq!(found[0].rank_milli, 3833);
        // The 28th of June is two days off the 30th: paid, not late.
        let june = found[0].project("2024-06-01", "2024-07-01", "2024-07-15");
        assert_eq!(june[0].expected_on, "2024-06-30");
        assert_eq!(june[0].status, Status::Paid);
        // Three days off the end is not the end.
        let far = series_from(
            &["2024-03-28", "2024-04-27", "2024-05-28", "2024-06-27"],
            250_000,
            "ACME PAYROLL DEBIT",
        );
        assert!(
            detect_only(&far)
                .iter()
                .all(|s| !s.rrule.contains("BYMONTHDAY"))
        );
    }

    #[test]
    fn an_off_pattern_match_may_anchor_a_month_end_series() {
        // March ends on a Sunday: the 29th is the first match, two days off.
        let found = detect_only(&series_from(
            &["2024-03-29", "2024-04-30", "2024-05-31", "2024-06-30"],
            250_000,
            "ACME PAYROLL DEBIT",
        ));
        assert_eq!(found[0].rrule, "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1");
        assert_eq!(found[0].anchor, "2024-03-29");
        // The first expected day is March 31st, not before the anchor's month.
        assert_eq!(
            found[0].project("2024-03-01", "2024-05-01", "2024-07-01")[0].expected_on,
            "2024-03-31"
        );
    }

    #[test]
    fn a_skipped_month_ends_a_position_but_not_a_day_of_the_month() {
        // Third-Friday charges with May missing.
        let position = series_from(
            &[
                "2024-02-16",
                "2024-03-15",
                "2024-04-19",
                "2024-06-21",
                "2024-07-19",
            ],
            900,
            "GYM",
        );
        assert!(detect(&position, &BTreeSet::new(), "2024-08-01").is_empty());
        // The same gap on the 15th is still a monthly charge.
        let day = series_from(
            &[
                "2024-02-15",
                "2024-03-15",
                "2024-04-15",
                "2024-06-15",
                "2024-07-15",
            ],
            900,
            "GYM",
        );
        assert_eq!(
            detect(&day, &BTreeSet::new(), "2024-08-01")[0].rrule,
            "FREQ=MONTHLY;INTERVAL=1"
        );
    }

    #[test]
    fn a_stray_charge_does_not_anchor_a_month_end_series() {
        let mut rows = series_from(
            &["2024-03-31", "2024-04-30", "2024-05-31", "2024-06-30"],
            3000,
            "RENT",
        );
        rows.push(row("stray", "2024-02-10", 3000, "RENT"));
        let found = detect_only(&rows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].anchor, "2024-03-31");
        assert!(!found[0].occurrences.contains(&"2024-02-10".to_owned()));
    }

    #[test]
    fn a_plain_day_of_the_month_still_wins_over_a_position_that_fits_no_better() {
        // The 15th: Netflix-style. No weekday or month-end shape ranks above it.
        let found = detect_only(&series_from(
            &["2024-04-15", "2024-05-15", "2024-06-15"],
            1599,
            "NETFLIX.COM",
        ));
        assert_eq!(found[0].rrule, "FREQ=MONTHLY;INTERVAL=1");
    }

    #[test]
    fn two_plans_from_one_merchant_are_two_series() {
        let mut rows = Vec::new();
        for (at, month) in ["2024-04", "2024-05", "2024-06"].iter().enumerate() {
            rows.push(row(
                &format!("a{at}"),
                &format!("{month}-05"),
                999,
                "STREAMCO",
            ));
            rows.push(row(
                &format!("b{at}"),
                &format!("{month}-20"),
                1999,
                "STREAMCO",
            ));
        }
        let found = detect_only(&rows);
        assert_eq!(found.len(), 2);
        let mut amounts: Vec<i64> = found.iter().map(|s| s.median_amount_minor).collect();
        amounts.sort_unstable();
        assert_eq!(amounts, vec![999, 1999]);
    }

    #[test]
    fn void_linked_credit_and_future_rows_do_not_count() {
        let mut rows = series_from(&["2024-04-10", "2024-05-10", "2024-06-10"], 500, "SPOTIFY");
        let mut linked = BTreeSet::new();
        linked.insert("SPOTIFY0".to_owned());
        assert!(detect(&rows, &linked, "2024-06-30").is_empty());
        rows[0].status = "void".into();
        assert!(detect_only(&rows).is_empty());
        rows[0].status = "posted".into();
        rows[1].direction = Direction::Credit;
        assert!(detect_only(&rows).is_empty());
        rows[1].direction = Direction::Debit;
        assert!(detect(&rows, &BTreeSet::new(), "2024-06-05").is_empty());
    }

    #[test]
    fn the_rrule_is_the_vaults_and_is_projected_by_its_expander() {
        let found = detect_only(&series_from(
            &["2024-04-15", "2024-05-15", "2024-06-15"],
            1599,
            "NETFLIX.COM",
        ));
        let one = &found[0];
        assert!(assert_supported(&one.rrule).is_ok());
        let projected = one.project("2024-06-01", "2024-09-01", "2024-06-30");
        assert_eq!(
            projected
                .iter()
                .map(|p| (p.expected_on.as_str(), p.status))
                .collect::<Vec<_>>(),
            vec![
                ("2024-06-15", Status::Paid),
                ("2024-07-15", Status::Due),
                ("2024-08-15", Status::Due),
            ]
        );
        assert_eq!(one.next_due("2024-06-30").as_deref(), Some("2024-07-15"));
    }

    #[test]
    fn due_until_two_days_after_then_late_and_paid_when_seen() {
        let found = detect_only(&series_from(
            &["2024-04-15", "2024-05-15", "2024-06-15"],
            1599,
            "NETFLIX.COM",
        ));
        let one = &found[0];
        let status = |today: &str| one.project("2024-07-01", "2024-08-01", today)[0].status;
        assert_eq!(status("2024-07-10"), Status::Due, "before its date");
        assert_eq!(status("2024-07-15"), Status::Due);
        assert_eq!(
            status("2024-07-17"),
            Status::Due,
            "two days past is still due"
        );
        assert_eq!(status("2024-07-18"), Status::Late);
        // Seen within two days of the date: paid, whatever today is.
        let mut seen = one.clone();
        seen.occurrences.push("2024-07-16".into());
        assert_eq!(
            seen.project("2024-07-01", "2024-08-01", "2024-07-30")[0].status,
            Status::Paid
        );
    }

    #[test]
    fn the_forecast_adds_what_has_not_posted_and_is_due_this_month() {
        let found = detect_only(&series_from(
            &["2024-04-25", "2024-05-25", "2024-06-25"],
            1599,
            "NETFLIX.COM",
        ));
        let mut spent = BTreeMap::new();
        spent.insert("USD".to_owned(), 16_599);
        // Today is the 20th of the month before the charge: it is still to come.
        let fc = forecast(&spent, &found, "2024-07", "2024-07-20", &|_| false);
        // The July 25th charge is after the 20th.
        assert_eq!(fc.len(), 1);
        assert_eq!(fc[0].spent_so_far_minor, 16_599);
        assert_eq!(fc[0].expected_minor, 1_599);
        assert_eq!(fc[0].month_end_minor, 18_198);
        // After the charge date nothing more is expected this month.
        let after = forecast(&spent, &found, "2024-07", "2024-07-26", &|_| false);
        assert_eq!(after[0].expected_minor, 0);
        // An income-group series is not spending.
        let mut income = found.clone();
        income[0].category_concept_id = Some("money:cat:income".into());
        let none = forecast(&spent, &income, "2024-07", "2024-07-20", &|c| {
            c == "money:cat:income"
        });
        assert_eq!(none[0].expected_minor, 0);
    }

    #[test]
    fn seen_times_counts_the_merchant_across_the_lookback() {
        let rows = vec![
            row("a", "2024-04-10", 500, "STARBUCKS #12"),
            row("b", "2024-05-10", 600, "Starbucks #99"),
            row("c", "2024-05-11", 600, "PEETS"),
        ];
        assert_eq!(seen_times(&rows, "STARBUCKS #1"), 2);
        assert_eq!(seen_times(&rows, "UNKNOWN"), 0);
    }
}
