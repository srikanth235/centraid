//! THE EIGHT QUERY ANSWERS, ported handler for handler.
//!
//! `queries.rs` holds the statements and the fold of ground facts; this module
//! holds what each of the eight manifest queries ANSWERS with — the values
//! `contracts/apps/tally/queries.json` carries at 29 fixed inputs. Every one is
//! a pure function of [`TallyData`] plus, for the three that read planes
//! `loadTally` does not, a [`PageDoor`].
//!
//! ## What is deliberate here
//!
//! - **A denial is a value, never an `Err`** (law 3). v0 wraps each handler in
//!   a `try/catch` and answers the empty shape plus `vaultDenied`; in Rust the
//!   door's error travels up and the SURFACE decides, so each answer here has
//!   an explicit empty answer per query — `group` with a null group,
//!   `search_empty` — rather than an `Option` that collapses "no data" into
//!   "not allowed".
//! - **Presentation comes from `crates/design`**, not from a second hue wheel:
//!   a party's colour and initials are the lowering asserted row by row against
//!   `packages/design` (#1020, D-1020-T1).
//! - **No formatting.** Not one `format_money`: v0's handlers answer minor
//!   units and currency codes, and the string is the surface's.
//! - **Two recurrence-derived fields are not ported** and say so by name
//!   ([`RECURRENCE_DEFERRED`]): `preview` and `next_start` come from
//!   `ctx.time.describeRecurrence` / `expandRecurrence`, i.e. v0's 1,400-line
//!   civil-time plane (`packages/core/src/time/`), which belongs to the
//!   schedule lane. A minimal RRULE expander written here for one field would
//!   be a SECOND recurrence engine, which is the thing the one-adapter ruling
//!   (#996, R21; drift ONT-25) exists to prevent.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::money::{Money, MoneyBag, Valuation, money, valuate};
use centraid_apps_kit::reads::{PageDoor, read_pages};
use centraid_apps_kit::row::{Row, integer_or_zero, text_of};
use serde_json::{Value, json};

use crate::balance::{
    Simplification, attribute_expense, expense_payers, group_net, simplification,
};
use crate::queries::{
    EXCEPTION_ROWS, ExpenseRow, LEDGER_FAN_OUT, MATCH_SCAN_ROWS, MATCH_WINDOW_DAYS, Person,
    TallyData, export_revisions_statement, history_statement, load_dashboard_extras, load_tally,
    match_accounts_statement, match_decisions_statement, match_transactions_statement,
};

/// The two fields of a `recurring` row this port does not compute, and the one
/// place they are named.
///
/// Both are answers of v0's civil-time plane, not of Tally: `preview` is
/// `describeRecurrence(rrule)` and `next_start` is the first instance of
/// `expandRecurrence` after the exceptions are applied. The parity suite
/// asserts they are PRESENT in the fixture and compares every other field, so
/// the deferral cannot hide a regression in the fields that are ported.
pub const RECURRENCE_DEFERRED: [&str; 2] = ["next_start", "preview"];

/// The export's own window (`queries/export.ts:17-18`).
pub const EXPORT_DEFAULT_LIMIT: i64 = 500;
pub const EXPORT_MAX_LIMIT: i64 = 2_000;

// ---------------------------------------------------------------------------
// Presentation, shared by every ledger row.
// ---------------------------------------------------------------------------

/// A party, resolved. An id the read never named is still nameable — as
/// "Someone", in its own hue (`queries/dashboard.ts:988`).
#[must_use]
pub fn person_of(data: &TallyData, party_id: &str) -> Person {
    data.people
        .get(party_id)
        .cloned()
        .unwrap_or_else(|| Person {
            party_id: party_id.to_owned(),
            name: "Someone".to_owned(),
            color: centraid_design::party_color(party_id),
            initials: centraid_design::identity_initials("Someone"),
            is_me: false,
        })
}

fn money_json(amount: &Money) -> Value {
    json!({ "amount_minor": amount.amount_minor, "currency": amount.currency.code() })
}

fn bag_json(bag: &MoneyBag) -> Value {
    Value::Array(bag.entries().iter().map(money_json).collect())
}

/// A valuation, in v0's two shapes (`packages/core/src/money/index.ts:136-148`).
///
/// `unavailable` carries the COMPONENTS, because the several amounts are what
/// is true when no rate exists — never a sum nobody computed (#996, R22).
fn valuation_json(valuation: &Valuation) -> Value {
    match valuation {
        Valuation::Valued {
            total, components, ..
        } => json!({
            "state": "valued",
            "total": money_json(total),
            "rates": Value::Array(Vec::new()),
            "components": bag_json(components),
        }),
        Valuation::Unavailable {
            reason,
            currencies,
            components,
        } => json!({
            "state": "unavailable",
            "reason": reason,
            "currencies": Value::Array(
                currencies
                    .iter()
                    .map(|currency| Value::String(currency.code().to_owned()))
                    .collect(),
            ),
            "components": bag_json(components),
        }),
    }
}

fn optional(text: Option<&str>) -> Value {
    text.map_or(Value::Null, |value| Value::String(value.to_owned()))
}

fn person_json(person: &Person, amount_key: &str, amount: i64) -> Value {
    json!({
        "party_id": person.party_id,
        "name": person.name,
        "color": person.color,
        "initials": person.initials,
        amount_key: amount,
    })
}

/// The owner's stance on one expense, and the figure that goes with it.
///
/// Three states, not two: `lent` when the owner put money down, `borrowed`
/// when they only owe a share, and `none` when the expense is not theirs at all
/// — and in that last case the figure is the WHOLE amount, because there is no
/// share of it to name (`queries/dashboard.ts:778-790`).
fn owner_stance(data: &TallyData, expense: &ExpenseRow) -> (&'static str, i64) {
    let my_share = data
        .me
        .as_deref()
        .and_then(|me| {
            data.splits
                .get(&expense.expense_id)
                .and_then(|splits| splits.get(me))
        })
        .copied();
    let your_share = my_share.unwrap_or(0);
    let payers = balance_expense(data, expense);
    let you_paid = data
        .me
        .as_deref()
        .and_then(|me| {
            expense_payers(&payers)
                .into_iter()
                .find(|(party, _)| party == me)
                .map(|(_, paid)| paid)
        })
        .unwrap_or(0);
    if you_paid > 0 {
        ("lent", you_paid - your_share)
    } else if my_share.is_some() {
        ("borrowed", your_share)
    } else {
        ("none", expense.amount_minor)
    }
}

fn balance_expense(data: &TallyData, expense: &ExpenseRow) -> crate::balance::BalanceExpense {
    crate::balance::BalanceExpense {
        group_id: expense.group_id.clone(),
        paid_by: expense.paid_by.clone(),
        amount_minor: expense.amount_minor,
        splits: data
            .splits
            .get(&expense.expense_id)
            .cloned()
            .unwrap_or_default(),
        payers: data
            .payers
            .get(&expense.expense_id)
            .cloned()
            .unwrap_or_default(),
    }
}

/// The typed lines of one expense, decorated with the names their allocations
/// name. Lines hang off the EXPENSE and a receipt is an optional decoration, so
/// the "By line" division has typed lines and no photo.
fn line_items_json(data: &TallyData, expense_id: &str) -> Value {
    Value::Array(
        data.lines
            .get(expense_id)
            .map(|lines| {
                lines
                    .iter()
                    .map(|line| {
                        json!({
                            "line_item_id": line.line_item_id,
                            "kind": line.kind,
                            "description": line.description,
                            "amount_minor": line.amount_minor,
                            "sort_order": line.sort_order,
                            "allocations": Value::Array(
                                line.allocations
                                    .iter()
                                    .map(|(party_id, share)| json!({
                                        "party_id": party_id,
                                        "name": person_of(data, party_id).name,
                                        "share_minor": share,
                                    }))
                                    .collect(),
                            ),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// A LEDGER ROW: the expense as every ledger surface renders it
/// (`queries/dashboard.ts:770-860`).
///
/// **The seven columns that read as defaults are v0's own missing projection**,
/// not this port's shortcut — `expenses_statement`'s note has the whole
/// finding. `settlement_currency` reads the vault's BASE money and
/// `rate_source` reads `"identity"` because the dashboard's statement never
/// selects the stored values.
#[must_use]
pub fn ledger_row(data: &TallyData, expense: &ExpenseRow) -> Value {
    let (your_role, your_amount_minor) = owner_stance(data, expense);
    let payers = expense_payers(&balance_expense(data, expense));
    let splits = data
        .splits
        .get(&expense.expense_id)
        .cloned()
        .unwrap_or_default();
    json!({
        "expense_id": expense.expense_id,
        "group_id": optional(expense.group_id.as_deref()),
        "description": expense.description,
        "amount_minor": expense.amount_minor,
        // `?? e.amount_minor`, over a column the statement does not select.
        "original_amount_minor": expense.amount_minor,
        "original_currency": data.currency,
        "settlement_currency": data.currency,
        // The identity rate, for the same reason: 1.000000, from "identity".
        "rate_scaled": 1_000_000,
        "rate_scale": 6,
        "rate_source": "identity",
        "rate_date": expense.spent_on,
        "recurring_template_id": Value::Null,
        "category": expense.category,
        "spent_on": expense.spent_on,
        "paid_by": expense.paid_by,
        "paid_by_name": person_of(data, &expense.paid_by).name,
        "split_method": expense.split_method,
        // How the shares were arrived at, so an edit re-opens the way it was
        // entered rather than collapsing every division to exact amounts.
        "split_params": expense
            .split_params_json
            .as_deref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .unwrap_or(Value::Null),
        "payers": Value::Array(
            payers
                .iter()
                .map(|(party_id, paid)| person_json(&person_of(data, party_id), "paid_minor", *paid))
                .collect(),
        ),
        "line_items": line_items_json(data, &expense.expense_id),
        "your_role": your_role,
        "your_amount_minor": your_amount_minor,
        "splits": Value::Array(
            splits
                .iter()
                .map(|(party_id, share)| {
                    person_json(&person_of(data, party_id), "share_minor", *share)
                })
                .collect(),
        ),
    })
}

// ---------------------------------------------------------------------------
// 1. dashboard
// ---------------------------------------------------------------------------

/// A group card for the lists, archived or not. The owner's position is in the
/// GROUP's money (#996, R22) — a group is one ledger, in one currency.
fn group_card(data: &TallyData, group_id: &str) -> Value {
    let group = data
        .groups
        .iter()
        .find(|group| group.group_id == group_id)
        .expect("a card is built for a group the read returned");
    let net = group_net(&data.balance_data(), group_id);
    let owner_net = data
        .me
        .as_deref()
        .and_then(|me| net.get(me).copied())
        .unwrap_or(0);
    json!({
        "group_id": group.group_id,
        "name": group.name,
        "icon": group.icon,
        "color": group.color,
        "member_count": data.members_by_group.get(group_id).map_or(0, Vec::len),
        "owner_net": money_json(&money(owner_net, &data.group_currency(group_id))),
        "simplify_opt_in": group.simplify_opt_in,
        "archived_at": optional(group.archived_at.as_deref()),
    })
}

/// Every friend's position, per currency, as `pairwise` folds it.
///
/// BALANCES ARE KEYED `(party, currency)` (#996, ruling R22; drift ONT-23): a
/// friend you owe EUR 100 and USD 100 is TWO amounts, and no addition across
/// the two of them is even expressible.
#[must_use]
pub fn pairwise(data: &TallyData) -> BTreeMap<String, MoneyBag> {
    let me = data.me.clone().unwrap_or_default();
    let mut bags: BTreeMap<String, MoneyBag> = data
        .friends
        .iter()
        .map(|party_id| (party_id.clone(), MoneyBag::empty()))
        .collect();
    let add = |party_id: &str, amount: Money, bags: &mut BTreeMap<String, MoneyBag>| {
        let held = bags.get(party_id).cloned().unwrap_or_else(MoneyBag::empty);
        bags.insert(party_id.to_owned(), held.plus(amount));
    };
    for expense in &data.expenses {
        let currency = data.expense_currency(expense);
        // With several payers a share is owed to each of them for the part they
        // actually put down, so the owner's position is their own slice of it —
        // never the whole share to whoever happened to be named `paid_by`.
        for attribution in attribute_expense(&balance_expense(data, expense)) {
            if attribution.from == attribution.to {
                continue;
            }
            if attribution.to == me && attribution.from != me {
                add(
                    &attribution.from.clone(),
                    money(attribution.amount_minor, &currency),
                    &mut bags,
                );
            } else if attribution.from == me && attribution.to != me {
                add(
                    &attribution.to.clone(),
                    money(-attribution.amount_minor, &currency),
                    &mut bags,
                );
            }
        }
    }
    for settlement in &data.settlements {
        let currency = data.settlement_currency(settlement);
        if settlement.from_party == me && settlement.to_party != me {
            add(
                &settlement.to_party.clone(),
                money(settlement.amount_minor, &currency),
                &mut bags,
            );
        } else if settlement.to_party == me && settlement.from_party != me {
            add(
                &settlement.from_party.clone(),
                money(-settlement.amount_minor, &currency),
                &mut bags,
            );
        }
    }
    for obligation in &data.obligations {
        // An obligation carries its own currency and is never group-scoped, so
        // there is nothing else it could inherit.
        let Some(from) = text_of(obligation, "from_party") else {
            continue;
        };
        let Some(to) = text_of(obligation, "to_party") else {
            continue;
        };
        let currency = text_of(obligation, "currency").unwrap_or_default();
        let amount_minor = integer_or_zero(obligation, "amount_minor");
        if from == me && to != me {
            add(&to, money(-amount_minor, &currency), &mut bags);
        } else if to == me && from != me {
            add(&from, money(amount_minor, &currency), &mut bags);
        }
    }
    bags
}

/// The remembered rates, one per currency pair
/// (`queries/dashboard.ts:906-936`).
///
/// **Always empty against v0's dashboard read**, and that is the finding, not
/// the design: the statement selects neither `original_currency` nor
/// `settlement_currency` nor the `rate_*` pair, so every candidate row is
/// discarded on the first check. Ported as the fold it is so that the fix to
/// the projection makes it work on both sides at once.
#[must_use]
pub fn rate_suggestions(data: &TallyData) -> Value {
    let mut latest: BTreeMap<String, Value> = BTreeMap::new();
    for expense in &data.expenses {
        let (Some(from), Some(to)) = (
            expense.original_currency.as_deref(),
            expense.settlement_currency.as_deref(),
        ) else {
            continue;
        };
        if from == to {
            continue;
        }
        let (Some(rate_scaled), Some(rate_scale)) = (expense.rate_scaled, expense.rate_scale)
        else {
            continue;
        };
        let observed_on = expense
            .rate_date
            .clone()
            .unwrap_or_else(|| expense.spent_on.clone());
        let key = format!("{from}>{to}");
        if let Some(held) = latest.get(&key)
            && held["observed_on"].as_str().unwrap_or_default() >= observed_on.as_str()
        {
            continue;
        }
        latest.insert(
            key,
            json!({
                "from_currency": from,
                "to_currency": to,
                "rate_scaled": rate_scaled,
                "rate_scale": rate_scale,
                "rate_source": expense
                    .rate_source
                    .clone()
                    .unwrap_or_else(|| "supplied at entry".to_owned()),
                "rate_date": observed_on,
                "observed_on": observed_on,
                "expense_id": expense.expense_id,
            }),
        );
    }
    Value::Array(latest.into_values().collect())
}

/// `dashboard` — the whole first screen.
pub fn dashboard(door: &dyn PageDoor) -> KitResult<Value> {
    let data = load_tally(door)?;
    let (trash_rows, recurring_rows, exception_rows) = load_dashboard_extras(door)?;
    dashboard_of(&data, &trash_rows, &recurring_rows, &exception_rows)
}

/// The dashboard's fold, over facts already read. Split out so a test can hand
/// it rows without a door.
pub fn dashboard_of(
    data: &TallyData,
    trash_rows: &[Row],
    recurring_rows: &[Row],
    exception_rows: &[Row],
) -> KitResult<Value> {
    let bags = pairwise(data);
    let friends = Value::Array(
        data.friends
            .iter()
            .map(|party_id| {
                let person = person_of(data, party_id);
                json!({
                    "party_id": party_id,
                    "name": person.name,
                    "color": person.color,
                    "initials": person.initials,
                    "balances": bag_json(bags.get(party_id).unwrap_or(&MoneyBag::empty())),
                })
            })
            .collect(),
    );

    // THE TWO HERO FIGURES ARE VALUATIONS (#996, ruling R22). Each side is a
    // position per currency; turning it into ONE number is a claim that a rate
    // exists, and the vault has no rate plane, so `valuate` answers
    // `unavailable` with the components rather than adding EUR to USD.
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
    let owe = valuate(&owe, &data.currency, &[])?;
    let owed = valuate(&owed, &data.currency, &[])?;

    // Archived groups leave the default lists and keep everything, so they
    // travel in their own array rather than being filtered into silence.
    let groups = Value::Array(
        data.groups
            .iter()
            .filter(|group| group.archived_at.is_none())
            .map(|group| group_card(data, &group.group_id))
            .collect(),
    );
    let archived = Value::Array(
        data.groups
            .iter()
            .filter(|group| group.archived_at.is_some())
            .map(|group| group_card(data, &group.group_id))
            .collect(),
    );
    let group_names: BTreeMap<&str, &str> = data
        .groups
        .iter()
        .map(|group| (group.group_id.as_str(), group.name.as_str()))
        .collect();

    let trash = Value::Array(
        trash_rows
            .iter()
            .map(|row| {
                json!({
                    "expense_id": text_of(row, "expense_id").unwrap_or_default(),
                    "description": text_of(row, "description")
                        .unwrap_or_else(|| "Expense".to_owned()),
                    "amount_minor": integer_or_zero(row, "amount_minor"),
                    // "Group", not an empty string: a trashed expense whose
                    // group is gone still has to name where it came from.
                    "group_name": text_of(row, "group_id")
                        .and_then(|group_id| group_names.get(group_id.as_str()).map(|name| (*name).to_owned()))
                        .unwrap_or_else(|| "Group".to_owned()),
                    "deleted_at": text_of(row, "deleted_at").unwrap_or_default(),
                    "purge_at": optional(text_of(row, "purge_at").as_deref()),
                })
            })
            .collect(),
    );

    // The exceptions are READ and the expansion is not ported: see
    // `RECURRENCE_DEFERRED`. The window is still walked, because the read is
    // this lane's and the ceiling is the thing a port gets wrong.
    debug_assert!(exception_rows.len() <= EXCEPTION_ROWS);
    let recurring = Value::Array(
        recurring_rows
            .iter()
            .map(|row| {
                json!({
                    "template_id": text_of(row, "template_id").unwrap_or_default(),
                    "group_id": optional(text_of(row, "group_id").as_deref()),
                    "description": text_of(row, "description").unwrap_or_default(),
                    "original_amount_minor": integer_or_zero(row, "original_amount_minor"),
                    "original_currency": text_of(row, "original_currency").unwrap_or_default(),
                    "settlement_currency": optional(text_of(row, "settlement_currency").as_deref()),
                    "paid_by": text_of(row, "paid_by").unwrap_or_default(),
                    "category": text_of(row, "category").unwrap_or_default(),
                    "rrule": text_of(row, "rrule").unwrap_or_default(),
                    "anchor_start": text_of(row, "anchor_start").unwrap_or_default(),
                    "tz": text_of(row, "tz").unwrap_or_default(),
                    "rate_scaled": optional_number(row, "rate_scaled"),
                    "rate_scale": optional_number(row, "rate_scale"),
                    "rate_source": optional(text_of(row, "rate_source").as_deref()),
                    "rate_date": optional(text_of(row, "rate_date").as_deref()),
                    "status": text_of(row, "status").unwrap_or_default(),
                    "last_materialized_start": optional(
                        text_of(row, "last_materialized_start").as_deref(),
                    ),
                })
            })
            .collect(),
    );

    Ok(json!({
        "me": optional(data.me.as_deref()),
        "currency": data.currency,
        "friends": friends,
        "groups": groups,
        "archived_groups": archived,
        "trash": trash,
        "recurring": recurring,
        "owe": valuation_json(&owe),
        "owed": valuation_json(&owed),
        // The two counts the Balances hero states its arithmetic from, over the
        // same bounded window every figure on this screen came from.
        "expense_count": data.expenses.len(),
        "settlement_count": data.settlements.len(),
        "rate_suggestions": rate_suggestions(data),
        "nudges": Value::Array(
            data.nudges
                .iter()
                .map(|row| json!({
                    "nudge_id": text_of(row, "nudge_id").unwrap_or_default(),
                    "party_id": text_of(row, "party_id").unwrap_or_default(),
                    "group_id": optional(text_of(row, "group_id").as_deref()),
                    "prepared_at": text_of(row, "prepared_at").unwrap_or_default(),
                    "note": optional(text_of(row, "note").as_deref()),
                    // Stated, and always false: Tally has no delivery path.
                    "sent": false,
                }))
                .collect(),
        ),
    }))
}

/// An integer column as JSON, `null` when NULL or never projected.
///
/// The two are one answer HERE and only here: v0 writes `?? null` at this leaf,
/// so a column it did not read and a column that is NULL both reach the surface
/// as `null`. The distinction is kept where it decides an answer (see
/// `queries::optional_integer`) rather than thrown away in the row fold.
fn optional_number(row: &Row, column: &str) -> Value {
    row.get(column)
        .and_then(centraid_apps_kit::row::Cell::integer)
        .map_or(Value::Null, |number| json!(number))
}

// ---------------------------------------------------------------------------
// 2. group
// ---------------------------------------------------------------------------

fn simplification_json(answer: &Simplification) -> Value {
    json!({
        "opted_in": answer.opted_in,
        "transfers": Value::Array(
            answer
                .transfers
                .iter()
                .map(|transfer| json!({
                    "from": transfer.from,
                    "to": transfer.to,
                    "amount": money_json(&transfer.amount),
                }))
                .collect(),
        ),
        "debts_before": answer.debts_before,
        "payments_after": answer.payments_after,
    })
}

/// `group` — one group's meta, its members with derived nets, and its ledger.
///
/// A group that does not exist answers a NULL group and empty lists, never an
/// error: an id from a stale link is not a failure of the vault.
#[must_use]
pub fn group(data: &TallyData, group_id: &str) -> Value {
    let Some(found) = data.groups.iter().find(|group| group.group_id == group_id) else {
        return json!({
            "me": optional(data.me.as_deref()),
            "currency": data.currency,
            "group": Value::Null,
            "members": Value::Array(Vec::new()),
            "ledger": Value::Array(Vec::new()),
            "simplification": json!({
                "opted_in": false,
                "transfers": Value::Array(Vec::new()),
                "debts_before": 0,
                "payments_after": 0,
            }),
        });
    };
    let balances = data.balance_data();
    let net = group_net(&balances, group_id);
    // A GROUP IS ONE LEDGER, IN ONE MONEY (#996, ruling R22): every figure on
    // this screen is in the group's currency, read once here rather than the
    // base currency being assumed at each leaf.
    let currency = data.group_currency(group_id);
    let current: Vec<String> = data
        .members_by_group
        .get(group_id)
        .cloned()
        .unwrap_or_default();
    let roster: BTreeSet<&str> = current.iter().map(String::as_str).collect();
    // A DEPARTED PARTICIPANT IS STILL ON THE SCREEN, marked. Membership is
    // current state and the ledger is history, so a member who left and still
    // owes has to be visible or the group's balance does not add up.
    let participants: Vec<String> = current
        .iter()
        .cloned()
        .chain(
            net.keys()
                .filter(|party_id| !roster.contains(party_id.as_str()))
                .cloned(),
        )
        .collect();
    let members = Value::Array(
        participants
            .iter()
            .map(|party_id| {
                let person = person_of(data, party_id);
                let mut row = json!({
                    "party_id": party_id,
                    "name": person.name,
                    "color": person.color,
                    "initials": person.initials,
                    "is_me": person.is_me,
                    "net": money_json(&money(net.get(party_id).copied().unwrap_or(0), &currency)),
                });
                if !roster.contains(party_id.as_str()) {
                    row["departed"] = Value::Bool(true);
                }
                row
            })
            .collect(),
    );
    json!({
        "me": optional(data.me.as_deref()),
        "currency": data.currency,
        "group": json!({
            "group_id": found.group_id,
            "name": found.name,
            "icon": found.icon,
            "color": found.color,
            "simplify_opt_in": found.simplify_opt_in,
            "archived_at": optional(found.archived_at.as_deref()),
        }),
        "members": members,
        "ledger": Value::Array(
            data.expenses
                .iter()
                .filter(|expense| expense.group_id.as_deref() == Some(group_id))
                .map(|expense| ledger_row(data, expense))
                .collect(),
        ),
        // Derived, never stored: the minimal payment set this ledger implies,
        // plus the counts that say what it rewired. Empty until the group opts
        // in, because simplification changes who owes whom.
        "simplification": simplification_json(&simplification(
            &balances,
            group_id,
            found.simplify_opt_in,
            &currency,
        )),
    })
}

// ---------------------------------------------------------------------------
// 3. friend
// ---------------------------------------------------------------------------

/// The friend's net, broken down by where it came from: one part per group plus
/// "outside any group" for the group-less 1:1 rows.
///
/// EACH PART IS IN ITS GROUP'S MONEY (#996, ruling R22): the parts used to be
/// bare minor units under the vault's base currency, so a EUR part and a USD
/// part looked like the same kind of number.
fn net_parts(data: &TallyData, friend_id: &str) -> Value {
    let Some(me) = data.me.clone() else {
        return Value::Array(Vec::new());
    };
    let mut by_group: BTreeMap<Option<String>, i64> = BTreeMap::new();
    let mut currency_of: BTreeMap<Option<String>, String> = BTreeMap::new();
    let mut note = |group: Option<String>, amount: i64, currency: String| {
        *by_group.entry(group.clone()).or_insert(0) += amount;
        currency_of.entry(group).or_insert(currency);
    };
    for expense in &data.expenses {
        let currency = data.expense_currency(expense);
        for attribution in attribute_expense(&balance_expense(data, expense)) {
            if attribution.from == attribution.to {
                continue;
            }
            if attribution.to == me && attribution.from == friend_id {
                note(
                    expense.group_id.clone(),
                    attribution.amount_minor,
                    currency.clone(),
                );
            } else if attribution.from == me && attribution.to == friend_id {
                note(
                    expense.group_id.clone(),
                    -attribution.amount_minor,
                    currency.clone(),
                );
            }
        }
    }
    for settlement in &data.settlements {
        let currency = data.settlement_currency(settlement);
        if settlement.from_party == me && settlement.to_party == friend_id {
            note(
                settlement.group_id.clone(),
                settlement.amount_minor,
                currency,
            );
        } else if settlement.to_party == me && settlement.from_party == friend_id {
            note(
                settlement.group_id.clone(),
                -settlement.amount_minor,
                currency,
            );
        }
    }
    for obligation in &data.obligations {
        // A standing IOU is never group-scoped, so it lands outside any group.
        let from = text_of(obligation, "from_party").unwrap_or_default();
        let to = text_of(obligation, "to_party").unwrap_or_default();
        let currency = text_of(obligation, "currency").unwrap_or_default();
        let amount = integer_or_zero(obligation, "amount_minor");
        if from == me && to == friend_id {
            note(None, -amount, currency);
        } else if to == me && from == friend_id {
            note(None, amount, currency);
        }
    }
    let group_names: BTreeMap<&str, &str> = data
        .groups
        .iter()
        .map(|group| (group.group_id.as_str(), group.name.as_str()))
        .collect();
    let mut parts: Vec<(String, Value)> = by_group
        .iter()
        .filter(|(_, net)| **net != 0)
        .map(|(group_id, net)| {
            let group_name = match group_id.as_deref() {
                None => "Outside any group".to_owned(),
                Some(id) => group_names
                    .get(id)
                    .map_or_else(|| "Group".to_owned(), |name| (*name).to_owned()),
            };
            let currency =
                currency_of
                    .get(group_id)
                    .cloned()
                    .unwrap_or_else(|| match group_id.as_deref() {
                        None => data.currency.clone(),
                        Some(id) => data.group_currency(id),
                    });
            (
                group_name.clone(),
                json!({
                    "group_id": optional(group_id.as_deref()),
                    "group_name": group_name,
                    "net": money_json(&money(*net, &currency)),
                }),
            )
        })
        .collect();
    parts.sort_by(|left, right| left.0.cmp(&right.0));
    Value::Array(parts.into_iter().map(|(_, part)| part).collect())
}

/// `friend` — one friend's position and the expenses you both took part in.
///
/// The owner is not their own friend, and an id the ledger never named has no
/// friend view: both answer a NULL friend rather than an empty one.
#[must_use]
pub fn friend(data: &TallyData, party_id: &str) -> Value {
    if !data.people.contains_key(party_id) || data.me.as_deref() == Some(party_id) {
        return json!({
            "me": optional(data.me.as_deref()),
            "currency": data.currency,
            "friend": Value::Null,
            "ledger": Value::Array(Vec::new()),
        });
    }
    let person = person_of(data, party_id);
    let bags = pairwise(data);
    let balances = bags.get(party_id).cloned().unwrap_or_else(MoneyBag::empty);
    let me = data.me.clone();
    let ledger = Value::Array(
        data.expenses
            .iter()
            .filter(|expense| {
                let splits = data.splits.get(&expense.expense_id);
                let shares_it = splits.is_some_and(|splits| splits.contains_key(party_id));
                let i_share_it = me
                    .as_deref()
                    .is_some_and(|me| splits.is_some_and(|splits| splits.contains_key(me)));
                // One of the two of us PAID: an expense we both merely share
                // through a third party is not a row in this friendship.
                let one_of_us_paid =
                    expense.paid_by == party_id || me.as_deref() == Some(expense.paid_by.as_str());
                shares_it && i_share_it && one_of_us_paid
            })
            .map(|expense| ledger_row(data, expense))
            .collect(),
    );
    json!({
        "me": optional(me.as_deref()),
        "currency": data.currency,
        "friend": json!({
            "party_id": party_id,
            "name": person.name,
            "color": person.color,
            "initials": person.initials,
            "balances": bag_json(&balances),
            "parts": net_parts(data, party_id),
        }),
        "ledger": ledger,
    })
}

// ---------------------------------------------------------------------------
// 4. activity
// ---------------------------------------------------------------------------

/// `activity` — expenses and settlements interleaved, newest first.
///
/// The sort is STABLE and on the date text alone, exactly as v0's is: two rows
/// on one day keep the order they were folded in, which is the ledger's own.
#[must_use]
pub fn activity(data: &TallyData) -> Value {
    let me = data.me.clone();
    let group_names: BTreeMap<&str, &str> = data
        .groups
        .iter()
        .map(|group| (group.group_id.as_str(), group.name.as_str()))
        .collect();
    let mut rows: Vec<(String, Value)> = Vec::new();
    for expense in &data.expenses {
        let my_share = me.as_deref().and_then(|me| {
            data.splits
                .get(&expense.expense_id)
                .and_then(|splits| splits.get(me))
                .copied()
        });
        let your_share = my_share.unwrap_or(0);
        // NOT `ledgerRow`'s stance: the feed asks who PAID rather than who put
        // money down, so a co-payer who is not `paid_by` reads as borrowing.
        let (your_role, your_amount_minor) = if me.as_deref() == Some(expense.paid_by.as_str()) {
            ("lent", expense.amount_minor - your_share)
        } else if my_share.is_some() {
            ("borrowed", your_share)
        } else {
            ("none", 0)
        };
        rows.push((
            expense.spent_on.clone(),
            json!({
                "kind": "expense",
                // The ids the feed needs to open the expense it names (#872).
                "expense_id": expense.expense_id,
                "group_id": optional(expense.group_id.as_deref()),
                "date": expense.spent_on,
                "description": expense.description,
                "category": expense.category,
                // A group-less 1:1 expense names no group, and says so by
                // omission rather than by a placeholder.
                "group_name": expense
                    .group_id
                    .as_deref()
                    .map_or_else(String::new, |id| {
                        group_names.get(id).map_or_else(String::new, |name| (*name).to_owned())
                    }),
                "paid_by": expense.paid_by,
                "paid_by_name": person_of(data, &expense.paid_by).name,
                "amount_minor": expense.amount_minor,
                "your_role": your_role,
                "your_amount_minor": your_amount_minor,
            }),
        ));
    }
    for settlement in &data.settlements {
        rows.push((
            settlement.paid_on.clone().unwrap_or_default(),
            json!({
                "kind": "settlement",
                "date": optional(settlement.paid_on.as_deref()),
                "from_party": settlement.from_party,
                "from_name": person_of(data, &settlement.from_party).name,
                "to_party": settlement.to_party,
                "to_name": person_of(data, &settlement.to_party).name,
                "amount_minor": settlement.amount_minor,
            }),
        ));
    }
    rows.sort_by(|left, right| right.0.cmp(&left.0));
    Value::Array(rows.into_iter().map(|(_, row)| row).collect())
}

/// `activity`'s whole answer.
#[must_use]
pub fn activity_view(data: &TallyData) -> Value {
    json!({
        "me": optional(data.me.as_deref()),
        "currency": data.currency,
        "activity": activity(data),
    })
}

// ---------------------------------------------------------------------------
// 5. search
// ---------------------------------------------------------------------------

/// `search` — match expenses by description over the bounded window.
///
/// An EMPTY term answers before reading anything: `me` is null and the currency
/// is the fallback, because nothing was read to know either. That is v0's
/// answer and it is also the honest one — a search for nothing is not a denial.
#[must_use]
pub fn search_empty() -> Value {
    json!({ "me": Value::Null, "currency": "USD", "results": Value::Array(Vec::new()) })
}

#[must_use]
pub fn search(data: &TallyData, term: &str) -> Value {
    let needle = term.trim().to_lowercase();
    if needle.is_empty() {
        return search_empty();
    }
    let group_names: BTreeMap<&str, &str> = data
        .groups
        .iter()
        .map(|group| (group.group_id.as_str(), group.name.as_str()))
        .collect();
    json!({
        "me": optional(data.me.as_deref()),
        "currency": data.currency,
        "results": Value::Array(
            data.expenses
                .iter()
                .filter(|expense| expense.description.to_lowercase().contains(&needle))
                .map(|expense| {
                    let mut row = ledger_row(data, expense);
                    row["group_name"] = Value::String(
                        expense.group_id.as_deref().map_or_else(String::new, |id| {
                            group_names.get(id).map_or_else(String::new, |name| (*name).to_owned())
                        }),
                    );
                    row
                })
                .collect(),
        ),
    })
}

// ---------------------------------------------------------------------------
// 6. export
// ---------------------------------------------------------------------------

/// The export's asked-for window, clamped the way v0 clamps it.
///
/// `0` and a non-number both read as the DEFAULT rather than as "none": a
/// malformed limit must not produce an empty file (`queries/export.ts:44-48`).
#[must_use]
pub fn export_limit(asked: Option<i64>) -> i64 {
    let wanted = match asked {
        None | Some(0) => EXPORT_DEFAULT_LIMIT,
        Some(value) => value,
    };
    wanted.clamp(1, EXPORT_MAX_LIMIT)
}

/// `export` — the group's ledger as a file, BALANCES EXCLUDED BY DESIGN.
///
/// A balance is arithmetic over ground facts, and shipping one would be the
/// first stored balance in the app. The window is bounded and STATED, so a
/// partial export is never read as a whole one.
pub fn export_view(
    door: &dyn PageDoor,
    data: &TallyData,
    group_id: &str,
    since: Option<&str>,
    limit: i64,
) -> KitResult<Value> {
    let floor = since.and_then(crate::queries::floor_date);
    let empty_window = json!({
        "limit": limit,
        "since": optional(floor),
        "expenses": 0,
        "settlements": 0,
    });
    let Some(group) = data.groups.iter().find(|group| group.group_id == group_id) else {
        return Ok(json!({
            "group": Value::Null,
            "expenses": Value::Array(Vec::new()),
            "settlements": Value::Array(Vec::new()),
            "revisions": Value::Array(Vec::new()),
            "balances_excluded": true,
            "truncated": false,
            "window": empty_window,
        }));
    };
    // An expense ranges by the day it was SPENT, a settlement by the day it was
    // PAID; revisions follow the expenses they edited.
    let scoped: Vec<&ExpenseRow> = data
        .expenses
        .iter()
        .filter(|expense| {
            expense.group_id.as_deref() == Some(group_id)
                && crate::queries::on_or_after(Some(expense.spent_on.as_str()), floor)
        })
        .collect();
    let settlements: Vec<&crate::queries::SettlementRow> = data
        .settlements
        .iter()
        .filter(|settlement| {
            settlement.group_id.as_deref() == Some(group_id)
                && crate::queries::on_or_after(settlement.paid_on.as_deref(), floor)
        })
        .collect();
    let taken = usize::try_from(limit).unwrap_or(usize::MAX);
    let expenses: Vec<&ExpenseRow> = scoped.iter().take(taken).copied().collect();
    let name_of = |party_id: &str| -> String {
        data.people
            .get(party_id)
            .map_or_else(|| "Someone".to_owned(), |person| person.name.clone())
    };

    let exported: Vec<String> = expenses
        .iter()
        .map(|expense| expense.expense_id.clone())
        .collect();
    let revision_rows = if exported.is_empty() {
        Vec::new()
    } else {
        read_pages(
            door,
            &export_revisions_statement(&exported)?,
            LEDGER_FAN_OUT,
        )?
    };
    let currency = data.group_currency(group_id);

    Ok(json!({
        "group": json!({
            "group_id": group.group_id,
            "name": group.name,
            "icon": group.icon,
            "color": group.color,
            "archived_at": optional(group.archived_at.as_deref()),
            "members": Value::Array(
                data.members_by_group
                    .get(group_id)
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|party_id| json!({ "party_id": party_id, "name": name_of(party_id) }))
                    .collect(),
            ),
        }),
        // AN EXPORT IS IN THE GROUP'S MONEY (#996, ruling R22; drift ONT-23).
        "currency": currency,
        "expenses": Value::Array(
            expenses
                .iter()
                .map(|expense| {
                    let expense_currency = data.expense_currency(expense);
                    json!({
                        "expense_id": expense.expense_id,
                        "description": expense.description,
                        "amount_minor": expense.amount_minor,
                        "original_amount_minor": expense.amount_minor,
                        "original_currency": expense_currency,
                        "settlement_currency": expense_currency,
                        "rate_scaled": Value::Null,
                        "rate_scale": Value::Null,
                        "rate_source": Value::Null,
                        "rate_date": Value::Null,
                        "category": expense.category,
                        "spent_on": expense.spent_on,
                        "split_method": expense.split_method,
                        "paid_by": expense.paid_by,
                        "paid_by_name": name_of(&expense.paid_by),
                        "payers": Value::Array(
                            data.payers
                                .get(&expense.expense_id)
                                .cloned()
                                .unwrap_or_default()
                                .iter()
                                .map(|(party_id, paid)| json!({
                                    "party_id": party_id,
                                    "name": name_of(party_id),
                                    "paid_minor": paid,
                                }))
                                .collect(),
                        ),
                        "splits": Value::Array(
                            data.splits
                                .get(&expense.expense_id)
                                .cloned()
                                .unwrap_or_default()
                                .iter()
                                .map(|(party_id, share)| json!({
                                    "party_id": party_id,
                                    "name": name_of(party_id),
                                    "share_minor": share,
                                }))
                                .collect(),
                        ),
                        "line_items": Value::Array(
                            data.lines
                                .get(&expense.expense_id)
                                .cloned()
                                .unwrap_or_default()
                                .iter()
                                .map(|line| json!({
                                    "kind": line.kind,
                                    "description": line.description,
                                    "amount_minor": line.amount_minor,
                                    "allocations": Value::Array(
                                        line.allocations
                                            .iter()
                                            .map(|(party_id, share)| json!({
                                                "party_id": party_id,
                                                "name": name_of(party_id),
                                                "share_minor": share,
                                            }))
                                            .collect(),
                                    ),
                                }))
                                .collect(),
                        ),
                        // No attachment plane in this port: Tally is
                        // record-only (`docs/blueprint-seats.md` S2), and the
                        // receipt's bytes are the media lane's.
                        "has_receipt": false,
                    })
                })
                .collect(),
        ),
        "settlements": Value::Array(
            settlements
                .iter()
                .take(taken)
                .map(|settlement| json!({
                    "from_party": settlement.from_party,
                    "from_name": name_of(&settlement.from_party),
                    "to_party": settlement.to_party,
                    "to_name": name_of(&settlement.to_party),
                    "amount_minor": settlement.amount_minor,
                    // What was PAID, in the money it was paid in — never the
                    // reader's base (#996, R22).
                    "currency": settlement
                        .currency
                        .clone()
                        .unwrap_or_else(|| currency.clone()),
                    "paid_on": optional(settlement.paid_on.as_deref()),
                }))
                .collect(),
        ),
        "revisions": Value::Array(
            revision_rows
                .iter()
                .map(|row| json!({
                    "revision_id": text_of(row, "revision_id").unwrap_or_default(),
                    "expense_id": text_of(row, "entity_id").unwrap_or_default(),
                    "operation": text_of(row, "operation").unwrap_or_default(),
                    "recorded_at": text_of(row, "recorded_at").unwrap_or_default(),
                    "undone_at": optional(text_of(row, "undone_at").as_deref()),
                }))
                .collect(),
        ),
        // Stated, not implied: a reader must not go looking for a total.
        "balances_excluded": true,
        "truncated": scoped.len() > taken || settlements.len() > taken,
        "window": json!({
            "limit": limit,
            "since": optional(floor),
            "expenses": scoped.len(),
            "settlements": settlements.len(),
        }),
    }))
}

// ---------------------------------------------------------------------------
// 7. history
// ---------------------------------------------------------------------------

/// `history` — one expense's edit and trash history, walked to the end.
///
/// An empty id answers an empty list WITHOUT reading: there is no expense to
/// have a history.
pub fn history(door: &dyn PageDoor, expense_id: &str) -> KitResult<Value> {
    if expense_id.is_empty() {
        return Ok(json!({ "revisions": Value::Array(Vec::new()) }));
    }
    let rows = read_pages(door, &history_statement(expense_id), LEDGER_FAN_OUT)?;
    Ok(json!({
        "revisions": Value::Array(
            rows.iter()
                .map(|row| json!({
                    "revision_id": text_of(row, "revision_id").unwrap_or_default(),
                    "operation": text_of(row, "operation").unwrap_or_default(),
                    // The snapshot travels as the JSON it is. A revision whose
                    // snapshot does not parse is a corrupt row, and answering
                    // `null` for it says so rather than hiding the revision.
                    "snapshot": text_of(row, "snapshot_json")
                        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                        .unwrap_or(Value::Null),
                    "recorded_at": text_of(row, "recorded_at").unwrap_or_default(),
                    "undo_until": text_of(row, "undo_until").unwrap_or_default(),
                    "undone_at": optional(text_of(row, "undone_at").as_deref()),
                }))
                .collect(),
        ),
    }))
}

// ---------------------------------------------------------------------------
// 8. matches
// ---------------------------------------------------------------------------

/// An unordered pair, spelled one way so a decision matches either direction.
fn pair_key(left: &str, right: &str) -> String {
    if left < right {
        format!("{left}|{right}")
    } else {
        format!("{right}|{left}")
    }
}

/// Whole days between two instants, or `None` when either is unreadable.
///
/// `None` is NOT "far apart": an unparseable posting date is missing evidence,
/// and v0's `Number.POSITIVE_INFINITY` has the same effect — the pair is not
/// proposed. Spelled as an `Option` so the caller cannot compare it by accident.
fn days_apart(left: &str, right: &str) -> Option<i64> {
    let parse = |text: &str| -> Option<i64> {
        // `YYYY-MM-DDTHH:MM:SS(.sss)Z`, as every instant in the vault is
        // written. Days, not milliseconds, are what the answer is in, so the
        // date half is enough and no timezone table is needed.
        let bytes = text.as_bytes();
        if bytes.len() < 10 {
            return None;
        }
        let year: i64 = text.get(0..4)?.parse().ok()?;
        let month: i64 = text.get(5..7)?.parse().ok()?;
        let day: i64 = text.get(8..10)?.parse().ok()?;
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        // Days since an arbitrary epoch, by the civil-from-days algorithm's
        // inverse — no calendar library, and correct across month and year
        // boundaries, which a naive `year * 365 + month * 30` is not.
        let (year, month) = if month <= 2 {
            (year - 1, month + 12)
        } else {
            (year, month)
        };
        let era = year.div_euclid(400);
        let year_of_era = year - era * 400;
        let day_of_year = (153 * (month - 3) + 2) / 5 + day - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        Some(era * 146_097 + day_of_era)
    };
    Some((parse(left)? - parse(right)?).abs())
}

/// `matches` — CROSS-SOURCE MATCH PROPOSALS (#996, ruling R20(c), OQ-12).
///
/// Two imports of the same real movement are two transactions until the owner
/// says otherwise. This read proposes nothing on its own authority and WRITES
/// NOTHING AT ALL: a pair is offered when the two rows are the same money on
/// different accounts within a few days of each other, and either answer takes
/// the pair off the list for good.
pub fn matches(door: &dyn PageDoor) -> KitResult<Value> {
    let transactions = read_pages(door, &match_transactions_statement(), LEDGER_FAN_OUT)?;
    // The scan window is stated where it is taken, and it is a WINDOW, not a
    // truncation: an older pair is not proposed because nobody is reconciling
    // last year's statement on this screen.
    let recent: Vec<&Row> = transactions.iter().take(MATCH_SCAN_ROWS).collect();
    if recent.is_empty() {
        return Ok(json!({ "proposals": Value::Array(Vec::new()), "accounts": json!({}) }));
    }
    let decided: BTreeSet<String> = read_pages(door, &match_decisions_statement(), LEDGER_FAN_OUT)?
        .iter()
        .filter_map(|row| Some(pair_key(&text_of(row, "from_id")?, &text_of(row, "to_id")?)))
        .collect();

    // Same money, different account, near in time. The bucket is the EXACT
    // amount and currency: an amount that does not match is not this pair's
    // near miss, it is a different movement.
    let mut buckets: BTreeMap<String, Vec<&Row>> = BTreeMap::new();
    for row in &recent {
        let key = format!(
            "{}:{}",
            text_of(row, "currency").unwrap_or_default(),
            integer_or_zero(row, "amount_minor")
        );
        buckets.entry(key).or_default().push(row);
    }

    let mut proposals: Vec<(i64, String, Value)> = Vec::new();
    for bucket in buckets.values() {
        for (index, left) in bucket.iter().enumerate() {
            for right in bucket.iter().skip(index + 1) {
                let left_account = text_of(left, "account_id").unwrap_or_default();
                let right_account = text_of(right, "account_id").unwrap_or_default();
                if left_account == right_account {
                    continue;
                }
                let left_txn = text_of(left, "txn_id").unwrap_or_default();
                let right_txn = text_of(right, "txn_id").unwrap_or_default();
                if decided.contains(&pair_key(&left_txn, &right_txn)) {
                    continue;
                }
                let left_posted = text_of(left, "posted_at").unwrap_or_default();
                let right_posted = text_of(right, "posted_at").unwrap_or_default();
                let Some(apart) = days_apart(&left_posted, &right_posted) else {
                    continue;
                };
                if apart > MATCH_WINDOW_DAYS {
                    continue;
                }
                proposals.push((
                    apart,
                    left_posted.clone(),
                    json!({
                        "left_txn_id": left_txn,
                        "right_txn_id": right_txn,
                        "amount_minor": integer_or_zero(left, "amount_minor"),
                        "currency": text_of(left, "currency").unwrap_or_default(),
                        "direction": text_of(left, "direction").unwrap_or_default(),
                        "left_posted_at": left_posted,
                        "right_posted_at": right_posted,
                        "left_account": left_account,
                        "right_account": right_account,
                        "left_description": text_of(left, "description").unwrap_or_default(),
                        "right_description": text_of(right, "description").unwrap_or_default(),
                        // Whole days between the two postings — the weakest
                        // part of the evidence, and therefore stated.
                        "days_apart": apart,
                    }),
                ));
            }
        }
    }
    // The nearest evidence first: a same-day pair is a stronger proposal than
    // one four days apart, and a member reviewing ten of these should meet the
    // easy answers first.
    proposals.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| right.1.cmp(&left.1)));

    let mut named: Vec<String> = Vec::new();
    for (_, _, proposal) in &proposals {
        for side in ["left_account", "right_account"] {
            let account = proposal[side].as_str().unwrap_or_default().to_owned();
            if !named.contains(&account) {
                named.push(account);
            }
        }
    }
    let mut accounts = serde_json::Map::new();
    if !named.is_empty() {
        for row in read_pages(door, &match_accounts_statement(&named)?, LEDGER_FAN_OUT)? {
            if let Some(account_id) = text_of(&row, "account_id") {
                accounts.insert(
                    account_id,
                    Value::String(text_of(&row, "name").unwrap_or_default()),
                );
            }
        }
    }
    Ok(json!({
        "proposals": Value::Array(proposals.into_iter().map(|(_, _, row)| row).collect()),
        "accounts": Value::Object(accounts),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_malformed_limit_reads_as_the_default_and_never_as_an_empty_file() {
        assert_eq!(export_limit(None), 500);
        assert_eq!(export_limit(Some(0)), 500);
        assert_eq!(export_limit(Some(-7)), 1);
        assert_eq!(export_limit(Some(10)), 10);
        assert_eq!(export_limit(Some(9_999)), 2_000);
    }

    #[test]
    fn days_apart_crosses_a_month_and_a_leap_year_correctly() {
        assert_eq!(
            days_apart("2099-05-04T00:00:00Z", "2099-05-04T23:00:00Z"),
            Some(0)
        );
        assert_eq!(
            days_apart("2099-03-01T00:00:00Z", "2099-02-28T00:00:00Z"),
            Some(1)
        );
        // 2096 is a leap year, so the gap is two days rather than one.
        assert_eq!(
            days_apart("2096-03-01T00:00:00Z", "2096-02-28T00:00:00Z"),
            Some(2)
        );
        // Unreadable is NOT far apart; it is no evidence, and no proposal.
        assert_eq!(days_apart("later", "2099-05-04T00:00:00Z"), None);
    }

    #[test]
    fn the_pair_key_is_the_same_either_way_round() {
        assert_eq!(pair_key("b", "a"), pair_key("a", "b"));
    }
}
