//! TALLY'S ARM OF THE APP QUERY (#1046): `crates/apps/tally`'s folds, asked
//! through [`super::VaultDoor`] and spelled as `tally.proto` spells them.
//!
//! Every balance, share, stance and simplification is the crate's
//! (`centraid_apps_tally::phone`, over the one engine in `balance`); this
//! module resolves the zone and the vault clock, runs the loader, and
//! converts. Two things are added here and nowhere else:
//!
//! - **EVERY MONEY CARRIES ITS EXPONENT**, from
//!   [`centraid_apps_kit::money::minor_units`] — a shell never guesses how
//!   many digits a currency has (JPY is 0, BHD is 3).
//! - **EVERY CIVIL READING IS THE DEVICE'S ZONE** ([`super::zone_of`]'s rule):
//!   `today`, a month, a trash date, a revision's wall clock. And a recurring
//!   template's schedule sentence is [`centraid_vault::time::rrule::describe`],
//!   the one summariser (#834), which the app crate does not link.
//!
//! A door refusal ([`KitError::Door`]) that the door did not itself record as
//! a failure is the answer's `denied` arm — [`super::settle`] decides — so a
//! Tally loader, which returns the kit's error rather than a denial beside its
//! data, is lowered by [`answered`].

use centraid_api_proto::core_v1 as wire;
use centraid_apps_agenda::local;
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::money::{Money, minor_units};
use centraid_apps_tally::Person;
use centraid_apps_tally::phone::{self, Activity, Entry, Role};
use centraid_vault::Vault;
use centraid_vault::time::zone::FireZone;

use super::{VaultDoor, settle, zone_of};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// A Tally loader's answer as the wire's: the data, the denial a door refusal
/// is, or the error — with what the door recorded taking precedence.
fn answered<T>(
    door: &VaultDoor<'_>,
    loaded: KitResult<T>,
    data: impl FnOnce(T) -> Answer,
) -> Result<Answer> {
    match loaded {
        Err(KitError::Door(message)) => settle(
            door,
            Ok(((), Some(centraid_apps_agenda::denial_of(message)))),
            |()| unreachable!("a denial carries no data"),
        ),
        other => settle(door, other.map(|value| (value, None)), data),
    }
}

/// The vault clock's day in `zone`.
fn today(zone: &FireZone, now: &str) -> Result<String> {
    local::today(zone, now).ok_or_else(|| CoreError::Invariant {
        context: format!("the vault clock did not read as a day: {now}"),
    })
}

/// A stored instant's civil day in `zone`; empty where it does not parse.
fn day_of(zone: &FireZone, instant: &str) -> String {
    local::today(zone, instant).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// The ten arms.
// ---------------------------------------------------------------------------

pub(super) fn dashboard(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::TallyDashboardRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let today = today(&zone, now)?;
    let yesterday = phone::day_before(&today).unwrap_or_default();
    answered(door, phone::load_dashboard(door), |data| {
        Answer::TallyDashboard(wire::TallyDashboard {
            me: data.me,
            base_exponent: u32::from(minor_units(&data.base_currency)),
            base_currency: data.base_currency,
            today,
            yesterday,
            friends: data
                .friends
                .into_iter()
                .map(|friend| wire::TallyFriendBalance {
                    person: Some(person(friend.person)),
                    balances: monies(&friend.balances),
                })
                .collect(),
            owed: Some(figure(data.owed)),
            owe: Some(figure(data.owe)),
            expense_count: count(data.expense_count),
            settlement_count: count(data.settlement_count),
            ledger_window_filled: data.ledger_window_filled,
            groups: data.groups.into_iter().map(group_card).collect(),
            archived_groups: data.archived_groups.into_iter().map(group_card).collect(),
            activity: data.activity.into_iter().map(activity).collect(),
            rate_suggestions: data
                .rate_suggestions
                .into_iter()
                .map(|rate| wire::TallyRateSuggestion {
                    from_exponent: u32::from(minor_units(&rate.from_currency)),
                    from_currency: rate.from_currency,
                    to_currency: rate.to_currency,
                    rate_scaled: rate.rate_scaled,
                    rate_scale: rate.rate_scale,
                    rate_source: rate.rate_source,
                    observed_on: rate.observed_on,
                    expense_id: rate.expense_id,
                })
                .collect(),
        })
    })
}

pub(super) fn group(door: &VaultDoor<'_>, asked: &wire::TallyGroupRequest) -> Result<Answer> {
    answered(door, phone::load_group(door, &asked.group_id), |data| {
        Answer::TallyGroup(wire::TallyGroupLedger {
            me: data.me,
            group: data.group.map(group_meta),
            members: data
                .members
                .into_iter()
                .map(|member| wire::TallyMember {
                    person: Some(person(member.person)),
                    net: Some(money(&member.net)),
                    departed: member.departed,
                })
                .collect(),
            ledger: data.ledger.into_iter().map(entry).collect(),
            settlements: data.settlements.into_iter().map(settlement).collect(),
            simplification: Some(wire::TallySimplification {
                opted_in: data.simplification.opted_in,
                transfers: data
                    .simplification
                    .transfers
                    .into_iter()
                    .map(transfer)
                    .collect(),
                debts_before: count(data.simplification.debts_before),
                payments_after: count(data.simplification.payments_after),
            }),
        })
    })
}

pub(super) fn friend(door: &VaultDoor<'_>, asked: &wire::TallyFriendRequest) -> Result<Answer> {
    answered(door, phone::load_friend(door, &asked.party_id), |data| {
        Answer::TallyFriend(wire::TallyFriendLedger {
            me: data.me,
            friend: data.friend.map(person),
            balances: monies(&data.balances),
            parts: data
                .parts
                .into_iter()
                .map(|part| wire::TallyNetPart {
                    group_id: part.group_id,
                    group_name: part.group_name,
                    net: Some(money(&part.net)),
                })
                .collect(),
            ledger: data.ledger.into_iter().map(entry).collect(),
        })
    })
}

pub(super) fn expense(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::TallyExpenseRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    answered(
        door,
        phone::load_expense(door, &asked.expense_id, now),
        |data| {
            Answer::TallyExpense(wire::TallyExpense {
                expense: data.expense.map(entry),
                purge_on_local: data.purge_at.as_deref().map(|at| day_of(&zone, at)),
                deleted_at: data.deleted_at,
                purge_at: data.purge_at,
                memo: data.memo,
                revisions: data
                    .revisions
                    .into_iter()
                    .map(|revision| wire::TallyRevision {
                        recorded_local: local::now_local(&zone, &revision.recorded_at)
                            .unwrap_or_default(),
                        revision_id: revision.revision_id,
                        operation: revision.operation,
                        recorded_at: revision.recorded_at,
                        undo_until: revision.undo_until,
                        undone_at: revision.undone_at,
                        undoable: revision.undoable,
                        before_description: revision.before_description,
                        before_amount: revision.before_amount.as_ref().map(money),
                    })
                    .collect(),
            })
        },
    )
}

pub(super) fn settle_up(
    door: &VaultDoor<'_>,
    asked: &wire::TallySettleUpRequest,
) -> Result<Answer> {
    let only = super::non_empty(&asked.group_id);
    answered(door, phone::load_settle_up(door, only), |data| {
        Answer::TallySettleUp(wire::TallySettleUp {
            me: data.me,
            suggestions: data.suggestions.into_iter().map(transfer).collect(),
        })
    })
}

pub(super) fn recurring(door: &VaultDoor<'_>) -> Result<Answer> {
    answered(door, phone::load_recurring(door), |templates| {
        Answer::TallyRecurring(wire::TallyRecurring {
            templates: templates
                .into_iter()
                .map(|template| wire::TallyRecurringTemplate {
                    schedule: centraid_vault::time::rrule::describe(&template.rrule),
                    template_id: template.template_id,
                    group_id: template.group_id,
                    group_name: template.group_name,
                    description: template.description,
                    amount: Some(money(&template.amount)),
                    settlement_currency: template.settlement_currency,
                    paid_by: Some(person(template.paid_by)),
                    category: template.category,
                    rrule: template.rrule,
                    anchor_start: template.anchor_start,
                    tz: template.tz,
                    status: template.status,
                    last_materialized_start: template.last_materialized_start,
                })
                .collect(),
        })
    })
}

pub(super) fn spending(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::TallySpendingRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let today = today(&zone, now)?;
    let month = match super::non_empty(asked.month.trim()) {
        None => today.get(..7).unwrap_or_default().to_owned(),
        Some(month) if phone::is_month(month) => month.to_owned(),
        Some(month) => {
            return Err(CoreError::InvalidRequest {
                detail: format!("`{month}` is not a month; tally.spending takes `YYYY-MM`"),
            });
        }
    };
    answered(door, phone::load_spending(door, &month), |data| {
        Answer::TallySpending(wire::TallySpending {
            month: data.month,
            today,
            categories: data
                .categories
                .into_iter()
                .map(|total| wire::TallyCategoryTotal {
                    category: total.category,
                    total: Some(money(&total.total)),
                })
                .collect(),
            month_total: monies(&data.month_total),
            paid: monies(&data.paid),
            share: monies(&data.share),
            difference: monies(&data.difference),
        })
    })
}

pub(super) fn search(door: &VaultDoor<'_>, asked: &wire::TallySearchRequest) -> Result<Answer> {
    if asked.limit == 0 {
        // REQUIRED AND VALIDATED, not defaulted (`agenda.search`'s rule).
        return Err(CoreError::InvalidRequest {
            detail: "a tally search carries no limit; a default is how an unbounded read gets \
                     written by accident"
                .to_owned(),
        });
    }
    let limit = usize::try_from(asked.limit).unwrap_or(usize::MAX);
    answered(door, phone::load_search(door, &asked.term, limit), |data| {
        Answer::TallySearch(wire::TallySearch {
            total_matches: count(data.total_matches),
            results: data.results.into_iter().map(entry).collect(),
        })
    })
}

pub(super) fn trash(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::TallyTrashRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    answered(door, phone::load_trash(door), |rows| {
        Answer::TallyTrash(wire::TallyTrash {
            rows: rows
                .into_iter()
                .map(|row| wire::TallyTrashRow {
                    deleted_on_local: day_of(&zone, &row.deleted_at),
                    purge_on_local: row.purge_at.as_deref().map(|at| day_of(&zone, at)),
                    expense_id: row.expense_id,
                    description: row.description,
                    amount: Some(money(&row.amount)),
                    group_id: row.group_id,
                    group_name: row.group_name,
                    spent_on: row.spent_on,
                    deleted_at: row.deleted_at,
                    purge_at: row.purge_at,
                })
                .collect(),
        })
    })
}

pub(super) fn export(door: &VaultDoor<'_>, asked: &wire::TallyExportRequest) -> Result<Answer> {
    let limit = (asked.limit > 0).then(|| i64::from(asked.limit));
    let since = super::non_empty(asked.since.trim());
    answered(
        door,
        phone::load_export(door, &asked.group_id, since, limit),
        |data| {
            Answer::TallyExport(wire::TallyExport {
                group: data.group.map(group_meta),
                members: data.members.into_iter().map(person).collect(),
                expenses: data.expenses.into_iter().map(entry).collect(),
                settlements: data.settlements.into_iter().map(settlement).collect(),
                revisions: data
                    .revisions
                    .into_iter()
                    .map(|revision| wire::TallyExportRevision {
                        revision_id: revision.revision_id,
                        expense_id: revision.expense_id,
                        operation: revision.operation,
                        recorded_at: revision.recorded_at,
                        undone_at: revision.undone_at,
                    })
                    .collect(),
                truncated: data.truncated,
                limit: u32::try_from(data.limit).unwrap_or(u32::MAX),
                since: data.since,
                expenses_in_window: count(data.expenses_in_window),
                settlements_in_window: count(data.settlements_in_window),
            })
        },
    )
}

// ---------------------------------------------------------------------------
// The conversion. ONE place, so a field that moved is one edit.
// ---------------------------------------------------------------------------

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// THE ONE PLACE A TALLY FIGURE GETS ITS EXPONENT.
fn money(amount: &Money) -> wire::TallyMoney {
    let currency = amount.currency.code();
    wire::TallyMoney {
        minor: amount.amount_minor,
        currency: currency.to_owned(),
        exponent: u32::from(minor_units(currency)),
    }
}

fn monies(amounts: &[Money]) -> Vec<wire::TallyMoney> {
    amounts.iter().map(money).collect()
}

fn person(person: Person) -> wire::TallyPerson {
    wire::TallyPerson {
        party_id: person.party_id,
        name: person.name,
        color: person.color,
        initials: person.initials,
        is_me: person.is_me,
    }
}

fn role(role: Role) -> i32 {
    (match role {
        Role::Lent => wire::TallyRole::Lent,
        Role::Borrowed => wire::TallyRole::Borrowed,
        Role::None => wire::TallyRole::None,
    }) as i32
}

fn figure(figure: phone::Figure) -> wire::TallyValuation {
    wire::TallyValuation {
        valued: figure.valued,
        total: figure.total.as_ref().map(money),
        components: monies(&figure.components),
    }
}

fn share(share: phone::Share) -> wire::TallyShare {
    wire::TallyShare {
        amount: Some(money(&share.amount)),
        person: Some(person(share.person)),
    }
}

fn entry(entry: Entry) -> wire::TallyExpenseRow {
    wire::TallyExpenseRow {
        expense_id: entry.expense_id,
        group_id: entry.group_id,
        group_name: entry.group_name,
        description: entry.description,
        amount: Some(money(&entry.amount)),
        category: entry.category,
        spent_on: entry.spent_on,
        paid_by: Some(person(entry.paid_by)),
        split_method: entry.split_method,
        split_params: entry.split_params.map(|params| wire::TallySplitParams {
            unit: params.unit,
            entries: params
                .entries
                .into_iter()
                .map(|(party_id, value)| wire::TallySplitParam { party_id, value })
                .collect(),
        }),
        payers: entry.payers.into_iter().map(share).collect(),
        splits: entry.splits.into_iter().map(share).collect(),
        lines: entry
            .lines
            .into_iter()
            .map(|line| wire::TallyLine {
                line_item_id: line.line_item_id,
                kind: line.kind,
                description: line.description,
                amount: Some(money(&line.amount)),
                allocations: line.allocations.into_iter().map(share).collect(),
            })
            .collect(),
        your_role: role(entry.your_role),
        your_amount: Some(money(&entry.your_amount)),
        rate: entry.rate.map(|rate| wire::TallyRate {
            original: Some(money(&rate.original)),
            rate_scaled: rate.rate_scaled,
            rate_scale: rate.rate_scale,
            rate_source: rate.rate_source,
            rate_date: rate.rate_date,
        }),
        recurring_template_id: entry.recurring_template_id,
    }
}

fn settlement(row: phone::Settlement) -> wire::TallySettlementRow {
    wire::TallySettlementRow {
        settlement_id: row.settlement_id,
        group_id: row.group_id,
        from: Some(person(row.from)),
        to: Some(person(row.to)),
        amount: Some(money(&row.amount)),
        paid_on: row.paid_on,
    }
}

fn transfer(suggestion: phone::Suggestion) -> wire::TallyTransfer {
    wire::TallyTransfer {
        from: Some(person(suggestion.from)),
        to: Some(person(suggestion.to)),
        amount: Some(money(&suggestion.amount)),
        group_id: suggestion.group_id,
    }
}

fn group_card(card: phone::GroupCard) -> wire::TallyGroupCard {
    wire::TallyGroupCard {
        group_id: card.group_id,
        name: card.name,
        icon: card.icon,
        color: card.color,
        member_count: count(card.member_count),
        your_net: Some(money(&card.your_net)),
        simplify_opt_in: card.simplify_opt_in,
        archived_at: card.archived_at,
    }
}

fn group_meta(meta: phone::GroupMeta) -> wire::TallyGroup {
    wire::TallyGroup {
        group_id: meta.group_id,
        name: meta.name,
        icon: meta.icon,
        color: meta.color,
        currency: meta.currency,
        simplify_opt_in: meta.simplify_opt_in,
        archived_at: meta.archived_at,
    }
}

fn activity(row: Activity) -> wire::TallyActivityRow {
    use wire::tally_activity_row::Row as R;
    wire::TallyActivityRow {
        row: Some(match row {
            Activity::Expense(expense) => R::Expense(wire::TallyActivityExpense {
                expense_id: expense.expense_id,
                group_id: expense.group_id,
                group_name: expense.group_name,
                date: expense.date,
                description: expense.description,
                category: expense.category,
                paid_by: Some(person(expense.paid_by)),
                amount: Some(money(&expense.amount)),
                your_role: role(expense.your_role),
                your_amount: Some(money(&expense.your_amount)),
            }),
            Activity::Settlement(row) => R::Settlement(settlement(row)),
        }),
    }
}

#[cfg(test)]
#[path = "tally_tests.rs"]
mod tests;
