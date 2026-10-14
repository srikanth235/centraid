//! THE PLAN: what a statement would do, as a value (R-1099-3).
//!
//! `plan` is pure over the parsed [`Statement`], the account's existing rows in
//! the statement's date window (the loader reads them, bounded; see
//! [`existing_window`]), the rules and today. It writes nothing and returns one
//! verdict per data row, in file order:
//!
//! 1. **Rules** set each readable row's category and display name.
//! 2. **Exact de-duplication** — a row whose `external_id` an existing row
//!    carries is [`RowVerdict::AlreadyIn`]. Claiming is one-to-one.
//! 3. **In-file repeats collapse** — the same `external_id` twice in one file is
//!    one transaction: the second is [`RowVerdict::RepeatInFile`].
//! 4. **The fuzzy pass only PROPOSES** ([`RowVerdict::ProposedDuplicate`]): same
//!    account, same direction and amount, within [`FUZZY_DAYS`] days, a
//!    description at least [`SIMILARITY_THRESHOLD`] alike, against an existing
//!    row nothing else has claimed — and never between two rows that both carry
//!    a bank's own, different `FITID`: two FITIDs are two transactions. The
//!    window is days and the amount is exact, so a weekly $9.99 is never
//!    mistaken for last week's.
//!
//! A row is never dropped by a rule: v0 rules set a category and a display name
//! and nothing else, so there is no "dropped by rule" verdict. A row dated after
//! `today` is imported and flagged ([`PlanRow::future_dated`]).

use std::collections::{HashMap, HashSet};

use crate::civil;
use crate::rules::{self, Rule};

use super::{
    Checkpoint, CsvProfile, DateOrderQuestion, Direction, ImportRow, RejectReason, Statement,
    Warning,
};

/// The widest gap, in days, between a row and the existing row it may be
/// proposed as a duplicate of.
pub const FUZZY_DAYS: i64 = 3;

/// The bigram similarity (Dice) at which two descriptions are "the same
/// merchant" for a proposal. Half: `STARBUCKS` against `STARBUCKS #1234
/// SEATTLE` scores about 0.55 and a bank relabelling pending to posted usually
/// keeps the merchant's name; two unrelated merchants score under 0.3. A false
/// proposal costs the member one tap and a missed one costs a double count, so
/// the threshold sits low and the amount-and-day gates carry the precision.
pub const SIMILARITY_THRESHOLD: f64 = 0.5;

/// A row the account already holds, as the plan compares against it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExistingTxn {
    pub txn_id: String,
    pub external_id: Option<String>,
    pub posted_on: String,
    /// The magnitude, > 0.
    pub amount_minor: i64,
    pub direction: Direction,
    pub description: String,
    pub display_name: Option<String>,
}

/// What one row would do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowVerdict {
    /// Not in the account: it would be inserted.
    New,
    /// Its `external_id` is already in the account.
    AlreadyIn { existing: String },
    /// Probably an existing row under another description or id; the member
    /// decides. It is imported only when they say so.
    ProposedDuplicate { existing: String },
    /// The same `external_id` as an earlier row of this file.
    RepeatInFile { first_line: usize },
    /// The row could not be read.
    Rejected { reason: RejectReason },
}

/// One data row of the file, with its verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanRow {
    /// 1-based line in the file.
    pub line: usize,
    /// The row as it would be imported (rules applied); `None` when rejected.
    pub row: Option<ImportRow>,
    pub verdict: RowVerdict,
    /// Dated after today: still imported, flagged.
    pub future_dated: bool,
}

/// The plan's counts and sums. The verdict counts add up to `rows`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PlanTotals {
    pub rows: usize,
    pub new: usize,
    pub already_in: usize,
    pub proposed_duplicates: usize,
    pub repeats_in_file: usize,
    pub rejected: usize,
    pub future_dated: usize,
    /// The account's currency; every sum below is in it.
    pub currency: String,
    /// Money in / out over every readable row of the file, minor units.
    pub file_in_minor: i64,
    pub file_out_minor: i64,
    /// The same over the rows that would be inserted.
    pub new_in_minor: i64,
    pub new_out_minor: i64,
    /// The earliest and latest printed day among the readable rows.
    pub first_day: Option<String>,
    pub last_day: Option<String>,
}

/// The whole plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportPlan {
    pub rows: Vec<PlanRow>,
    pub totals: PlanTotals,
    /// Set when the file could not say its date order; `rows` is then empty.
    pub question: Option<DateOrderQuestion>,
    pub checkpoint: Option<Checkpoint>,
    pub warnings: Vec<Warning>,
    pub profile: Option<CsvProfile>,
}

/// The `(from, to)` days (inclusive) of existing rows the plan needs: the
/// statement's first and last day, each widened by [`FUZZY_DAYS`].
#[must_use]
pub fn existing_window(statement: &Statement) -> Option<(String, String)> {
    let (first, last) =
        statement
            .readable()
            .fold((None::<&str>, None::<&str>), |(first, last), (_, row)| {
                let day = row.posted_on.as_str();
                (
                    Some(first.map_or(day, |f| f.min(day))),
                    Some(last.map_or(day, |l| l.max(day))),
                )
            });
    Some((
        civil::shift(first?, -FUZZY_DAYS)?,
        civil::shift(last?, FUZZY_DAYS)?,
    ))
}

fn bigrams(text: &str) -> HashMap<(char, char), usize> {
    let chars: Vec<char> = rules::normalise(text).chars().collect();
    let mut counts = HashMap::new();
    for pair in chars.windows(2) {
        *counts.entry((pair[0], pair[1])).or_insert(0) += 1;
    }
    counts
}

/// How alike two descriptions are, 0..=1: one containing the other (at least
/// four characters) is 1; otherwise the Dice coefficient of their character
/// bigrams.
#[must_use]
pub fn similarity(left: &str, right: &str) -> f64 {
    let (a, b) = (rules::normalise(left), rules::normalise(right));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (short, long) = if a.len() <= b.len() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    if short.chars().count() >= 4 && long.contains(short.as_str()) {
        return 1.0;
    }
    let (left, right) = (bigrams(&a), bigrams(&b));
    let total: usize = left.values().sum::<usize>() + right.values().sum::<usize>();
    if total == 0 {
        return 0.0;
    }
    let shared: usize = left
        .iter()
        .map(|(pair, count)| (*count).min(right.get(pair).copied().unwrap_or(0)))
        .sum();
    #[allow(clippy::cast_precision_loss)]
    {
        2.0 * shared as f64 / total as f64
    }
}

/// Two rows that both carry a bank's own, different `FITID` are two
/// transactions.
fn distinct_fitids(left: &str, right: Option<&str>) -> bool {
    right
        .is_some_and(|right| left.starts_with("ofx:") && right.starts_with("ofx:") && left != right)
}

/// Plans `statement` for `account_id` (whose currency is `currency`).
#[must_use]
pub fn plan(
    statement: &Statement,
    account_id: &str,
    currency: &str,
    existing: &[ExistingTxn],
    rules: &[Rule],
    today: &str,
) -> ImportPlan {
    let mut totals = PlanTotals {
        currency: currency.to_owned(),
        ..PlanTotals::default()
    };
    let mut rows: Vec<PlanRow> = Vec::with_capacity(statement.rows.len());
    // Step 1: rules, and the reading.
    for parsed in &statement.rows {
        match &parsed.result {
            Ok(row) => {
                let mut row = row.clone();
                rules::apply_to_row(rules, account_id, &mut row);
                let future_dated = row.posted_on.as_str() > today;
                rows.push(PlanRow {
                    line: parsed.line,
                    row: Some(row),
                    verdict: RowVerdict::New,
                    future_dated,
                });
            }
            Err(reason) => rows.push(PlanRow {
                line: parsed.line,
                row: None,
                verdict: RowVerdict::Rejected { reason: *reason },
                future_dated: false,
            }),
        }
    }
    // Steps 2 and 3: exact, one-to-one; then in-file repeats.
    let by_external: HashMap<&str, usize> = existing
        .iter()
        .enumerate()
        .filter_map(|(at, e)| e.external_id.as_deref().map(|id| (id, at)))
        .collect();
    let mut claimed: HashSet<usize> = HashSet::new();
    let mut first_seen: HashMap<String, usize> = HashMap::new();
    for plan_row in &mut rows {
        let Some(row) = &plan_row.row else { continue };
        if let Some(&first_line) = first_seen.get(&row.external_id) {
            plan_row.verdict = RowVerdict::RepeatInFile { first_line };
            continue;
        }
        first_seen.insert(row.external_id.clone(), plan_row.line);
        if let Some(&at) = by_external.get(row.external_id.as_str())
            && claimed.insert(at)
        {
            plan_row.verdict = RowVerdict::AlreadyIn {
                existing: existing[at].txn_id.clone(),
            };
        }
    }
    // Step 4: the fuzzy proposal, one-to-one over what is left.
    let mut index: HashMap<(Direction, i64), Vec<usize>> = HashMap::new();
    for (at, e) in existing.iter().enumerate() {
        if !claimed.contains(&at) {
            index
                .entry((e.direction, e.amount_minor))
                .or_default()
                .push(at);
        }
    }
    let mut candidates: Vec<(f64, i64, usize, usize, usize)> = Vec::new();
    for (position, plan_row) in rows.iter().enumerate() {
        let (RowVerdict::New, Some(row)) = (&plan_row.verdict, &plan_row.row) else {
            continue;
        };
        let Some(day) = civil::day_number_of(&row.posted_on) else {
            continue;
        };
        for &at in index
            .get(&(row.direction, row.amount_minor))
            .into_iter()
            .flatten()
        {
            let other = &existing[at];
            let Some(other_day) = civil::day_number_of(&other.posted_on) else {
                continue;
            };
            let gap = (day - other_day).abs();
            if gap > FUZZY_DAYS || distinct_fitids(&row.external_id, other.external_id.as_deref()) {
                continue;
            }
            let alike = similarity(&row.description, &other.description);
            if alike >= SIMILARITY_THRESHOLD {
                candidates.push((alike, gap, plan_row.line, position, at));
            }
        }
    }
    candidates.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
            .then(a.4.cmp(&b.4))
    });
    let mut decided: HashSet<usize> = HashSet::new();
    for (_, _, _, position, at) in candidates {
        if decided.contains(&position) || claimed.contains(&at) {
            continue;
        }
        decided.insert(position);
        claimed.insert(at);
        rows[position].verdict = RowVerdict::ProposedDuplicate {
            existing: existing[at].txn_id.clone(),
        };
    }
    // Totals.
    totals.rows = rows.len();
    for plan_row in &rows {
        if plan_row.future_dated {
            totals.future_dated += 1;
        }
        match &plan_row.verdict {
            RowVerdict::New => totals.new += 1,
            RowVerdict::AlreadyIn { .. } => totals.already_in += 1,
            RowVerdict::ProposedDuplicate { .. } => totals.proposed_duplicates += 1,
            RowVerdict::RepeatInFile { .. } => totals.repeats_in_file += 1,
            RowVerdict::Rejected { .. } => totals.rejected += 1,
        }
        let Some(row) = &plan_row.row else { continue };
        let (file, fresh) = match row.direction {
            Direction::Credit => (&mut totals.file_in_minor, &mut totals.new_in_minor),
            Direction::Debit => (&mut totals.file_out_minor, &mut totals.new_out_minor),
        };
        *file += row.amount_minor;
        if plan_row.verdict == RowVerdict::New {
            *fresh += row.amount_minor;
        }
        let day = &row.posted_on;
        if totals.first_day.as_ref().is_none_or(|first| day < first) {
            totals.first_day = Some(day.clone());
        }
        if totals.last_day.as_ref().is_none_or(|last| day > last) {
            totals.last_day = Some(day.clone());
        }
    }
    ImportPlan {
        rows,
        totals,
        question: statement.question.clone(),
        checkpoint: statement.checkpoint.clone(),
        warnings: statement.warnings.clone(),
        profile: statement.profile.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similarity_is_high_for_the_same_merchant_and_low_for_another() {
        assert!(similarity("STARBUCKS", "Starbucks #1234 Seattle") >= SIMILARITY_THRESHOLD);
        assert!(similarity("AMAZON MKTPLACE PMTS", "AMAZON MKTPLACE") >= SIMILARITY_THRESHOLD);
        assert!(similarity("SHELL OIL", "TIM HORTONS") < 0.3);
        assert!(similarity("", "X") < f64::EPSILON);
    }
}
