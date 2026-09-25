//! THE PHONE'S READINGS OF THE LEDGER (#1046) — typed, for `tally.proto`.
//!
//! [`crate::views`] answers the eight manifest queries as v0's JSON, pinned
//! whole by `contracts/apps/tally/queries.json`. The phone cannot read JSON
//! (`commonMain` has no JSON dependency), so this module answers the phone's
//! ten screens as Rust structs over the SAME fold — [`load_tally`], the one
//! balance engine in [`crate::balance`], and the views' own stance and
//! pairwise helpers — and `crates/core`'s `app_query` is the one conversion to
//! the wire.
//!
//! What differs from the views, and why:
//!
//! - **Every figure is a [`Money`]**, never a bare minor-unit integer: a share,
//!   a payer's part and a line all carry the expense's currency, so the core
//!   can state each one's exponent (`centraid_apps_kit::money::minor_units`).
//! - **Nothing adds across currencies.** A friend's group-less part and a
//!   month's spending are keyed by currency; the views' `net_parts` keyed the
//!   group-less part by group alone and summed a EUR and a USD 1:1 expense.
//! - **No sharing plane** (#1029 amendment): no Waiting, no queued notices.
//! - **No clock and no zone here.** `today`, the month and every local reading
//!   are the core's (`FireZone`); this module takes `now` only to say whether a
//!   revision is still undoable, and a month only as its `YYYY-MM` text.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::money::{Money, MoneyBag, Valuation, money, valuate};
use centraid_apps_kit::reads::{PageDoor, read_pages, read_window};
use centraid_apps_kit::row::{integer_or_zero, text_of};
use serde_json::Value;

use crate::balance::{
    attribute_expense, expense_payers, group_net, group_pair_nets, simplification,
};
use crate::queries::{
    ExpenseRow, LEDGER_FAN_OUT, Person, SettlementRow, TRASH_ROWS, TallyData,
    expense_by_id_statement, export_revisions_statement, history_statement, load_tally,
    memo_statement, parties_statement, recurring_statement, trash_statement,
};
use crate::views::{balance_expense, export_limit, owner_stance, pairwise, person_of};

/// The owner's stance on one expense.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Lent,
    Borrowed,
    None,
}

impl Role {
    fn of(word: &str) -> Self {
        match word {
            "lent" => Self::Lent,
            "borrowed" => Self::Borrowed,
            _ => Self::None,
        }
    }
}

/// A person's part of an expense.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Share {
    pub person: Person,
    pub amount: Money,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub line_item_id: String,
    pub kind: String,
    pub description: String,
    pub amount: Money,
    pub allocations: Vec<Share>,
}

/// What the member typed beside each person — provenance, never arithmetic.
#[derive(Debug, Clone, PartialEq)]
pub struct SplitParams {
    pub unit: String,
    pub entries: Vec<(String, f64)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rate {
    pub original: Money,
    pub rate_scaled: i64,
    pub rate_scale: i64,
    pub rate_source: String,
    pub rate_date: String,
}

/// An expense as every ledger list draws it.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub expense_id: String,
    pub group_id: Option<String>,
    pub group_name: String,
    pub description: String,
    pub amount: Money,
    pub category: String,
    pub spent_on: String,
    pub paid_by: Person,
    pub split_method: String,
    pub split_params: Option<SplitParams>,
    pub payers: Vec<Share>,
    pub splits: Vec<Share>,
    pub lines: Vec<Line>,
    pub your_role: Role,
    pub your_amount: Money,
    pub rate: Option<Rate>,
    pub recurring_template_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settlement {
    pub settlement_id: String,
    pub group_id: Option<String>,
    pub from: Person,
    pub to: Person,
    pub amount: Money,
    pub paid_on: Option<String>,
}

/// One or more currencies as one figure, or the components when no rate
/// exists to make them one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Figure {
    pub valued: bool,
    pub total: Option<Money>,
    pub components: Vec<Money>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Suggestion {
    pub from: Person,
    pub to: Person,
    pub amount: Money,
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FriendBalance {
    pub person: Person,
    pub balances: Vec<Money>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupCard {
    pub group_id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub member_count: usize,
    pub your_net: Money,
    pub simplify_opt_in: bool,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityExpense {
    pub expense_id: String,
    pub group_id: Option<String>,
    pub group_name: String,
    pub date: String,
    pub description: String,
    pub category: String,
    pub paid_by: Person,
    pub amount: Money,
    pub your_role: Role,
    pub your_amount: Money,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Activity {
    Expense(ActivityExpense),
    Settlement(Settlement),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateSuggestion {
    pub from_currency: String,
    pub to_currency: String,
    pub rate_scaled: i64,
    pub rate_scale: i64,
    pub rate_source: String,
    pub observed_on: String,
    pub expense_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dashboard {
    pub me: Option<String>,
    pub base_currency: String,
    pub friends: Vec<FriendBalance>,
    pub owed: Figure,
    pub owe: Figure,
    pub expense_count: usize,
    pub settlement_count: usize,
    pub ledger_window_filled: bool,
    pub groups: Vec<GroupCard>,
    pub archived_groups: Vec<GroupCard>,
    pub activity: Vec<Activity>,
    pub rate_suggestions: Vec<RateSuggestion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupMeta {
    pub group_id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub currency: String,
    pub simplify_opt_in: bool,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub person: Person,
    pub net: Money,
    pub departed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Simplified {
    pub opted_in: bool,
    pub transfers: Vec<Suggestion>,
    pub debts_before: usize,
    pub payments_after: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GroupLedger {
    pub me: Option<String>,
    pub group: Option<GroupMeta>,
    pub members: Vec<Member>,
    pub ledger: Vec<Entry>,
    pub settlements: Vec<Settlement>,
    pub simplification: Simplified,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetPart {
    pub group_id: Option<String>,
    pub group_name: String,
    pub net: Money,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FriendLedger {
    pub me: Option<String>,
    pub friend: Option<Person>,
    pub balances: Vec<Money>,
    pub parts: Vec<NetPart>,
    pub ledger: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revision {
    pub revision_id: String,
    pub operation: String,
    pub recorded_at: String,
    pub undo_until: String,
    pub undone_at: Option<String>,
    pub undoable: bool,
    pub before_description: Option<String>,
    pub before_amount: Option<Money>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExpenseDetail {
    pub expense: Option<Entry>,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
    pub memo: Option<String>,
    pub revisions: Vec<Revision>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleUp {
    pub me: Option<String>,
    pub suggestions: Vec<Suggestion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    pub template_id: String,
    pub group_id: Option<String>,
    pub group_name: String,
    pub description: String,
    pub amount: Money,
    pub settlement_currency: Option<String>,
    pub paid_by: Person,
    pub category: String,
    pub rrule: String,
    pub anchor_start: String,
    pub tz: String,
    pub status: String,
    pub last_materialized_start: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryTotal {
    pub category: String,
    pub total: Money,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spending {
    pub month: String,
    pub categories: Vec<CategoryTotal>,
    pub month_total: Vec<Money>,
    pub paid: Vec<Money>,
    pub share: Vec<Money>,
    pub difference: Vec<Money>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchResults {
    pub results: Vec<Entry>,
    pub total_matches: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashRow {
    pub expense_id: String,
    pub description: String,
    pub amount: Money,
    pub group_id: Option<String>,
    pub group_name: String,
    pub spent_on: String,
    pub deleted_at: String,
    pub purge_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportRevision {
    pub revision_id: String,
    pub expense_id: String,
    pub operation: String,
    pub recorded_at: String,
    pub undone_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Export {
    pub group: Option<GroupMeta>,
    pub members: Vec<Person>,
    pub expenses: Vec<Entry>,
    pub settlements: Vec<Settlement>,
    pub revisions: Vec<ExportRevision>,
    pub truncated: bool,
    pub limit: i64,
    pub since: Option<String>,
    pub expenses_in_window: usize,
    pub settlements_in_window: usize,
}

// ---------------------------------------------------------------------------
// Shared pieces.
// ---------------------------------------------------------------------------

fn group_names(data: &TallyData) -> BTreeMap<String, String> {
    data.groups
        .iter()
        .map(|group| (group.group_id.clone(), group.name.clone()))
        .collect()
}

fn name_in(names: &BTreeMap<String, String>, group_id: Option<&str>) -> String {
    group_id
        .and_then(|id| names.get(id).cloned())
        .unwrap_or_default()
}

/// `{"unit": …, "entries": {party: number}}`, as the entry form stores it. A
/// params column of any other shape is no params — the resolved splits are
/// still the figures, and an editor re-opens as exact amounts.
fn split_params_of(json: Option<&str>) -> Option<SplitParams> {
    let parsed: Value = serde_json::from_str(json?).ok()?;
    let unit = parsed.get("unit")?.as_str()?.to_owned();
    let entries = parsed
        .get("entries")?
        .as_object()?
        .iter()
        .filter_map(|(party, value)| Some((party.clone(), value.as_f64()?)))
        .collect();
    Some(SplitParams { unit, entries })
}

/// One expense, as every ledger list draws it. Every part is in the expense's
/// own currency.
#[must_use]
pub fn entry(data: &TallyData, expense: &ExpenseRow, names: &BTreeMap<String, String>) -> Entry {
    let currency = data.expense_currency(expense);
    let at = |minor: i64| money(minor, &currency);
    let (role, your_minor) = owner_stance(data, expense);
    let shares = |map: Option<&BTreeMap<String, i64>>| -> Vec<Share> {
        map.into_iter()
            .flatten()
            .map(|(party_id, minor)| Share {
                person: person_of(data, party_id),
                amount: at(*minor),
            })
            .collect()
    };
    let rate = match (expense.original_currency.as_deref(), expense.rate_scaled) {
        (Some(original), Some(rate_scaled)) if original != currency => Some(Rate {
            original: money(
                expense
                    .original_amount_minor
                    .unwrap_or(expense.amount_minor),
                original,
            ),
            rate_scaled,
            rate_scale: expense.rate_scale.unwrap_or(6),
            rate_source: expense
                .rate_source
                .clone()
                .unwrap_or_else(|| "supplied at entry".to_owned()),
            rate_date: expense
                .rate_date
                .clone()
                .unwrap_or_else(|| expense.spent_on.clone()),
        }),
        _ => None,
    };
    Entry {
        expense_id: expense.expense_id.clone(),
        group_id: expense.group_id.clone(),
        group_name: name_in(names, expense.group_id.as_deref()),
        description: expense.description.clone(),
        amount: at(expense.amount_minor),
        category: expense.category.clone(),
        spent_on: expense.spent_on.clone(),
        paid_by: person_of(data, &expense.paid_by),
        split_method: expense.split_method.clone(),
        split_params: split_params_of(expense.split_params_json.as_deref()),
        payers: expense_payers(&balance_expense(data, expense))
            .iter()
            .map(|(party_id, minor)| Share {
                person: person_of(data, party_id),
                amount: at(*minor),
            })
            .collect(),
        splits: shares(data.splits.get(&expense.expense_id)),
        lines: data
            .lines
            .get(&expense.expense_id)
            .into_iter()
            .flatten()
            .map(|line| Line {
                line_item_id: line.line_item_id.clone(),
                kind: line.kind.clone(),
                description: line.description.clone(),
                amount: at(line.amount_minor),
                allocations: shares(Some(&line.allocations)),
            })
            .collect(),
        your_role: Role::of(role),
        your_amount: at(your_minor),
        rate,
        recurring_template_id: expense.recurring_template_id.clone(),
    }
}

fn settlement(data: &TallyData, row: &SettlementRow) -> Settlement {
    Settlement {
        settlement_id: row.settlement_id.clone(),
        group_id: row.group_id.clone(),
        from: person_of(data, &row.from_party),
        to: person_of(data, &row.to_party),
        amount: money(row.amount_minor, &data.settlement_currency(row)),
        paid_on: row.paid_on.clone(),
    }
}

fn figure(valuation: &Valuation) -> Figure {
    match valuation {
        Valuation::Valued {
            total, components, ..
        } => Figure {
            valued: true,
            total: Some(total.clone()),
            components: components.entries().to_vec(),
        },
        Valuation::Unavailable { components, .. } => Figure {
            valued: false,
            total: None,
            components: components.entries().to_vec(),
        },
    }
}

/// A bag's non-zero entries: a currency the position is level in is not a
/// balance to draw.
fn non_zero(bag: &MoneyBag) -> Vec<Money> {
    bag.entries()
        .iter()
        .filter(|amount| amount.amount_minor != 0)
        .cloned()
        .collect()
}

fn group_meta(data: &TallyData, group_id: &str) -> Option<GroupMeta> {
    data.groups
        .iter()
        .find(|group| group.group_id == group_id)
        .map(|group| GroupMeta {
            group_id: group.group_id.clone(),
            name: group.name.clone(),
            icon: group.icon.clone(),
            color: group.color.clone(),
            currency: group.currency.clone(),
            simplify_opt_in: group.simplify_opt_in,
            archived_at: group.archived_at.clone(),
        })
}

/// A door refusal is a denial the core draws; everything else propagates.
/// Kept as the kit's error so `crates/core` tells the two apart the way it
/// does for every app.
fn loaded(door: &dyn PageDoor) -> KitResult<TallyData> {
    load_tally(door)
}

// ---------------------------------------------------------------------------
// 1. dashboard — Balances, Groups, Activity.
// ---------------------------------------------------------------------------

/// Balances, Groups and Activity from one read.
pub fn load_dashboard(door: &dyn PageDoor) -> KitResult<Dashboard> {
    let data = loaded(door)?;
    dashboard_of(&data)
}

/// The dashboard's fold over facts already read.
pub fn dashboard_of(data: &TallyData) -> KitResult<Dashboard> {
    let bags = pairwise(data);
    let friends = data
        .friends
        .iter()
        .map(|party_id| FriendBalance {
            person: person_of(data, party_id),
            balances: bags.get(party_id).map(non_zero).unwrap_or_default(),
        })
        .collect();
    // THE HERO IS TWO VALUATIONS (#996, R22): each side is a position per
    // currency, and one number is a claim that a rate exists.
    let mut owe = MoneyBag::empty();
    let mut owed = MoneyBag::empty();
    for bag in bags.values() {
        for amount in bag.entries() {
            if amount.amount_minor > 0 {
                owed = owed.plus(amount.clone());
            } else if amount.amount_minor < 0 {
                owe = owe.plus(amount.negated());
            }
        }
    }
    let balances = data.balance_data();
    let card = |group: &crate::queries::GroupRow| {
        let net = group_net(&balances, &group.group_id);
        GroupCard {
            group_id: group.group_id.clone(),
            name: group.name.clone(),
            icon: group.icon.clone(),
            color: group.color.clone(),
            member_count: data
                .members_by_group
                .get(&group.group_id)
                .map_or(0, Vec::len),
            your_net: money(
                data.me
                    .as_deref()
                    .and_then(|me| net.get(me).copied())
                    .unwrap_or(0),
                &group.currency,
            ),
            simplify_opt_in: group.simplify_opt_in,
            archived_at: group.archived_at.clone(),
        }
    };
    Ok(Dashboard {
        me: data.me.clone(),
        base_currency: data.currency.clone(),
        friends,
        owed: figure(&valuate(&owed, &data.currency, &[])?),
        owe: figure(&valuate(&owe, &data.currency, &[])?),
        expense_count: data.expenses.len(),
        settlement_count: data.settlements.len(),
        ledger_window_filled: data.ledger_window_filled,
        groups: data
            .groups
            .iter()
            .filter(|group| group.archived_at.is_none())
            .map(card)
            .collect(),
        archived_groups: data
            .groups
            .iter()
            .filter(|group| group.archived_at.is_some())
            .map(card)
            .collect(),
        activity: activity(data),
        rate_suggestions: rate_suggestions(data),
    })
}

/// Expenses and settlements interleaved, newest date first; a stable sort, so
/// two rows on one day keep the ledger's own order (v0's `activity`).
fn activity(data: &TallyData) -> Vec<Activity> {
    let names = group_names(data);
    let me = data.me.as_deref();
    let mut rows: Vec<(String, Activity)> = Vec::new();
    for expense in &data.expenses {
        let currency = data.expense_currency(expense);
        let my_share = me.and_then(|me| {
            data.splits
                .get(&expense.expense_id)
                .and_then(|splits| splits.get(me))
                .copied()
        });
        // The feed asks who PAID (v0's `activity`, not `ledgerRow`).
        let (role, minor) = if me == Some(expense.paid_by.as_str()) {
            (Role::Lent, expense.amount_minor - my_share.unwrap_or(0))
        } else if let Some(share) = my_share {
            (Role::Borrowed, share)
        } else {
            (Role::None, 0)
        };
        rows.push((
            expense.spent_on.clone(),
            Activity::Expense(ActivityExpense {
                expense_id: expense.expense_id.clone(),
                group_id: expense.group_id.clone(),
                group_name: name_in(&names, expense.group_id.as_deref()),
                date: expense.spent_on.clone(),
                description: expense.description.clone(),
                category: expense.category.clone(),
                paid_by: person_of(data, &expense.paid_by),
                amount: money(expense.amount_minor, &currency),
                your_role: role,
                your_amount: money(minor, &currency),
            }),
        ));
    }
    for row in &data.settlements {
        rows.push((
            row.paid_on.clone().unwrap_or_default(),
            Activity::Settlement(settlement(data, row)),
        ));
    }
    rows.sort_by(|left, right| right.0.cmp(&left.0));
    rows.into_iter().map(|(_, row)| row).collect()
}

/// The latest remembered rate per currency pair (the views' fold, typed).
fn rate_suggestions(data: &TallyData) -> Vec<RateSuggestion> {
    let mut latest: BTreeMap<(String, String), RateSuggestion> = BTreeMap::new();
    for expense in &data.expenses {
        let (Some(from), Some(to)) = (
            expense.original_currency.as_deref(),
            expense.settlement_currency.as_deref(),
        ) else {
            continue;
        };
        let (Some(rate_scaled), Some(rate_scale)) = (expense.rate_scaled, expense.rate_scale)
        else {
            continue;
        };
        if from == to {
            continue;
        }
        let observed_on = expense
            .rate_date
            .clone()
            .unwrap_or_else(|| expense.spent_on.clone());
        let key = (from.to_owned(), to.to_owned());
        if latest
            .get(&key)
            .is_some_and(|held| held.observed_on >= observed_on)
        {
            continue;
        }
        latest.insert(
            key,
            RateSuggestion {
                from_currency: from.to_owned(),
                to_currency: to.to_owned(),
                rate_scaled,
                rate_scale,
                rate_source: expense
                    .rate_source
                    .clone()
                    .unwrap_or_else(|| "supplied at entry".to_owned()),
                observed_on,
                expense_id: expense.expense_id.clone(),
            },
        );
    }
    latest.into_values().collect()
}

// ---------------------------------------------------------------------------
// 2. group, 3. friend.
// ---------------------------------------------------------------------------

pub fn load_group(door: &dyn PageDoor, group_id: &str) -> KitResult<GroupLedger> {
    Ok(group_of(&loaded(door)?, group_id))
}

/// One group's ledger. A group that does not exist is `group: None` and empty
/// lists — a stale link is not a failure of the vault.
#[must_use]
pub fn group_of(data: &TallyData, group_id: &str) -> GroupLedger {
    let Some(meta) = group_meta(data, group_id) else {
        return GroupLedger {
            me: data.me.clone(),
            group: None,
            members: Vec::new(),
            ledger: Vec::new(),
            settlements: Vec::new(),
            simplification: Simplified {
                opted_in: false,
                transfers: Vec::new(),
                debts_before: 0,
                payments_after: 0,
            },
        };
    };
    let balances = data.balance_data();
    let net = group_net(&balances, group_id);
    let roster: Vec<String> = data
        .members_by_group
        .get(group_id)
        .cloned()
        .unwrap_or_default();
    let current: BTreeSet<&str> = roster.iter().map(String::as_str).collect();
    // A departed participant is still on the screen, marked: membership is
    // current state and the ledger is history.
    let members = roster
        .iter()
        .chain(net.keys().filter(|party| !current.contains(party.as_str())))
        .map(|party_id| Member {
            person: person_of(data, party_id),
            net: money(net.get(party_id).copied().unwrap_or(0), &meta.currency),
            departed: !current.contains(party_id.as_str()),
        })
        .collect();
    let names = group_names(data);
    let answer = simplification(&balances, group_id, meta.simplify_opt_in, &meta.currency);
    GroupLedger {
        me: data.me.clone(),
        members,
        ledger: data
            .expenses
            .iter()
            .filter(|expense| expense.group_id.as_deref() == Some(group_id))
            .map(|expense| entry(data, expense, &names))
            .collect(),
        settlements: data
            .settlements
            .iter()
            .filter(|row| row.group_id.as_deref() == Some(group_id))
            .map(|row| settlement(data, row))
            .collect(),
        simplification: Simplified {
            opted_in: answer.opted_in,
            transfers: answer
                .transfers
                .into_iter()
                .map(|transfer| Suggestion {
                    from: person_of(data, &transfer.from),
                    to: person_of(data, &transfer.to),
                    amount: transfer.amount,
                    group_id: Some(group_id.to_owned()),
                })
                .collect(),
            debts_before: answer.debts_before,
            payments_after: answer.payments_after,
        },
        group: Some(meta),
    }
}

/// The owner's net with one friend, by `(group, currency)`: one part per group
/// plus the group-less part, and never a sum across two monies.
fn parts_with(data: &TallyData, friend_id: &str) -> BTreeMap<(Option<String>, String), i64> {
    let mut parts: BTreeMap<(Option<String>, String), i64> = BTreeMap::new();
    let Some(me) = data.me.as_deref() else {
        return parts;
    };
    let mut note = |group: Option<String>, currency: String, amount: i64| {
        *parts.entry((group, currency)).or_insert(0) += amount;
    };
    for expense in &data.expenses {
        let currency = data.expense_currency(expense);
        for attribution in attribute_expense(&balance_expense(data, expense)) {
            if attribution.to == me && attribution.from == friend_id {
                note(
                    expense.group_id.clone(),
                    currency.clone(),
                    attribution.amount_minor,
                );
            } else if attribution.from == me && attribution.to == friend_id {
                note(
                    expense.group_id.clone(),
                    currency.clone(),
                    -attribution.amount_minor,
                );
            }
        }
    }
    for row in &data.settlements {
        let currency = data.settlement_currency(row);
        if row.from_party == me && row.to_party == friend_id {
            note(row.group_id.clone(), currency, row.amount_minor);
        } else if row.to_party == me && row.from_party == friend_id {
            note(row.group_id.clone(), currency, -row.amount_minor);
        }
    }
    for obligation in &data.obligations {
        // A standing IOU is never group-scoped.
        let from = text_of(obligation, "from_party").unwrap_or_default();
        let to = text_of(obligation, "to_party").unwrap_or_default();
        let currency = text_of(obligation, "currency").unwrap_or_default();
        let amount = integer_or_zero(obligation, "amount_minor");
        if from == me && to == friend_id {
            note(None, currency, -amount);
        } else if to == me && from == friend_id {
            note(None, currency, amount);
        }
    }
    parts.retain(|_, net| *net != 0);
    parts
}

pub fn load_friend(door: &dyn PageDoor, party_id: &str) -> KitResult<FriendLedger> {
    Ok(friend_of(&loaded(door)?, party_id))
}

/// One friend. The owner is not their own friend, and an id the ledger never
/// named has no friend view: both answer `friend: None`.
#[must_use]
pub fn friend_of(data: &TallyData, party_id: &str) -> FriendLedger {
    if !data.people.contains_key(party_id) || data.me.as_deref() == Some(party_id) {
        return FriendLedger {
            me: data.me.clone(),
            friend: None,
            balances: Vec::new(),
            parts: Vec::new(),
            ledger: Vec::new(),
        };
    }
    let names = group_names(data);
    let bags = pairwise(data);
    let me = data.me.as_deref();
    let mut parts: Vec<NetPart> = parts_with(data, party_id)
        .into_iter()
        .map(|((group_id, currency), net)| NetPart {
            group_name: name_in(&names, group_id.as_deref()),
            group_id,
            net: money(net, &currency),
        })
        .collect();
    // Groups by name, the group-less part last.
    parts.sort_by(|left, right| {
        (left.group_id.is_none(), &left.group_name)
            .cmp(&(right.group_id.is_none(), &right.group_name))
    });
    FriendLedger {
        me: data.me.clone(),
        friend: Some(person_of(data, party_id)),
        balances: bags.get(party_id).map(non_zero).unwrap_or_default(),
        parts,
        ledger: data
            .expenses
            .iter()
            .filter(|expense| {
                let splits = data.splits.get(&expense.expense_id);
                let shares = |who: &str| splits.is_some_and(|splits| splits.contains_key(who));
                let one_of_us_paid =
                    expense.paid_by == party_id || me == Some(expense.paid_by.as_str());
                shares(party_id) && me.is_some_and(shares) && one_of_us_paid
            })
            .map(|expense| entry(data, expense, &names))
            .collect(),
    }
}

// ---------------------------------------------------------------------------
// 4. one expense.
// ---------------------------------------------------------------------------

/// One expense, live or trashed, with its memo and revisions. `now` is the
/// vault clock, read only to say whether a revision can still be undone.
pub fn load_expense(door: &dyn PageDoor, expense_id: &str, now: &str) -> KitResult<ExpenseDetail> {
    let absent = ExpenseDetail {
        expense: None,
        deleted_at: None,
        purge_at: None,
        memo: None,
        revisions: Vec::new(),
    };
    if expense_id.is_empty() {
        return Ok(absent);
    }
    let found = read_window(door, &expense_by_id_statement(expense_id), 1)?;
    let Some(row) = found.rows.first() else {
        return Ok(absent);
    };
    let Some(expense) = crate::queries::expense_row(row) else {
        return Ok(absent);
    };
    let mut data = loaded(door)?;
    // A TRASHED expense's sharers are not in the party set `load_tally` names
    // (it resolves live expenses only), so they are resolved here — "Someone"
    // is for a party the vault cannot name, not one the read skipped.
    let mut unnamed: BTreeSet<String> = BTreeSet::new();
    unnamed.insert(expense.paid_by.clone());
    for map in [data.splits.get(expense_id), data.payers.get(expense_id)] {
        unnamed.extend(map.into_iter().flat_map(BTreeMap::keys).cloned());
    }
    for line in data.lines.get(expense_id).into_iter().flatten() {
        unnamed.extend(line.allocations.keys().cloned());
    }
    unnamed.retain(|party| !data.people.contains_key(party));
    if !unnamed.is_empty() {
        let ids: Vec<String> = unnamed.into_iter().collect();
        let rows = read_pages(door, &parties_statement(&ids)?, LEDGER_FAN_OUT)?;
        for party_id in ids {
            let name = rows
                .iter()
                .find(|row| text_of(row, "party_id").as_deref() == Some(party_id.as_str()))
                .and_then(|row| text_of(row, "display_name"))
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| "Someone".to_owned());
            let person = crate::queries::person_of_name(&party_id, &name, false);
            data.people.insert(party_id, person);
        }
    }
    let memo = read_window(door, &memo_statement(expense_id), 1)?
        .rows
        .first()
        .and_then(|row| text_of(row, "body_text"));
    let currency = data.expense_currency(&expense);
    let revisions = read_pages(door, &history_statement(expense_id), LEDGER_FAN_OUT)?
        .iter()
        .map(|row| {
            let snapshot = text_of(row, "snapshot_json")
                .and_then(|text| serde_json::from_str::<Value>(&text).ok());
            let before = snapshot.as_ref().and_then(|value| value.get("expense"));
            let undo_until = text_of(row, "undo_until").unwrap_or_default();
            let undone_at = text_of(row, "undone_at");
            Revision {
                revision_id: text_of(row, "revision_id").unwrap_or_default(),
                operation: text_of(row, "operation").unwrap_or_default(),
                recorded_at: text_of(row, "recorded_at").unwrap_or_default(),
                // Both are the vault's fixed-width instant text, which sorts
                // as it reads.
                undoable: undone_at.is_none() && undo_until.as_str() > now,
                undo_until,
                undone_at,
                before_description: before
                    .and_then(|expense| expense.get("description"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                before_amount: before
                    .and_then(|expense| expense.get("amount_minor"))
                    .and_then(Value::as_i64)
                    .map(|minor| {
                        let held = before
                            .and_then(|expense| expense.get("settlement_currency"))
                            .and_then(Value::as_str)
                            .unwrap_or(&currency);
                        money(minor, held)
                    }),
            }
        })
        .collect();
    let names = group_names(&data);
    Ok(ExpenseDetail {
        deleted_at: expense.deleted_at.clone(),
        purge_at: text_of(row, "purge_at"),
        expense: Some(entry(&data, &expense, &names)),
        memo,
        revisions,
    })
}

// ---------------------------------------------------------------------------
// 5. settle up.
// ---------------------------------------------------------------------------

pub fn load_settle_up(door: &dyn PageDoor, group_id: Option<&str>) -> KitResult<SettleUp> {
    Ok(settle_up_of(&loaded(door)?, group_id))
}

/// The payments that would level the ledger: per group, the minimal set when
/// the group opts in and each open pairwise debt when it does not; then, when
/// no group is named, the group-less position with each friend.
#[must_use]
pub fn settle_up_of(data: &TallyData, only: Option<&str>) -> SettleUp {
    let balances = data.balance_data();
    let mut suggestions = Vec::new();
    for group in &data.groups {
        if only.is_some_and(|wanted| wanted != group.group_id) {
            continue;
        }
        if group.simplify_opt_in {
            let answer = simplification(&balances, &group.group_id, true, &group.currency);
            suggestions.extend(answer.transfers.into_iter().map(|transfer| Suggestion {
                from: person_of(data, &transfer.from),
                to: person_of(data, &transfer.to),
                amount: transfer.amount,
                group_id: Some(group.group_id.clone()),
            }));
        } else {
            for (from, owed) in group_pair_nets(&balances, &group.group_id) {
                for (to, amount) in owed {
                    if amount > 0 {
                        suggestions.push(Suggestion {
                            from: person_of(data, &from),
                            to: person_of(data, &to),
                            amount: money(amount, &group.currency),
                            group_id: Some(group.group_id.clone()),
                        });
                    }
                }
            }
        }
    }
    if only.is_none()
        && let Some(me) = data.me.as_deref()
    {
        for friend in &data.friends {
            for ((group, currency), net) in parts_with(data, friend) {
                if group.is_some() {
                    continue;
                }
                // Positive: the friend owes the owner.
                let (from, to) = if net > 0 {
                    (friend.as_str(), me)
                } else {
                    (me, friend.as_str())
                };
                suggestions.push(Suggestion {
                    from: person_of(data, from),
                    to: person_of(data, to),
                    amount: money(net.abs(), &currency),
                    group_id: None,
                });
            }
        }
    }
    SettleUp {
        me: data.me.clone(),
        suggestions,
    }
}

// ---------------------------------------------------------------------------
// 6. recurring, 7. spending, 8. search, 9. trash, 10. export.
// ---------------------------------------------------------------------------

/// The standing orders. The schedule sentence is the core's
/// (`centraid_vault::time::rrule::describe`), which this crate does not link.
pub fn load_recurring(door: &dyn PageDoor) -> KitResult<Vec<Template>> {
    let data = loaded(door)?;
    let rows = read_window(door, &recurring_statement(), crate::queries::RECURRING_ROWS)?.rows;
    let names = group_names(&data);
    Ok(rows
        .iter()
        .map(|row| {
            let group_id = text_of(row, "group_id");
            Template {
                template_id: text_of(row, "template_id").unwrap_or_default(),
                group_name: name_in(&names, group_id.as_deref()),
                group_id,
                description: text_of(row, "description").unwrap_or_default(),
                amount: money(
                    integer_or_zero(row, "original_amount_minor"),
                    &text_of(row, "original_currency").unwrap_or_else(|| data.currency.clone()),
                ),
                settlement_currency: text_of(row, "settlement_currency"),
                paid_by: person_of(&data, &text_of(row, "paid_by").unwrap_or_default()),
                category: text_of(row, "category").unwrap_or_default(),
                rrule: text_of(row, "rrule").unwrap_or_default(),
                anchor_start: text_of(row, "anchor_start").unwrap_or_default(),
                tz: text_of(row, "tz").unwrap_or_default(),
                status: text_of(row, "status").unwrap_or_default(),
                last_materialized_start: text_of(row, "last_materialized_start"),
            }
        })
        .collect())
}

/// Whether `month` is `YYYY-MM`.
#[must_use]
pub fn is_month(month: &str) -> bool {
    let bytes = month.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && [0, 1, 2, 3, 5, 6]
            .iter()
            .all(|at| bytes[*at].is_ascii_digit())
}

pub fn load_spending(door: &dyn PageDoor, month: &str) -> KitResult<Spending> {
    Ok(spending_of(&loaded(door)?, month))
}

/// What `month` (`YYYY-MM`) went on — the whole expense, not the owner's
/// share; settlements are not spending — and the paid-versus-share pair. Every
/// figure is per currency.
#[must_use]
pub fn spending_of(data: &TallyData, month: &str) -> Spending {
    let me = data.me.as_deref();
    let mut categories: BTreeMap<(String, String), i64> = BTreeMap::new();
    let mut total: BTreeMap<String, i64> = BTreeMap::new();
    let mut paid: BTreeMap<String, i64> = BTreeMap::new();
    let mut share: BTreeMap<String, i64> = BTreeMap::new();
    for expense in &data.expenses {
        if expense.spent_on.get(..7) != Some(month) {
            continue;
        }
        let currency = data.expense_currency(expense);
        *categories
            .entry((currency.clone(), expense.category.clone()))
            .or_insert(0) += expense.amount_minor;
        *total.entry(currency.clone()).or_insert(0) += expense.amount_minor;
        if me == Some(expense.paid_by.as_str()) {
            *paid.entry(currency.clone()).or_insert(0) += expense.amount_minor;
        }
        let mine = me
            .and_then(|me| data.splits.get(&expense.expense_id)?.get(me).copied())
            .unwrap_or(0);
        *share.entry(currency).or_insert(0) += mine;
    }
    let mut rows: Vec<CategoryTotal> = categories
        .into_iter()
        .map(|((currency, category), minor)| CategoryTotal {
            category,
            total: money(minor, &currency),
        })
        .collect();
    rows.sort_by(|left, right| {
        left.total
            .currency
            .code()
            .cmp(right.total.currency.code())
            .then(right.total.amount_minor.cmp(&left.total.amount_minor))
            .then(left.category.cmp(&right.category))
    });
    let listed = |map: &BTreeMap<String, i64>| -> Vec<Money> {
        map.iter()
            .map(|(currency, minor)| money(*minor, currency))
            .collect()
    };
    let currencies: BTreeSet<&String> = paid.keys().chain(share.keys()).collect();
    Spending {
        month: month.to_owned(),
        categories: rows,
        month_total: listed(&total),
        difference: currencies
            .into_iter()
            .map(|currency| {
                money(
                    paid.get(currency).copied().unwrap_or(0)
                        - share.get(currency).copied().unwrap_or(0),
                    currency,
                )
            })
            .collect(),
        paid: listed(&paid),
        share: listed(&share),
    }
}

/// Live expenses whose description contains `term`, case-insensitively, at
/// most `limit`. An empty term reads nothing.
pub fn load_search(door: &dyn PageDoor, term: &str, limit: usize) -> KitResult<SearchResults> {
    let needle = term.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(SearchResults {
            results: Vec::new(),
            total_matches: 0,
        });
    }
    let data = loaded(door)?;
    let names = group_names(&data);
    let matched: Vec<&ExpenseRow> = data
        .expenses
        .iter()
        .filter(|expense| expense.description.to_lowercase().contains(&needle))
        .collect();
    Ok(SearchResults {
        total_matches: matched.len(),
        results: matched
            .into_iter()
            .take(limit)
            .map(|expense| entry(&data, expense, &names))
            .collect(),
    })
}

/// The trash shelf, newest first, at most [`TRASH_ROWS`].
pub fn load_trash(door: &dyn PageDoor) -> KitResult<Vec<TrashRow>> {
    let data = loaded(door)?;
    let names = group_names(&data);
    let rows = read_window(door, &trash_statement(), TRASH_ROWS)?.rows;
    Ok(rows
        .iter()
        .map(|row| {
            let group_id = text_of(row, "group_id");
            let currency = text_of(row, "currency")
                .or_else(|| group_id.as_deref().map(|id| data.group_currency(id)))
                .unwrap_or_else(|| data.currency.clone());
            TrashRow {
                expense_id: text_of(row, "expense_id").unwrap_or_default(),
                description: text_of(row, "description").unwrap_or_default(),
                amount: money(integer_or_zero(row, "amount_minor"), &currency),
                group_name: name_in(&names, group_id.as_deref()),
                group_id,
                spent_on: text_of(row, "spent_on").unwrap_or_default(),
                deleted_at: text_of(row, "deleted_at").unwrap_or_default(),
                purge_at: text_of(row, "purge_at"),
            }
        })
        .collect())
}

/// One group's ledger as rows for a file — balances excluded, the window
/// stated (the views' `export`, typed).
pub fn load_export(
    door: &dyn PageDoor,
    group_id: &str,
    since: Option<&str>,
    asked_limit: Option<i64>,
) -> KitResult<Export> {
    let data = loaded(door)?;
    let limit = export_limit(asked_limit);
    let floor = since.and_then(crate::queries::floor_date);
    let Some(meta) = group_meta(&data, group_id) else {
        return Ok(Export {
            group: None,
            members: Vec::new(),
            expenses: Vec::new(),
            settlements: Vec::new(),
            revisions: Vec::new(),
            truncated: false,
            limit,
            since: floor.map(str::to_owned),
            expenses_in_window: 0,
            settlements_in_window: 0,
        });
    };
    let scoped: Vec<&ExpenseRow> = data
        .expenses
        .iter()
        .filter(|expense| {
            expense.group_id.as_deref() == Some(group_id)
                && crate::queries::on_or_after(Some(expense.spent_on.as_str()), floor)
        })
        .collect();
    let settlements: Vec<&SettlementRow> = data
        .settlements
        .iter()
        .filter(|row| {
            row.group_id.as_deref() == Some(group_id)
                && crate::queries::on_or_after(row.paid_on.as_deref(), floor)
        })
        .collect();
    let taken = usize::try_from(limit).unwrap_or(usize::MAX);
    let names = group_names(&data);
    let expenses: Vec<Entry> = scoped
        .iter()
        .take(taken)
        .map(|expense| entry(&data, expense, &names))
        .collect();
    let ids: Vec<String> = expenses
        .iter()
        .map(|entry| entry.expense_id.clone())
        .collect();
    let revisions = if ids.is_empty() {
        Vec::new()
    } else {
        read_pages(door, &export_revisions_statement(&ids)?, LEDGER_FAN_OUT)?
            .iter()
            .map(|row| ExportRevision {
                revision_id: text_of(row, "revision_id").unwrap_or_default(),
                expense_id: text_of(row, "entity_id").unwrap_or_default(),
                operation: text_of(row, "operation").unwrap_or_default(),
                recorded_at: text_of(row, "recorded_at").unwrap_or_default(),
                undone_at: text_of(row, "undone_at"),
            })
            .collect()
    };
    Ok(Export {
        members: data
            .members_by_group
            .get(group_id)
            .into_iter()
            .flatten()
            .map(|party_id| person_of(&data, party_id))
            .collect(),
        truncated: scoped.len() > taken || settlements.len() > taken,
        expenses_in_window: scoped.len(),
        settlements_in_window: settlements.len(),
        settlements: settlements
            .iter()
            .take(taken)
            .map(|row| settlement(&data, row))
            .collect(),
        expenses,
        revisions,
        limit,
        since: floor.map(str::to_owned),
        group: Some(meta),
    })
}

/// The civil day before `day` (`YYYY-MM-DD`), by the proleptic Gregorian
/// calendar — pure date arithmetic, so a 23- or 25-hour day cannot move it.
#[must_use]
pub fn day_before(day: &str) -> Option<String> {
    let year: i64 = day.get(..4)?.parse().ok()?;
    let month: i64 = day.get(5..7)?.parse().ok()?;
    let date: i64 = day.get(8..10)?.parse().ok()?;
    if day.len() != 10 || !(1..=12).contains(&month) || date < 1 {
        return None;
    }
    let (year, month, date) = if date > 1 {
        (year, month, date - 1)
    } else if month > 1 {
        (year, month - 1, days_in(year, month - 1))
    } else {
        (year - 1, 12, 31)
    };
    Some(format!("{year:04}-{month:02}-{date:02}"))
}

const fn days_in(year: i64, month: i64) -> i64 {
    match month {
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 31,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_day_before_crosses_months_years_and_leap_days() {
        assert_eq!(day_before("2099-06-02").as_deref(), Some("2099-06-01"));
        assert_eq!(day_before("2099-03-01").as_deref(), Some("2099-02-28"));
        assert_eq!(day_before("2096-03-01").as_deref(), Some("2096-02-29"));
        assert_eq!(day_before("2100-01-01").as_deref(), Some("2099-12-31"));
        assert_eq!(day_before("not a day"), None);
    }

    #[test]
    fn a_month_is_seven_characters_of_one_shape() {
        assert!(is_month("2099-06"));
        assert!(!is_month("2099-6"));
        assert!(!is_month("2099-06-01"));
    }

    #[test]
    fn split_params_of_reads_the_entry_form_and_nothing_else() {
        let params = split_params_of(Some(r#"{"unit":"percent","entries":{"a":25,"b":75.5}}"#))
            .expect("the entry form's shape");
        assert_eq!(params.unit, "percent");
        assert_eq!(
            params.entries,
            vec![("a".to_owned(), 25.0), ("b".to_owned(), 75.5)]
        );
        assert_eq!(split_params_of(Some("[1,2]")), None);
        assert_eq!(split_params_of(None), None);
    }
}
