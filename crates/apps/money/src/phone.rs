//! THE PHONE'S READINGS OF THE LEDGER (#1099, wave 3) — typed, for the protos
//! wave 4 converts them to.
//!
//! Each public function answers one screen as Rust structs over the same reads
//! ([`crate::queries`]) and the same folds ([`crate::engine`],
//! [`crate::recurring`]). Every figure is a [`Money`] — never a bare integer —
//! so the core can state each one's exponent, and **nothing adds across
//! currencies**: a figure that exists per currency is a list with one entry per
//! currency. There is no clock and no zone here: `today` and the month are the
//! core's, passed in as `YYYY-MM-DD` and `YYYY-MM`.
//!
//! | Answer | Screen |
//! | --- | --- |
//! | [`MoneySpending`] | Spending (root) |
//! | [`MoneyActivity`] | Activity (root) |
//! | [`MoneyCashflow`] | Cash flow (root) |
//! | [`MoneyTransaction`] | one transaction |
//! | [`MoneyAccounts`] | More ▸ Accounts |
//! | [`MoneyRules`] | More ▸ Rules |
//! | [`MoneyCategories`] | More ▸ Categories |
//! | [`MoneyTargetSheet`] | the target sheet |
//! | [`MoneyRecurring`] | recurring charges |
//! | [`MoneyHomeTile`] | Home's tile |
//! | [`MoneyImportPlan`] | the plan an import shows before it writes |
//! | [`MoneySearch`] | search |

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::money::{Money, money};
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::PageDoor;

use crate::civil;
use crate::engine::{
    self, AccountBalance, Context, FlowMonth, SheetInput, SpentIndex, TargetMode, TargetStatus,
    TransferProposal,
};
use crate::import::{ImportPlan, RejectReason, RowVerdict, SavedProfile, Warning, plan::PlanRow};
use crate::queries::{
    self, AccountRow, ActivityFilter, CASHFLOW_MONTHS, CategoryRow, CheckpointRow, TargetRow,
    TransferLink, TxnRow,
};
use crate::recurring::{self, Cadence, RECURRING_MONTHS, Series, Status};
use crate::rules::{self, Categorised, MatchKind, Rule, RuleProposal};

// ---------------------------------------------------------------------------
// What every answer reads.
// ---------------------------------------------------------------------------

/// The small tables every screen needs, read once.
#[derive(Debug, Clone)]
pub struct MoneyData {
    pub accounts: Vec<AccountRow>,
    pub categories: Vec<CategoryRow>,
    pub rules: Vec<Rule>,
    pub checkpoints: Vec<CheckpointRow>,
    pub links: Vec<TransferLink>,
    /// Both ends of every live transfer link.
    pub linked: BTreeSet<String>,
    /// A table was longer than its ceiling: a screen says what it did not read.
    pub truncated: bool,
}

impl MoneyData {
    /// Reads the accounts, categories, rules, checkpoints and links.
    pub fn load(door: &dyn PageDoor) -> KitResult<Self> {
        let accounts = queries::load_accounts(door)?;
        let categories = queries::load_categories(door)?;
        let rules = queries::load_rules(door)?;
        let checkpoints = queries::load_checkpoints(door)?;
        let links = queries::load_transfer_links(door)?;
        Ok(Self {
            linked: links
                .value
                .iter()
                .flat_map(|l| [l.from_txn.clone(), l.to_txn.clone()])
                .collect(),
            truncated: rules.truncated || checkpoints.truncated || links.truncated,
            accounts,
            categories,
            rules: rules.value,
            checkpoints: checkpoints.value,
            links: links.value,
        })
    }

    #[must_use]
    pub fn context<'a>(&'a self, today: &'a str) -> Context<'a> {
        Context {
            accounts: &self.accounts,
            categories: &self.categories,
            linked: &self.linked,
            today,
        }
    }

    fn account(&self, id: &str) -> Option<&AccountRow> {
        self.accounts.iter().find(|a| a.account_id == id)
    }

    fn account_name(&self, id: &str) -> String {
        self.account(id).map(|a| a.name.clone()).unwrap_or_default()
    }

    fn category(&self, id: &str) -> Option<&CategoryRow> {
        self.categories.iter().find(|c| c.concept_id == id)
    }

    fn label(&self, id: &str) -> String {
        self.category(id)
            .map(|c| c.label.clone())
            .unwrap_or_default()
    }

    fn group_label(&self, id: &str) -> Option<String> {
        let parent = self.category(id)?.parent.as_deref()?;
        Some(self.label(parent))
    }
}

/// The keys of the definitions a screen prints under its figures. The copy for
/// each lives with the shell; the wording is in [`crate::engine`]'s docs.
pub mod definitions {
    pub const SPENDING: &str = "money.def.spending";
    pub const REFUND_CREDIT: &str = "money.def.refund_credit";
    pub const IN_OUT_NET: &str = "money.def.in_out_net";
    pub const SAVINGS_RATE: &str = "money.def.savings_rate";
    pub const BALANCE: &str = "money.def.balance";
    pub const CHECKPOINT: &str = "money.def.checkpoint";
    pub const PLANNED: &str = "money.def.planned";
    pub const FORECAST: &str = "money.def.forecast";
    pub const RECURRING: &str = "money.def.recurring";
    pub const TRANSFER: &str = "money.def.transfer";
}

/// A transaction's flags, as a row of Activity shows them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Flag {
    Transfer,
    Void,
    Uncategorised,
    Future,
}

fn signed(row: &TxnRow) -> Money {
    money(row.signed_minor(), &row.currency)
}

fn flags_of(row: &TxnRow, data: &MoneyData, today: &str) -> Vec<Flag> {
    let mut flags = Vec::new();
    if data.linked.contains(&row.txn_id) {
        flags.push(Flag::Transfer);
    }
    if row.is_void() {
        flags.push(Flag::Void);
    } else if row.category_concept_id.is_none() && !flags.contains(&Flag::Transfer) {
        flags.push(Flag::Uncategorised);
    }
    if row.posted_on.as_str() > today {
        flags.push(Flag::Future);
    }
    flags
}

// ---------------------------------------------------------------------------
// Spending.
// ---------------------------------------------------------------------------

/// The lookback's rows split into its `count` month windows, oldest first, the
/// last being `through`.
fn windows_of(rows: &[TxnRow], through: &str, count: usize) -> Vec<(String, Vec<TxnRow>)> {
    (0..count)
        .rev()
        .filter_map(|back| civil::add_months(through, -i32::try_from(back).unwrap_or(0)))
        .map(|month| {
            let in_month = rows
                .iter()
                .filter(|r| civil::month_of(&r.posted_on) == month)
                .cloned()
                .collect();
            (month, in_month)
        })
        .collect()
}

/// One currency's hero on the Spending screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendingCurrency {
    pub spent: Money,
    /// The month's plan, if any target is set in this currency.
    pub planned: Option<Money>,
    pub left: Option<Money>,
    /// Spent over planned, basis points.
    pub progress_bp: Option<i64>,
    pub refund_credit: Money,
}

/// One category line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendingCategory {
    pub currency: String,
    pub category_id: String,
    pub label: String,
    pub group: Option<String>,
    pub planned: Option<Money>,
    pub carry_in: Money,
    pub spent: Money,
    pub left: Option<Money>,
    pub over: bool,
    pub refund_credit: Money,
}

/// Rows with no category, per currency.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Uncategorised {
    pub count: usize,
    pub amount: Money,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InOutNet {
    pub incoming: Money,
    pub outgoing: Money,
    pub net: Money,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Excluded {
    pub count: usize,
    pub amount: Money,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForecastLine {
    pub spent_so_far: Money,
    pub expected: Money,
    pub month_end: Money,
}

/// When and from where the newest import came.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastImportLine {
    pub imported_at: String,
    pub source: String,
    pub account_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneySpending {
    pub month: String,
    pub day_of_month: u32,
    pub days_in_month: u32,
    pub days_left: u32,
    pub per_currency: Vec<SpendingCurrency>,
    pub categories: Vec<SpendingCategory>,
    pub uncategorised: Vec<Uncategorised>,
    pub in_out_net: Vec<InOutNet>,
    pub transfers_excluded: Vec<Excluded>,
    pub future_excluded: Vec<Excluded>,
    pub forecast: Vec<ForecastLine>,
    pub definitions: Vec<&'static str>,
    /// Day one: no account, or no transaction yet. The screen offers Import.
    pub empty: bool,
    pub last_import: Option<LastImportLine>,
    /// A month window held more than the ceiling: the figures are over a window.
    pub truncated: bool,
}

/// The Spending screen for `month` (today decides how much of it is "so far").
pub fn spending(door: &dyn PageDoor, month: &str, today: &str) -> KitResult<MoneySpending> {
    let data = MoneyData::load(door)?;
    // One read of the thirteen windows serves the month, the carry chain and
    // the recurring detector; none of them needs a member's name or memo.
    let lookback = queries::load_lookback(door, month, RECURRING_MONTHS)?;
    let windows = windows_of(&lookback.value, month, RECURRING_MONTHS);
    let window = queries::Bounded {
        value: windows
            .last()
            .map(|(_, rows)| rows.clone())
            .unwrap_or_default(),
        truncated: lookback.truncated,
    };
    let ctx = data.context(today);
    let folded = engine::spending(&window.value, month, &ctx);
    // The plan: this month's targets and what the previous months left.
    let from = civil::add_months(month, -i32::try_from(engine::CARRY_MONTHS).unwrap_or(12))
        .unwrap_or_else(|| month.to_owned());
    let targets = queries::load_targets(door, &from, month)?;
    let spent_index = SpentIndex::from_windows(&windows, &ctx);
    let mut statuses: BTreeMap<String, TargetStatus> = BTreeMap::new();
    for target in targets.value.iter().filter(|t| t.month == month) {
        if let Some(status) = engine::target_status(
            &targets.value,
            &spent_index,
            &data.categories,
            month,
            &target.category_concept_id,
            TargetMode::default(),
        ) {
            statuses.insert(target.category_concept_id.clone(), status);
        }
    }
    let mut categories = Vec::new();
    for entry in &folded {
        for line in &entry.lines {
            let Some(id) = &line.category_id else {
                continue;
            };
            let status = statuses.get(id);
            categories.push(SpendingCategory {
                currency: entry.currency.clone(),
                label: data.label(id),
                group: data.group_label(id),
                planned: status.map(|s| money(s.planned_minor, &s.currency)),
                carry_in: money(status.map_or(0, |s| s.carry_in_minor), &entry.currency),
                spent: money(line.spent_minor, &entry.currency),
                left: status.map(|s| money(s.left_minor, &s.currency)),
                over: status.is_some_and(|s| s.over),
                refund_credit: money(line.refund_credit_minor, &entry.currency),
                category_id: id.clone(),
            });
        }
    }
    // A target on a category nothing was spent in is still a line (a group's
    // target too): the plan is on screen even before the money moves.
    for (id, status) in &statuses {
        if categories
            .iter()
            .any(|c| &c.category_id == id && c.currency == status.currency)
        {
            continue;
        }
        let spent = spent_index
            .spent_under(month, &status.currency, id, &data.categories)
            .max(0);
        categories.push(SpendingCategory {
            currency: status.currency.clone(),
            label: data.label(id),
            group: data.group_label(id),
            planned: Some(money(status.planned_minor, &status.currency)),
            carry_in: money(status.carry_in_minor, &status.currency),
            spent: money(spent, &status.currency),
            left: Some(money(status.left_minor, &status.currency)),
            over: status.over,
            refund_credit: money(0, &status.currency),
            category_id: id.clone(),
        });
    }
    categories.sort_by(|a, b| {
        (
            &a.currency,
            std::cmp::Reverse(a.spent.amount_minor),
            &a.label,
        )
            .cmp(&(
                &b.currency,
                std::cmp::Reverse(b.spent.amount_minor),
                &b.label,
            ))
    });
    // The hero: planned is the sum of the top-most targets (a group's target
    // stands for its categories), so a group and its children are not counted
    // twice.
    let top_most = |status: &&TargetStatus| {
        data.category(&status.category_id)
            .and_then(|c| c.parent.as_deref())
            .is_none_or(|parent| !statuses.contains_key(parent))
    };
    let per_currency = folded
        .iter()
        .map(|entry| {
            let planned: Option<i64> = {
                let mut any = false;
                let total = statuses
                    .values()
                    .filter(|s| s.currency == entry.currency)
                    .filter(top_most)
                    .map(|s| {
                        any = true;
                        s.planned_minor
                    })
                    .sum::<i64>();
                any.then_some(total)
            };
            SpendingCurrency {
                spent: money(entry.spent_minor, &entry.currency),
                planned: planned.map(|p| money(p, &entry.currency)),
                left: planned.map(|p| money(p - entry.spent_minor, &entry.currency)),
                progress_bp: planned.and_then(|p| engine::ratio_bp(entry.spent_minor, p)),
                refund_credit: money(entry.refund_credit_minor, &entry.currency),
            }
        })
        .collect();
    let uncategorised = folded
        .iter()
        .filter_map(|entry| {
            let line = entry.lines.iter().find(|l| l.category_id.is_none())?;
            Some(Uncategorised {
                count: line.rows,
                amount: money(line.spent_minor, &entry.currency),
            })
        })
        .collect();
    let spent_so_far: BTreeMap<String, i64> = folded
        .iter()
        .map(|e| (e.currency.clone(), e.spent_minor))
        .collect();
    let series = recurring::detect(&lookback.value, &data.linked, today);
    let is_income = |c: &str| ctx.is_income(c);
    let forecast = if civil::month_of(today) == month {
        recurring::forecast(&spent_so_far, &series, month, today, &is_income)
            .into_iter()
            .map(|f| ForecastLine {
                spent_so_far: money(f.spent_so_far_minor, &f.currency),
                expected: money(f.expected_minor, &f.currency),
                month_end: money(f.month_end_minor, &f.currency),
            })
            .collect()
    } else {
        Vec::new()
    };
    let last_import = queries::load_last_import(door)?.map(|last| LastImportLine {
        account_name: last.account_id.as_deref().map(|id| data.account_name(id)),
        imported_at: last.imported_at,
        source: last.source,
    });
    let day_of_month = if civil::month_of(today) == month {
        civil::day_of_month(today).unwrap_or(0)
    } else if today > month {
        civil::month_length(month)
    } else {
        0
    };
    let days_in_month = civil::month_length(month);
    Ok(MoneySpending {
        month: month.to_owned(),
        day_of_month,
        days_in_month,
        days_left: days_in_month.saturating_sub(day_of_month),
        per_currency,
        categories,
        uncategorised,
        in_out_net: folded
            .iter()
            .map(|e| InOutNet {
                incoming: money(e.in_minor, &e.currency),
                outgoing: money(e.out_minor, &e.currency),
                net: money(e.net_minor(), &e.currency),
            })
            .collect(),
        transfers_excluded: folded
            .iter()
            .filter(|e| e.transfers_excluded_count > 0)
            .map(|e| Excluded {
                count: e.transfers_excluded_count,
                amount: money(e.transfers_excluded_minor, &e.currency),
            })
            .collect(),
        future_excluded: folded
            .iter()
            .filter(|e| e.future_count > 0)
            .map(|e| Excluded {
                count: e.future_count,
                amount: money(e.future_minor, &e.currency),
            })
            .collect(),
        forecast,
        definitions: vec![
            definitions::SPENDING,
            definitions::REFUND_CREDIT,
            definitions::IN_OUT_NET,
            definitions::PLANNED,
            definitions::FORECAST,
            definitions::TRANSFER,
        ],
        empty: data.accounts.is_empty() || last_import.is_none() && window.value.is_empty(),
        last_import,
        truncated: window.truncated || targets.truncated || data.truncated,
    })
}

// ---------------------------------------------------------------------------
// Activity.
// ---------------------------------------------------------------------------

/// One row of Activity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityRow {
    pub txn_id: String,
    pub posted_on: String,
    /// The member's name for it, else the bank's words.
    pub display_name: String,
    /// The bank's words, exactly.
    pub raw: String,
    /// Signed: negative is money out.
    pub amount: Money,
    pub account_id: String,
    pub account_label: String,
    pub category_id: Option<String>,
    pub category_label: Option<String>,
    pub flags: Vec<Flag>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeedsCategory {
    pub count: usize,
    pub amount: Money,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyActivity {
    pub month: String,
    pub rows: Vec<ActivityRow>,
    /// Rows still needing a category this month (any account, per currency).
    pub needs_category: Vec<NeedsCategory>,
    /// The cursor of the next page `(sort key, pk)`.
    pub cursor: Option<(String, String)>,
    /// The month's own count is over the window the needs-category count reads.
    pub truncated: bool,
}

fn activity_row(row: &TxnRow, data: &MoneyData, today: &str) -> ActivityRow {
    ActivityRow {
        txn_id: row.txn_id.clone(),
        posted_on: row.posted_on.clone(),
        display_name: row.name().to_owned(),
        raw: row.description.clone(),
        amount: signed(row),
        account_id: row.account_id.clone(),
        account_label: data.account_name(&row.account_id),
        category_id: row.category_concept_id.clone(),
        category_label: row.category_concept_id.as_deref().map(|id| data.label(id)),
        flags: flags_of(row, data, today),
    }
}

/// One page of a month's Activity, filtered.
pub fn activity(
    door: &dyn PageDoor,
    month: &str,
    filter: &ActivityFilter,
    request: &PageRequest,
    today: &str,
) -> KitResult<MoneyActivity> {
    let data = MoneyData::load(door)?;
    let page = queries::load_activity_page(door, month, filter, request)?;
    let needing = queries::load_month_plain(
        door,
        month,
        &ActivityFilter {
            account_id: filter.account_id.clone(),
            category: queries::CategoryFilter::Uncategorised,
        },
    )?;
    let mut per: BTreeMap<String, (usize, i64)> = BTreeMap::new();
    for row in needing
        .value
        .iter()
        .filter(|r| !data.linked.contains(&r.txn_id))
    {
        let slot = per.entry(row.currency.clone()).or_default();
        slot.0 += 1;
        slot.1 += row.amount_minor;
    }
    Ok(MoneyActivity {
        month: month.to_owned(),
        rows: page
            .rows
            .iter()
            .map(|r| activity_row(r, &data, today))
            .collect(),
        needs_category: per
            .into_iter()
            .map(|(currency, (count, amount))| NeedsCategory {
                count,
                amount: money(amount, &currency),
            })
            .collect(),
        cursor: page.next,
        truncated: needing.truncated,
    })
}

// ---------------------------------------------------------------------------
// One transaction.
// ---------------------------------------------------------------------------

/// A transfer the app proposes for a transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferOffer {
    pub other_txn_id: String,
    pub other_account_label: String,
    pub other_description: String,
    pub other_posted_on: String,
    pub days_apart: i64,
}

/// The counting learner's offer, in the member's words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleOffer {
    pub kind: MatchKind,
    pub pattern: String,
    pub category_id: String,
    pub category_label: String,
    pub support: usize,
    pub of: usize,
}

/// The series a transaction belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecurringNote {
    pub cadence: Cadence,
    pub next_due: Option<String>,
    pub amount: Money,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyTransaction {
    pub txn_id: String,
    pub posted_on: String,
    pub display_name: String,
    pub display_name_source: Option<String>,
    pub raw: String,
    pub amount: Money,
    pub account_id: String,
    pub account_label: String,
    pub category_id: Option<String>,
    pub category_label: Option<String>,
    pub memo: Option<String>,
    pub check_number: Option<String>,
    pub bank_type: Option<String>,
    pub imported_from: Option<String>,
    pub flags: Vec<Flag>,
    pub transfer_proposal: Option<TransferOffer>,
    /// The transaction this one is linked to as a transfer, if any.
    pub transferred_with: Option<String>,
    pub rule_proposal: Option<RuleOffer>,
    /// The rules that would name and file it today.
    pub applied_rule_ids: Vec<String>,
    pub seen_times: usize,
    pub recurring: Option<RecurringNote>,
}

fn offer_of(rule: RuleProposal, data: &MoneyData) -> RuleOffer {
    RuleOffer {
        kind: rule.kind,
        pattern: rule.pattern,
        category_label: data.label(&rule.category_concept_id),
        category_id: rule.category_concept_id,
        support: rule.support,
        of: rule.of,
    }
}

/// One transaction and everything the app derives about it, or none.
pub fn transaction(
    door: &dyn PageDoor,
    txn_id: &str,
    today: &str,
) -> KitResult<Option<MoneyTransaction>> {
    let Some(row) = queries::load_transaction(door, txn_id)? else {
        return Ok(None);
    };
    let data = MoneyData::load(door)?;
    let month = civil::month_of(today);
    let lookback = queries::load_lookback(door, month, RECURRING_MONTHS)?;
    let candidates = queries::load_transfer_candidates(door, &data.accounts)?;
    let proposals = engine::transfer_proposals(&candidates, &data.linked, &BTreeSet::new());
    let transfer_proposal = proposals
        .iter()
        .find(|p| p.debit_txn_id == row.txn_id || p.credit_txn_id == row.txn_id)
        .map(|p: &TransferProposal| {
            let debit_side = p.debit_txn_id == row.txn_id;
            TransferOffer {
                other_txn_id: if debit_side {
                    &p.credit_txn_id
                } else {
                    &p.debit_txn_id
                }
                .clone(),
                other_account_label: data.account_name(if debit_side {
                    &p.credit_account_id
                } else {
                    &p.debit_account_id
                }),
                other_description: if debit_side {
                    &p.credit_description
                } else {
                    &p.debit_description
                }
                .clone(),
                other_posted_on: if debit_side {
                    &p.credit_posted_on
                } else {
                    &p.debit_posted_on
                }
                .clone(),
                days_apart: p.days_apart,
            }
        });
    let transferred_with = data.links.iter().find_map(|l| {
        if l.from_txn == row.txn_id {
            Some(l.to_txn.clone())
        } else if l.to_txn == row.txn_id {
            Some(l.from_txn.clone())
        } else {
            None
        }
    });
    let applied = rules::apply(
        &data.rules,
        &rules::Candidate {
            description: &row.description,
            amount_minor: row.amount_minor,
            account_id: &row.account_id,
        },
    );
    // The learner counts the merchant's categorised rows in the lookback.
    let history: Vec<Categorised> = lookback
        .value
        .iter()
        .filter(|r| !r.is_void() && r.category_concept_id.is_some())
        .map(|r| Categorised {
            txn_id: r.txn_id.clone(),
            description: r.description.clone(),
            posted_on: r.posted_on.clone(),
            category_concept_id: r.category_concept_id.clone(),
        })
        .collect();
    let rule_proposal = row.category_concept_id.as_ref().and_then(|_| {
        let just = Categorised {
            txn_id: row.txn_id.clone(),
            description: row.description.clone(),
            posted_on: row.posted_on.clone(),
            category_concept_id: row.category_concept_id.clone(),
        };
        rules::propose_rule(
            &data.rules,
            &row.account_id,
            &history,
            &just,
            row.amount_minor,
        )
        .map(|p| offer_of(p, &data))
    });
    let series = recurring::detect(&lookback.value, &data.linked, today);
    let key = rules::merchant_key(&row.description);
    let recurring_note = series
        .iter()
        .find(|s| s.account_id == row.account_id && s.merchant_key == key)
        .map(|s| RecurringNote {
            cadence: s.cadence,
            next_due: s.next_due(today),
            amount: money(s.median_amount_minor, &s.currency),
        });
    Ok(Some(MoneyTransaction {
        flags: flags_of(&row, &data, today),
        account_label: data.account_name(&row.account_id),
        category_label: row.category_concept_id.as_deref().map(|id| data.label(id)),
        seen_times: recurring::seen_times(&lookback.value, &row.description),
        txn_id: row.txn_id.clone(),
        posted_on: row.posted_on.clone(),
        display_name: row.name().to_owned(),
        display_name_source: row.display_name_source.clone(),
        raw: row.description.clone(),
        amount: signed(&row),
        account_id: row.account_id.clone(),
        category_id: row.category_concept_id.clone(),
        memo: row.memo.clone(),
        check_number: row.check_number.clone(),
        bank_type: row.bank_type.clone(),
        imported_from: row.imported_from.clone(),
        transfer_proposal,
        transferred_with,
        rule_proposal,
        applied_rule_ids: applied.rule_ids,
        recurring: recurring_note,
    }))
}

// ---------------------------------------------------------------------------
// Cash flow.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CashflowMonth {
    pub month: String,
    pub incoming: Money,
    pub outgoing: Money,
    pub net: Money,
    pub savings_rate_bp: Option<i64>,
    pub partial: bool,
}

/// One currency's twelve months.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CashflowSeries {
    pub currency: String,
    pub months: Vec<CashflowMonth>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyCashflow {
    pub through: String,
    pub series: Vec<CashflowSeries>,
    pub definitions: Vec<&'static str>,
    pub truncated: bool,
}

fn flow_month(currency: &str, m: &FlowMonth) -> CashflowMonth {
    CashflowMonth {
        month: m.month.clone(),
        incoming: money(m.in_minor, currency),
        outgoing: money(m.out_minor, currency),
        net: money(m.net_minor, currency),
        savings_rate_bp: m.savings_rate_bp,
        partial: m.partial,
    }
}

/// The twelve months ending at `through`.
pub fn cashflow(door: &dyn PageDoor, through: &str, today: &str) -> KitResult<MoneyCashflow> {
    let data = MoneyData::load(door)?;
    let mut windows = Vec::new();
    let mut truncated = data.truncated;
    for back in (0..CASHFLOW_MONTHS).rev() {
        if let Some(month) = civil::add_months(through, -i32::try_from(back).unwrap_or(0)) {
            let rows = queries::load_month_plain(door, &month, &ActivityFilter::default())?;
            truncated |= rows.truncated;
            windows.push((month, rows.value));
        }
    }
    let ctx = data.context(today);
    Ok(MoneyCashflow {
        through: through.to_owned(),
        series: engine::cashflow(&windows, &ctx)
            .into_iter()
            .map(|(currency, months)| CashflowSeries {
                months: months.iter().map(|m| flow_month(&currency, m)).collect(),
                currency,
            })
            .collect(),
        definitions: vec![definitions::IN_OUT_NET, definitions::SAVINGS_RATE],
        truncated,
    })
}

// ---------------------------------------------------------------------------
// Accounts.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointLine {
    pub as_of: String,
    pub stated: Money,
    pub delta: Money,
    pub agrees: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountLine {
    pub account_id: String,
    pub name: String,
    /// The last digits the member entered, if any.
    pub mask: Option<String>,
    pub kind: String,
    pub currency: String,
    /// `None` when the ledger was too long to derive it.
    pub balance: Option<Money>,
    pub checkpoint: Option<CheckpointLine>,
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetWorthLine {
    pub amount: Money,
    /// False when an account's balance could not be derived.
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyAccounts {
    pub on_budget: Vec<AccountLine>,
    pub off_budget: Vec<AccountLine>,
    pub net_worth: Vec<NetWorthLine>,
    pub definitions: Vec<&'static str>,
}

/// The Accounts screen.
pub fn accounts(door: &dyn PageDoor, today: &str) -> KitResult<MoneyAccounts> {
    let data = MoneyData::load(door)?;
    let mut balances: Vec<AccountBalance> = Vec::new();
    for account in &data.accounts {
        let ledger = queries::load_ledger(door, &account.account_id)?;
        let rows = (!ledger.truncated).then_some(ledger.value.as_slice());
        balances.push(engine::account_balance(
            account,
            rows,
            &data.checkpoints,
            today,
        ));
    }
    let line = |account: &AccountRow| -> AccountLine {
        let balance = balances.iter().find(|b| b.account_id == account.account_id);
        AccountLine {
            account_id: account.account_id.clone(),
            name: account.name.clone(),
            mask: account.external_ref.as_deref().map(|r| {
                r.chars()
                    .rev()
                    .take(4)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect()
            }),
            kind: account.kind.clone(),
            currency: account.currency.clone(),
            balance: balance
                .and_then(|b| b.balance_minor)
                .map(|m| money(m, &account.currency)),
            checkpoint: balance
                .and_then(|b| b.checkpoint.as_ref())
                .map(|c| CheckpointLine {
                    as_of: c.as_of.clone(),
                    stated: money(c.stated_minor, &account.currency),
                    delta: money(c.delta_minor, &account.currency),
                    agrees: c.agrees,
                }),
            closed: account.closed_on.as_deref().is_some_and(|d| d <= today),
        }
    };
    Ok(MoneyAccounts {
        on_budget: data
            .accounts
            .iter()
            .filter(|a| a.on_budget)
            .map(&line)
            .collect(),
        off_budget: data
            .accounts
            .iter()
            .filter(|a| !a.on_budget)
            .map(&line)
            .collect(),
        net_worth: engine::net_worth(&balances, &data.accounts, today)
            .into_iter()
            .map(|(currency, (amount, complete))| NetWorthLine {
                amount: money(amount, &currency),
                complete,
            })
            .collect(),
        definitions: vec![definitions::BALANCE, definitions::CHECKPOINT],
    })
}

// ---------------------------------------------------------------------------
// Rules and categories.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleLine {
    pub rule_id: String,
    pub kind: MatchKind,
    pub pattern: String,
    pub amount_min: Option<i64>,
    pub amount_max: Option<i64>,
    pub account_label: Option<String>,
    pub category_label: Option<String>,
    pub specificity: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyRules {
    pub rules: Vec<RuleLine>,
    pub limit: usize,
    pub truncated: bool,
}

/// The Rules screen, in application order.
pub fn rules(door: &dyn PageDoor) -> KitResult<MoneyRules> {
    let data = MoneyData::load(door)?;
    Ok(MoneyRules {
        rules: data
            .rules
            .iter()
            .map(|rule| RuleLine {
                rule_id: rule.rule_id.clone(),
                kind: rule.kind,
                pattern: rule.pattern.clone(),
                amount_min: rule.amount_min_minor,
                amount_max: rule.amount_max_minor,
                account_label: rule.account_id.as_deref().map(|id| data.account_name(id)),
                category_label: rule.category_concept_id.as_deref().map(|id| data.label(id)),
                specificity: rules::specificity(rule),
            })
            .collect(),
        limit: rules::RULES,
        truncated: data.truncated,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryLine {
    pub category_id: String,
    pub label: String,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryGroup {
    pub group_id: String,
    pub label: String,
    pub categories: Vec<CategoryLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyCategories {
    pub groups: Vec<CategoryGroup>,
}

/// The Categories screen: groups, then their categories.
pub fn categories(door: &dyn PageDoor) -> KitResult<MoneyCategories> {
    let all = queries::load_categories(door)?;
    let mut groups: Vec<CategoryGroup> = all
        .iter()
        .filter(|c| c.parent.is_none())
        .map(|g| CategoryGroup {
            group_id: g.concept_id.clone(),
            label: g.label.clone(),
            categories: all
                .iter()
                .filter(|c| c.parent.as_deref() == Some(g.concept_id.as_str()))
                .map(|c| CategoryLine {
                    category_id: c.concept_id.clone(),
                    label: c.label.clone(),
                    archived: c.archived,
                })
                .collect(),
        })
        .collect();
    groups.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(MoneyCategories { groups })
}

// ---------------------------------------------------------------------------
// The target sheet.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyTargetSheet {
    pub category_id: String,
    pub category_label: String,
    pub month: String,
    pub currency: String,
    /// The amount planned now, if a target is set.
    pub amount: Option<Money>,
    pub carry: bool,
    pub carry_in: Money,
    pub spent: Money,
    pub six_month_average: Money,
    pub next_month_preview: Money,
}

/// The sheet for `category` in `month`. `typing` is the amount and carry the
/// member is entering; absent, the stored target's own.
pub fn target_sheet(
    door: &dyn PageDoor,
    month: &str,
    category: &str,
    currency: &str,
    typing: Option<(i64, bool)>,
    today: &str,
) -> KitResult<MoneyTargetSheet> {
    let data = MoneyData::load(door)?;
    let ctx = data.context(today);
    let lookback = queries::load_lookback(door, month, engine::CARRY_MONTHS + 1)?;
    let windows = windows_of(&lookback.value, month, engine::CARRY_MONTHS + 1);
    let spent = SpentIndex::from_windows(&windows, &ctx);
    let from = civil::add_months(month, -i32::try_from(engine::CARRY_MONTHS).unwrap_or(12))
        .unwrap_or_else(|| month.to_owned());
    let targets: Vec<TargetRow> = queries::load_targets(door, &from, month)?.value;
    let stored = engine::target_status(
        &targets,
        &spent,
        &data.categories,
        month,
        category,
        TargetMode::default(),
    );
    let (amount, carry) = typing.unwrap_or_else(|| {
        stored
            .as_ref()
            .map_or((0, false), |s| (s.amount_minor, s.carry))
    });
    let sheet = engine::target_sheet(
        &targets,
        &spent,
        &data.categories,
        &SheetInput {
            month,
            category,
            currency,
            amount_minor: amount,
            carry,
        },
    );
    Ok(MoneyTargetSheet {
        category_id: category.to_owned(),
        category_label: data.label(category),
        month: month.to_owned(),
        currency: currency.to_owned(),
        amount: stored.as_ref().map(|s| money(s.amount_minor, currency)),
        carry,
        carry_in: money(stored.as_ref().map_or(0, |s| s.carry_in_minor), currency),
        spent: money(
            spent
                .spent_under(month, currency, category, &data.categories)
                .max(0),
            currency,
        ),
        six_month_average: money(sheet.six_month_average_minor, currency),
        next_month_preview: money(sheet.next_month_preview_minor, currency),
    })
}

// ---------------------------------------------------------------------------
// Recurring.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecurringLine {
    pub merchant: String,
    pub account_label: String,
    pub cadence: Cadence,
    pub cadence_words: &'static str,
    pub amount: Money,
    pub next_due: Option<String>,
    /// The status of the nearest expected date (this month's, or the next).
    pub status: Status,
    pub seen_times: usize,
    pub category_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyRecurring {
    pub series: Vec<RecurringLine>,
    pub definitions: Vec<&'static str>,
    pub truncated: bool,
}

/// The recurring charges detected in the lookback ending at today's month.
pub fn recurring_screen(door: &dyn PageDoor, today: &str) -> KitResult<MoneyRecurring> {
    let data = MoneyData::load(door)?;
    let lookback = queries::load_lookback(door, civil::month_of(today), RECURRING_MONTHS)?;
    let series: Vec<Series> = recurring::detect(&lookback.value, &data.linked, today);
    let lines = series
        .iter()
        .map(|s| {
            let from = civil::shift(today, -45).unwrap_or_else(|| today.to_owned());
            let to = civil::shift(today, 400).unwrap_or_else(|| today.to_owned());
            let projected = s.project(&from, &to, today);
            let nearest = projected
                .iter()
                .find(|p| p.status != Status::Paid)
                .or_else(|| projected.last())
                .map_or(Status::Due, |p| p.status);
            RecurringLine {
                merchant: s.merchant_key.clone(),
                account_label: data.account_name(&s.account_id),
                cadence: s.cadence,
                cadence_words: s.cadence.words(),
                amount: money(s.median_amount_minor, &s.currency),
                next_due: s.next_due(today),
                status: nearest,
                seen_times: s.occurrences.len(),
                category_label: s.category_concept_id.as_deref().map(|id| data.label(id)),
            }
        })
        .collect();
    Ok(MoneyRecurring {
        series: lines,
        definitions: vec![definitions::RECURRING],
        truncated: lookback.truncated || data.truncated,
    })
}

// ---------------------------------------------------------------------------
// Home's tile.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyHomeTile {
    pub month: String,
    /// Spent this month, one per currency; empty on day one.
    pub spent: Vec<Money>,
    pub empty: bool,
}

/// The tile Home shows: this month's spending per currency, or nothing yet.
pub fn home_tile(door: &dyn PageDoor, month: &str, today: &str) -> KitResult<MoneyHomeTile> {
    let data = MoneyData::load(door)?;
    let window = queries::load_month_plain(door, month, &ActivityFilter::default())?;
    let folded = engine::spending(&window.value, month, &data.context(today));
    Ok(MoneyHomeTile {
        month: month.to_owned(),
        empty: data.accounts.is_empty() || (window.value.is_empty() && folded.is_empty()),
        spent: folded
            .iter()
            .map(|e| money(e.spent_minor, &e.currency))
            .collect(),
    })
}

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneySearch {
    pub term: String,
    pub rows: Vec<ActivityRow>,
    pub total_matches: usize,
    pub corrected: Option<String>,
    pub truncated: bool,
    /// How many months back the walk went.
    pub months_walked: usize,
}

/// Search from `month` back (R-1099-44).
pub fn search(
    door: &dyn PageDoor,
    month: &str,
    term: &str,
    limit: usize,
    today: &str,
) -> KitResult<MoneySearch> {
    let data = MoneyData::load(door)?;
    let hits = queries::search(door, month, term, limit)?;
    Ok(MoneySearch {
        term: term.to_owned(),
        rows: hits
            .rows
            .iter()
            .map(|r| activity_row(r, &data, today))
            .collect(),
        total_matches: hits.total_matches,
        corrected: hits.corrected,
        truncated: hits.truncated,
        months_walked: queries::SEARCH_MONTHS,
    })
}

// ---------------------------------------------------------------------------
// The import plan.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerdictKind {
    New,
    AlreadyIn,
    ProposedDuplicate,
    RepeatInFile,
    Rejected,
}

/// One row of the plan the member reviews.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportPlanRow {
    pub line: usize,
    pub verdict: VerdictKind,
    pub posted_on: Option<String>,
    pub amount: Option<Money>,
    pub description: Option<String>,
    pub category_label: Option<String>,
    pub future_dated: bool,
    /// The existing transaction an `AlreadyIn` or a proposal points at.
    pub existing_txn_id: Option<String>,
    /// A sentence for a rejected row.
    pub reason: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyImportPlan {
    pub rows: Vec<ImportPlanRow>,
    pub new: usize,
    pub already_in: usize,
    pub proposed_duplicates: usize,
    pub repeats_in_file: usize,
    pub rejected: usize,
    pub future_dated: usize,
    pub file_in: Money,
    pub file_out: Money,
    pub new_in: Money,
    pub new_out: Money,
    pub first_day: Option<String>,
    pub last_day: Option<String>,
    /// The date-order question, when the file could not answer it. No rows then.
    pub question: Option<crate::import::DateOrderQuestion>,
    pub warnings: Vec<Warning>,
    /// A checkpoint the statement stated, to write with the rows.
    pub checkpoint: Option<crate::import::Checkpoint>,
    /// The layout to remember: set when the account had none saved or the
    /// saved one no longer fits. Save it only after a successful import.
    pub profile_to_save: Option<SavedProfile>,
}

fn reason_of(reason: RejectReason) -> &'static str {
    reason.sentence()
}

/// The plan the import screen shows. `saved` is the account's saved layout for
/// this file's fingerprint, if it has one.
#[must_use]
pub fn import_plan(
    plan: &ImportPlan,
    categories: &[CategoryRow],
    saved: Option<&SavedProfile>,
) -> MoneyImportPlan {
    let currency = plan.totals.currency.as_str();
    let label = |id: &Option<String>| {
        id.as_deref()
            .and_then(|id| categories.iter().find(|c| c.concept_id == id))
            .map(|c| c.label.clone())
    };
    let rows = plan
        .rows
        .iter()
        .map(|entry: &PlanRow| {
            let (verdict, existing, reason) = match &entry.verdict {
                RowVerdict::New => (VerdictKind::New, None, None),
                RowVerdict::AlreadyIn { existing } => {
                    (VerdictKind::AlreadyIn, Some(existing.clone()), None)
                }
                RowVerdict::ProposedDuplicate { existing } => {
                    (VerdictKind::ProposedDuplicate, Some(existing.clone()), None)
                }
                RowVerdict::RepeatInFile { .. } => (VerdictKind::RepeatInFile, None, None),
                RowVerdict::Rejected { reason } => {
                    (VerdictKind::Rejected, None, Some(reason_of(*reason)))
                }
            };
            ImportPlanRow {
                line: entry.line,
                verdict,
                posted_on: entry.row.as_ref().map(|r| r.posted_on.clone()),
                amount: entry
                    .row
                    .as_ref()
                    .map(|r| money(r.signed_minor(), currency)),
                description: entry.row.as_ref().map(|r| r.description.clone()),
                category_label: entry
                    .row
                    .as_ref()
                    .and_then(|r| label(&r.category_concept_id)),
                future_dated: entry.future_dated,
                existing_txn_id: existing,
                reason,
            }
        })
        .collect();
    let to_save = plan.profile.as_ref().and_then(|p| p.to_saved());
    let profile_to_save = match (to_save, saved) {
        (Some(fresh), Some(old)) if old.header_fingerprint == fresh.header_fingerprint => None,
        (fresh, _) => fresh,
    };
    let t = &plan.totals;
    MoneyImportPlan {
        rows,
        new: t.new,
        already_in: t.already_in,
        proposed_duplicates: t.proposed_duplicates,
        repeats_in_file: t.repeats_in_file,
        rejected: t.rejected,
        future_dated: t.future_dated,
        file_in: money(t.file_in_minor, currency),
        file_out: money(t.file_out_minor, currency),
        new_in: money(t.new_in_minor, currency),
        new_out: money(t.new_out_minor, currency),
        first_day: t.first_day.clone(),
        last_day: t.last_day.clone(),
        question: plan.question.clone(),
        warnings: plan.warnings.clone(),
        checkpoint: plan.checkpoint.clone(),
        profile_to_save,
    }
}
