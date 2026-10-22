//! MONEY'S FOLDS: every figure on a Money screen, derived at read time.
//!
//! Pure functions over the rows [`crate::queries`] read. **Nothing here is
//! stored and nothing sums across currencies**: every result is keyed by
//! currency, and the screens print one line per currency. A balance is the
//! account's opening balance plus the signed `posted` rows after its opening
//! date; a checkpoint is evidence it is compared with, never the balance.
//!
//! ## The definitions the screens print
//!
//! - **Spending.** In one month, on accounts that are on budget: the debits of
//!   `posted` rows less the credits filed under the same category, per
//!   category. A row does not count if it is voided, is one half of a transfer
//!   the member linked, is dated after today (counted on its own line), or is
//!   in the income group. A category refunded past what it spent shows its
//!   surplus as a **refund credit** and does not lower any other category.
//!   Uncategorised debits are one line of their own; an uncategorised credit
//!   is not spending (it is money in).
//! - **In, out, net.** The same rows: credits are in, debits are out, net is
//!   in less out.
//! - **Savings rate.** Net over in, in basis points; none when nothing came in.
//! - **Balance.** Opening balance plus every `posted`, non-void row dated after
//!   the opening date and on or before the day asked about, credits plus and
//!   debits minus; an account with no opening date counts every row.
//! - **Planned.** The target plus what the previous month left unused, if that
//!   month's target carries. Left is planned less spent.

use std::collections::{BTreeMap, BTreeSet};

use crate::civil;
use crate::import::Direction;
use crate::queries::{AccountRow, CategoryRow, CheckpointRow, INCOME_GROUP, TargetRow, TxnRow};

/// How many months back a carry chain is followed.
pub const CARRY_MONTHS: usize = 12;
/// The months averaged for the target sheet.
pub const AVERAGE_MONTHS: usize = 6;

/// What the folds know about the vault beside the rows.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    pub accounts: &'a [AccountRow],
    pub categories: &'a [CategoryRow],
    /// Transaction ids that are an end of a live transfer link.
    pub linked: &'a BTreeSet<String>,
    /// `YYYY-MM-DD`.
    pub today: &'a str,
}

impl Context<'_> {
    fn account(&self, id: &str) -> Option<&AccountRow> {
        self.accounts.iter().find(|a| a.account_id == id)
    }

    /// Whether the account counts toward the month's plan.
    #[must_use]
    pub fn on_budget(&self, account_id: &str) -> bool {
        self.account(account_id).is_some_and(|a| a.on_budget)
    }

    /// Whether a category is, or sits under, the income group.
    #[must_use]
    pub fn is_income(&self, category_id: &str) -> bool {
        category_id == INCOME_GROUP
            || self
                .categories
                .iter()
                .find(|c| c.concept_id == category_id)
                .and_then(|c| c.parent.as_deref())
                == Some(INCOME_GROUP)
    }

    fn live(&self, row: &TxnRow) -> bool {
        row.status == "posted" && !row.is_void()
    }

    /// A row in the plan's arithmetic: on budget, posted, not one half of a
    /// transfer.
    #[must_use]
    pub fn counts(&self, row: &TxnRow) -> bool {
        self.live(row) && self.on_budget(&row.account_id) && !self.linked.contains(&row.txn_id)
    }
}

/// `num / den` in basis points, rounded half away from zero; none for a zero
/// denominator.
#[must_use]
pub fn ratio_bp(num: i64, den: i64) -> Option<i64> {
    if den == 0 {
        return None;
    }
    let scaled = i128::from(num) * 10_000;
    let den = i128::from(den);
    let half = den.abs() / 2;
    let rounded = if (scaled < 0) == (den < 0) {
        (scaled.abs() + half) / den.abs()
    } else {
        -((scaled.abs() + half) / den.abs())
    };
    i64::try_from(rounded).ok()
}

// ---------------------------------------------------------------------------
// Spending, in / out / net.
// ---------------------------------------------------------------------------

/// One line of the month: a category, or `None` for uncategorised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendingLine {
    pub category_id: Option<String>,
    /// Purchases less refunds, never negative.
    pub spent_minor: i64,
    /// Refunds past purchases.
    pub refund_credit_minor: i64,
    pub rows: usize,
}

/// A month in one currency.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CurrencySpending {
    pub currency: String,
    /// Categories by spent, largest first; the uncategorised line last.
    pub lines: Vec<SpendingLine>,
    pub spent_minor: i64,
    pub refund_credit_minor: i64,
    pub in_minor: i64,
    pub out_minor: i64,
    /// Rows left out because the member linked them as transfers (on-budget
    /// accounts only), and their sum.
    pub transfers_excluded_count: usize,
    pub transfers_excluded_minor: i64,
    /// Rows dated after today, left out of "so far".
    pub future_count: usize,
    pub future_minor: i64,
}

impl CurrencySpending {
    #[must_use]
    pub const fn net_minor(&self) -> i64 {
        self.in_minor - self.out_minor
    }
}

/// The month's rows, folded per currency.
#[must_use]
pub fn spending(rows: &[TxnRow], month: &str, ctx: &Context<'_>) -> Vec<CurrencySpending> {
    let mut out: BTreeMap<String, CurrencySpending> = BTreeMap::new();
    // (currency, category) -> (debits, credits, rows)
    let mut nets: BTreeMap<(String, Option<String>), (i64, i64, usize)> = BTreeMap::new();
    for row in rows {
        if civil::month_of(&row.posted_on) != month
            || !ctx.live(row)
            || !ctx.on_budget(&row.account_id)
        {
            continue;
        }
        let entry = out
            .entry(row.currency.clone())
            .or_insert_with(|| CurrencySpending {
                currency: row.currency.clone(),
                ..CurrencySpending::default()
            });
        if ctx.linked.contains(&row.txn_id) {
            entry.transfers_excluded_count += 1;
            entry.transfers_excluded_minor += row.amount_minor;
            continue;
        }
        if row.posted_on.as_str() > ctx.today {
            entry.future_count += 1;
            entry.future_minor += row.amount_minor;
            continue;
        }
        match row.direction {
            Direction::Credit => entry.in_minor += row.amount_minor,
            Direction::Debit => entry.out_minor += row.amount_minor,
        }
        let category = row.category_concept_id.clone();
        if category.as_deref().is_some_and(|id| ctx.is_income(id)) {
            continue;
        }
        if category.is_none() && row.direction == Direction::Credit {
            continue;
        }
        let slot = nets.entry((row.currency.clone(), category)).or_default();
        match row.direction {
            Direction::Debit => slot.0 += row.amount_minor,
            Direction::Credit => slot.1 += row.amount_minor,
        }
        slot.2 += 1;
    }
    for ((currency, category), (debits, credits, count)) in nets {
        let net = debits - credits;
        let line = SpendingLine {
            category_id: category,
            spent_minor: net.max(0),
            refund_credit_minor: (-net).max(0),
            rows: count,
        };
        if let Some(entry) = out.get_mut(&currency) {
            entry.spent_minor += line.spent_minor;
            entry.refund_credit_minor += line.refund_credit_minor;
            entry.lines.push(line);
        }
    }
    for entry in out.values_mut() {
        entry.lines.sort_by(|a, b| {
            a.category_id
                .is_none()
                .cmp(&b.category_id.is_none())
                .then(b.spent_minor.cmp(&a.spent_minor))
                .then(a.category_id.cmp(&b.category_id))
        });
    }
    out.into_values().collect()
}

// ---------------------------------------------------------------------------
// Cash flow.
// ---------------------------------------------------------------------------

/// One month of one currency's cash flow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowMonth {
    pub month: String,
    pub in_minor: i64,
    pub out_minor: i64,
    pub net_minor: i64,
    /// Net over in, basis points; none when nothing came in.
    pub savings_rate_bp: Option<i64>,
    /// The month is still going: today is before its last day.
    pub partial: bool,
}

/// A month and its `(in, out)` per currency.
type MonthSums = (String, BTreeMap<String, (i64, i64)>);

/// The windows, oldest first, folded: one series per currency seen. Every
/// currency has an entry for every window, so a chart has no holes.
#[must_use]
pub fn cashflow(
    windows: &[(String, Vec<TxnRow>)],
    ctx: &Context<'_>,
) -> BTreeMap<String, Vec<FlowMonth>> {
    let mut currencies: BTreeSet<String> = BTreeSet::new();
    let mut per: Vec<MonthSums> = Vec::new();
    for (month, rows) in windows {
        let mut sums: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for row in rows {
            if civil::month_of(&row.posted_on) != month
                || !ctx.counts(row)
                || row.posted_on.as_str() > ctx.today
            {
                continue;
            }
            currencies.insert(row.currency.clone());
            let slot = sums.entry(row.currency.clone()).or_default();
            match row.direction {
                Direction::Credit => slot.0 += row.amount_minor,
                Direction::Debit => slot.1 += row.amount_minor,
            }
        }
        per.push((month.clone(), sums));
    }
    let today_month = civil::month_of(ctx.today);
    let last_day = civil::day_of_month(ctx.today).unwrap_or(0);
    currencies
        .into_iter()
        .map(|currency| {
            let series = per
                .iter()
                .map(|(month, sums)| {
                    let (inn, out) = sums.get(&currency).copied().unwrap_or_default();
                    FlowMonth {
                        month: month.clone(),
                        in_minor: inn,
                        out_minor: out,
                        net_minor: inn - out,
                        savings_rate_bp: ratio_bp(inn - out, inn),
                        partial: month == today_month && last_day < civil::month_length(month),
                    }
                })
                .collect();
            (currency, series)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Balances.
// ---------------------------------------------------------------------------

/// The balance of an account on `day`: where it opened plus every signed posted
/// row on or before `day`. The opening balance is what the account held before
/// its first line, so every line counts.
#[must_use]
pub fn balance_on(account: &AccountRow, ledger: &[TxnRow], day: &str) -> i64 {
    account.opening_minor
        + ledger
            .iter()
            .filter(|row| row.status == "posted" && row.posted_on.as_str() <= day)
            .map(TxnRow::signed_minor)
            .sum::<i64>()
}

/// A stated balance against the derived one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointCompare {
    pub as_of: String,
    pub stated_minor: i64,
    /// Derived less stated.
    pub delta_minor: i64,
    pub agrees: bool,
}

/// An account's balance and how it stands against its latest checkpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountBalance {
    pub account_id: String,
    pub currency: String,
    /// `None` when the ledger was longer than the read could hold.
    pub balance_minor: Option<i64>,
    pub checkpoint: Option<CheckpointCompare>,
}

/// The balance of `account` today and its comparison with the newest
/// checkpoint on or before today. `ledger` is `None` when it was truncated.
#[must_use]
pub fn account_balance(
    account: &AccountRow,
    ledger: Option<&[TxnRow]>,
    checkpoints: &[CheckpointRow],
    today: &str,
) -> AccountBalance {
    let checkpoint = checkpoints
        .iter()
        .filter(|c| c.account_id == account.account_id && c.as_of.as_str() <= today)
        .max_by(|a, b| a.as_of.cmp(&b.as_of))
        .and_then(|c| {
            let derived = balance_on(account, ledger?, &c.as_of);
            Some(CheckpointCompare {
                as_of: c.as_of.clone(),
                stated_minor: c.balance_minor,
                delta_minor: derived - c.balance_minor,
                agrees: derived == c.balance_minor,
            })
        });
    AccountBalance {
        account_id: account.account_id.clone(),
        currency: account.currency.clone(),
        balance_minor: ledger.map(|rows| balance_on(account, rows, today)),
        checkpoint,
    }
}

/// Net worth per currency over the accounts that are open and whose balance
/// could be derived; `complete` is false when one could not.
#[must_use]
pub fn net_worth(
    balances: &[AccountBalance],
    accounts: &[AccountRow],
    today: &str,
) -> BTreeMap<String, (i64, bool)> {
    let mut out: BTreeMap<String, (i64, bool)> = BTreeMap::new();
    for balance in balances {
        let open = accounts
            .iter()
            .find(|a| a.account_id == balance.account_id)
            .is_some_and(|a| a.closed_on.as_deref().is_none_or(|closed| closed > today));
        if !open {
            continue;
        }
        let slot = out.entry(balance.currency.clone()).or_insert((0, true));
        match balance.balance_minor {
            Some(value) => slot.0 += value,
            None => slot.1 = false,
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Targets.
// ---------------------------------------------------------------------------

/// How a month's leftover moves. **Tracking is the only mode v0 constructs**
/// (R-1099-5): a month's unused amount carries when its target says so, and
/// overspending never does. `Envelope` is the dormant branch of the same
/// reducer — overspending rolls forward too — with no schema and no caller;
/// `the_default_is_tracking` pins that.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TargetMode {
    #[default]
    Tracking,
    Envelope,
}

/// Spent per `(month, currency, category)`: debits less credits, signed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpentIndex(BTreeMap<(String, String, String), i64>);

impl SpentIndex {
    /// Folds month windows; the same rows [`spending`] counts, except that the
    /// future-dated rows of the current month are not in it either.
    #[must_use]
    pub fn from_windows(windows: &[(String, Vec<TxnRow>)], ctx: &Context<'_>) -> Self {
        let mut map: BTreeMap<(String, String, String), i64> = BTreeMap::new();
        for (month, rows) in windows {
            for row in rows {
                if civil::month_of(&row.posted_on) != month
                    || !ctx.counts(row)
                    || row.posted_on.as_str() > ctx.today
                {
                    continue;
                }
                let Some(category) = row.category_concept_id.clone() else {
                    continue;
                };
                if ctx.is_income(&category) {
                    continue;
                }
                let signed = -row.signed_minor();
                *map.entry((month.clone(), row.currency.clone(), category))
                    .or_default() += signed;
            }
        }
        Self(map)
    }

    /// Net spent on `category` and everything beneath it.
    #[must_use]
    pub fn spent_under(
        &self,
        month: &str,
        currency: &str,
        category: &str,
        categories: &[CategoryRow],
    ) -> i64 {
        let children: BTreeSet<&str> = categories
            .iter()
            .filter(|c| c.parent.as_deref() == Some(category))
            .map(|c| c.concept_id.as_str())
            .collect();
        self.0
            .iter()
            .filter(|((m, cur, cat), _)| {
                m == month
                    && cur == currency
                    && (cat == category || children.contains(cat.as_str()))
            })
            .map(|(_, value)| *value)
            .sum()
    }
}

/// One category in one month against its plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetStatus {
    pub category_id: String,
    pub month: String,
    pub currency: String,
    pub amount_minor: i64,
    pub carry: bool,
    pub carry_in_minor: i64,
    pub planned_minor: i64,
    pub spent_minor: i64,
    pub left_minor: i64,
    pub over: bool,
}

fn find_target<'a>(targets: &'a [TargetRow], month: &str, category: &str) -> Option<&'a TargetRow> {
    targets
        .iter()
        .find(|t| t.month == month && t.category_concept_id == category)
}

fn planned(
    targets: &[TargetRow],
    spent: &SpentIndex,
    categories: &[CategoryRow],
    month: &str,
    category: &str,
    mode: TargetMode,
    depth: usize,
) -> Option<(i64, i64)> {
    let target = find_target(targets, month, category)?;
    let mut carry_in = 0;
    if depth < CARRY_MONTHS
        && let Some(previous) = civil::add_months(month, -1)
        && let Some(before) = find_target(targets, &previous, category)
        && before.carry
        && let Some((before_planned, _)) = planned(
            targets,
            spent,
            categories,
            &previous,
            category,
            mode,
            depth + 1,
        )
    {
        let before_spent = spent
            .spent_under(&previous, &before.currency, category, categories)
            .max(0);
        let left = before_planned - before_spent;
        carry_in = match mode {
            TargetMode::Tracking => left.max(0),
            TargetMode::Envelope => left,
        };
    }
    Some((target.amount_minor + carry_in, carry_in))
}

/// A category's status in `month`, or none when it has no target there.
#[must_use]
pub fn target_status(
    targets: &[TargetRow],
    spent: &SpentIndex,
    categories: &[CategoryRow],
    month: &str,
    category: &str,
    mode: TargetMode,
) -> Option<TargetStatus> {
    let target = find_target(targets, month, category)?;
    let (planned_minor, carry_in_minor) =
        planned(targets, spent, categories, month, category, mode, 0)?;
    let spent_minor = spent
        .spent_under(month, &target.currency, category, categories)
        .max(0);
    Some(TargetStatus {
        category_id: category.to_owned(),
        month: month.to_owned(),
        currency: target.currency.clone(),
        amount_minor: target.amount_minor,
        carry: target.carry,
        carry_in_minor,
        planned_minor,
        spent_minor,
        left_minor: planned_minor - spent_minor,
        over: spent_minor > planned_minor,
    })
}

/// The target sheet's two derived figures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetSheet {
    /// Net spent on the category in each of the previous [`AVERAGE_MONTHS`]
    /// months, averaged and rounded half away from zero.
    pub six_month_average_minor: i64,
    /// What next month would plan if this amount repeated: the amount, plus
    /// this month's unused part when the target carries.
    pub next_month_preview_minor: i64,
}

/// What the target sheet is asked about.
#[derive(Debug, Clone, Copy)]
pub struct SheetInput<'a> {
    pub month: &'a str,
    pub category: &'a str,
    pub currency: &'a str,
    /// The amount being typed.
    pub amount_minor: i64,
    pub carry: bool,
}

/// The sheet for a category in a month at an amount and carry setting.
#[must_use]
pub fn target_sheet(
    targets: &[TargetRow],
    spent: &SpentIndex,
    categories: &[CategoryRow],
    input: &SheetInput<'_>,
) -> TargetSheet {
    let SheetInput {
        month,
        category,
        currency,
        amount_minor,
        carry,
    } = *input;
    let mut total: i64 = 0;
    for back in 1..=i32::try_from(AVERAGE_MONTHS).unwrap_or(6) {
        if let Some(earlier) = civil::add_months(month, -back) {
            total += spent
                .spent_under(&earlier, currency, category, categories)
                .max(0);
        }
    }
    let months = i64::try_from(AVERAGE_MONTHS).unwrap_or(6);
    let average = (total * 2 + months) / (2 * months);
    let this_spent = spent
        .spent_under(month, currency, category, categories)
        .max(0);
    let planned_now = find_target(targets, month, category)
        .and_then(|_| {
            planned(
                targets,
                spent,
                categories,
                month,
                category,
                TargetMode::Tracking,
                0,
            )
        })
        .map_or(amount_minor, |(p, _)| p);
    let unused = if carry {
        (planned_now - this_spent).max(0)
    } else {
        0
    };
    TargetSheet {
        six_month_average_minor: average,
        next_month_preview_minor: amount_minor + unused,
    }
}

// ---------------------------------------------------------------------------
// Transfer proposals (moved from Tally's `matches`, R-1099-38).
// ---------------------------------------------------------------------------

/// How far apart two postings of one movement may sit, in whole days.
pub const MATCH_WINDOW_DAYS: i64 = 4;

/// A proposal that two rows are the two halves of one movement of the
/// member's own money. It is written by nobody until the member accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferProposal {
    /// The row that left an account.
    pub debit_txn_id: String,
    /// The row that arrived in another.
    pub credit_txn_id: String,
    pub amount_minor: i64,
    pub currency: String,
    pub debit_account_id: String,
    pub credit_account_id: String,
    pub debit_posted_on: String,
    pub credit_posted_on: String,
    pub debit_description: String,
    pub credit_description: String,
    pub days_apart: i64,
}

fn pair_key(left: &str, right: &str) -> String {
    if left < right {
        format!("{left}|{right}")
    } else {
        format!("{right}|{left}")
    }
}

/// The debits and the credits of one `(currency, amount)`.
type Bucket<'a> = (Vec<&'a TxnRow>, Vec<&'a TxnRow>);

/// Pairs rows that are the same money in opposite directions on different
/// accounts within [`MATCH_WINDOW_DAYS`]. A void row, a row already linked and
/// a pair already decided are never offered. The nearest evidence first.
#[must_use]
pub fn transfer_proposals(
    rows: &[TxnRow],
    linked: &BTreeSet<String>,
    decided: &BTreeSet<(String, String)>,
) -> Vec<TransferProposal> {
    let decided: BTreeSet<String> = decided.iter().map(|(a, b)| pair_key(a, b)).collect();
    let mut buckets: BTreeMap<(String, i64), Bucket<'_>> = BTreeMap::new();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for row in rows {
        if row.is_void() || linked.contains(&row.txn_id) || !seen.insert(&row.txn_id) {
            continue;
        }
        let bucket = buckets
            .entry((row.currency.clone(), row.amount_minor))
            .or_default();
        match row.direction {
            Direction::Debit => bucket.0.push(row),
            Direction::Credit => bucket.1.push(row),
        }
    }
    let mut proposals: Vec<(i64, TransferProposal)> = Vec::new();
    for ((currency, amount), (debits, credits)) in &buckets {
        for debit in debits {
            for credit in credits {
                if debit.account_id == credit.account_id
                    || decided.contains(&pair_key(&debit.txn_id, &credit.txn_id))
                {
                    continue;
                }
                let (Some(a), Some(b)) = (
                    civil::day_number_of(&debit.posted_on),
                    civil::day_number_of(&credit.posted_on),
                ) else {
                    continue;
                };
                let apart = (a - b).abs();
                if apart > MATCH_WINDOW_DAYS {
                    continue;
                }
                proposals.push((
                    apart,
                    TransferProposal {
                        debit_txn_id: debit.txn_id.clone(),
                        credit_txn_id: credit.txn_id.clone(),
                        amount_minor: *amount,
                        currency: currency.clone(),
                        debit_account_id: debit.account_id.clone(),
                        credit_account_id: credit.account_id.clone(),
                        debit_posted_on: debit.posted_on.clone(),
                        credit_posted_on: credit.posted_on.clone(),
                        debit_description: debit.description.clone(),
                        credit_description: credit.description.clone(),
                        days_apart: apart,
                    },
                ));
            }
        }
    }
    proposals.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.1.debit_posted_on.cmp(&a.1.debit_posted_on))
            .then_with(|| a.1.debit_txn_id.cmp(&b.1.debit_txn_id))
            .then_with(|| a.1.credit_txn_id.cmp(&b.1.credit_txn_id))
    });
    proposals.into_iter().map(|(_, p)| p).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_is_tracking() {
        assert_eq!(TargetMode::default(), TargetMode::Tracking);
    }

    #[test]
    fn ratios_round_half_away_from_zero_and_a_zero_denominator_is_none() {
        assert_eq!(ratio_bp(1, 3), Some(3333));
        assert_eq!(ratio_bp(2, 3), Some(6667));
        assert_eq!(ratio_bp(-1, 3), Some(-3333));
        assert_eq!(ratio_bp(5, 0), None);
        assert_eq!(ratio_bp(1, 20_000), Some(1)); // 0.5 bp rounds up
    }
}
