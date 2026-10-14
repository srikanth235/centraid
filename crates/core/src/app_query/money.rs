//! MONEY'S ARM OF THE APP QUERY (#1099): `crates/apps/money`'s phone answers,
//! asked through [`super::VaultDoor`] and spelled as `money.proto` spells them.
//!
//! Every figure is the crate's (`phone`, over `engine`): this module resolves
//! the zone and the vault clock, runs the answer, and converts. Two things are
//! added here and nowhere else:
//!
//! - **EVERY AMOUNT CARRIES ITS EXPONENT**, from
//!   [`centraid_apps_kit::money::minor_units`] — a shell never guesses how many
//!   digits a currency has (JPY is 0, BHD is 3).
//! - **TODAY IS THE DEVICE'S ZONE** ([`super::zone_of`]'s rule), and a month the
//!   request leaves empty is the month today falls in.
//!
//! The import plan and Home's tile are not app queries: they ride
//! `Request.money` ([`import_plan`], [`home_tile`]). The plan reads a statement
//! once and drops its bytes; PUBLISHING is `money.import_transactions` through
//! the command plane, with the plan's `publish_input`.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_agenda::local;
use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::money::{Money, minor_units};
use centraid_apps_kit::page::{PageCursor, PageRequest};
use centraid_apps_money::import::{
    self, AccountRef, CsvOptions, DateOrder, IMPORT_BYTES, ImportPlan, Refusal, RowVerdict,
    SavedProfile, SignChoice, Source, Statement, StatementRefusal,
};
use centraid_apps_money::queries::{self, AccountRow, ActivityFilter, CategoryFilter};
use centraid_apps_money::recurring::{Cadence, Status};
use centraid_apps_money::rules::MatchKind;
use centraid_apps_money::{civil, phone};
use centraid_vault::Vault;

use super::{VaultDoor, settle, zone_of};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

// ---------------------------------------------------------------------------
// Small conversions.
// ---------------------------------------------------------------------------

fn amount(money: &Money) -> wire::MoneyAmount {
    wire::MoneyAmount {
        minor: money.amount_minor,
        currency: money.currency.code().to_owned(),
        exponent: u32::from(minor_units(money.currency.code())),
    }
}

fn amount_in(minor: i64, currency: &str) -> wire::MoneyAmount {
    wire::MoneyAmount {
        minor,
        currency: currency.to_owned(),
        exponent: u32::from(minor_units(currency)),
    }
}

fn some_amount(money: Option<&Money>) -> Option<wire::MoneyAmount> {
    money.map(amount)
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn counted(count_of: usize, money: &Money) -> wire::MoneyCounted {
    wire::MoneyCounted {
        count: count(count_of),
        amount: Some(amount(money)),
    }
}

fn flag(flag: phone::Flag) -> i32 {
    (match flag {
        phone::Flag::Transfer => wire::MoneyFlag::Transfer,
        phone::Flag::Void => wire::MoneyFlag::Void,
        phone::Flag::Uncategorised => wire::MoneyFlag::Uncategorised,
        phone::Flag::Future => wire::MoneyFlag::Future,
    }) as i32
}

fn match_kind(kind: MatchKind) -> i32 {
    (match kind {
        MatchKind::Is => wire::MoneyMatchKind::Is,
        MatchKind::Contains => wire::MoneyMatchKind::Contains,
        MatchKind::Matches => wire::MoneyMatchKind::Matches,
    }) as i32
}

fn cadence(cadence: Cadence) -> i32 {
    (match cadence {
        Cadence::Weekly => wire::MoneyCadence::Weekly,
        Cadence::Biweekly => wire::MoneyCadence::Biweekly,
        Cadence::Monthly => wire::MoneyCadence::Monthly,
        Cadence::Quarterly => wire::MoneyCadence::Quarterly,
        Cadence::Yearly => wire::MoneyCadence::Yearly,
    }) as i32
}

fn status(status: Status) -> i32 {
    (match status {
        Status::Due => wire::MoneyRecurringStatus::Due,
        Status::Late => wire::MoneyRecurringStatus::Late,
        Status::Paid => wire::MoneyRecurringStatus::Paid,
    }) as i32
}

fn date_order(order: DateOrder) -> i32 {
    (match order {
        DateOrder::Mdy => wire::MoneyDateOrder::Mdy,
        DateOrder::Dmy => wire::MoneyDateOrder::Dmy,
        DateOrder::Ymd => wire::MoneyDateOrder::Ymd,
        // "Ask" is the question itself, never an option offered.
        DateOrder::Ask => wire::MoneyDateOrder::Unspecified,
    }) as i32
}

fn activity_row(row: phone::ActivityRow) -> wire::MoneyActivityRow {
    wire::MoneyActivityRow {
        txn_id: row.txn_id,
        posted_on: row.posted_on,
        display_name: row.display_name,
        raw: row.raw,
        amount: Some(amount(&row.amount)),
        account_id: row.account_id,
        account_label: row.account_label,
        category_id: row.category_id,
        category_label: row.category_label,
        flags: row.flags.into_iter().map(flag).collect(),
    }
}

/// The vault clock's civil day in the request's zone.
fn today_of(vault: &Vault, tz: &str, now: &str) -> Result<String> {
    let zone = zone_of(vault, tz)?;
    local::today(&zone, now).ok_or_else(|| CoreError::Invariant {
        context: format!("the vault clock did not read as a day: {now}"),
    })
}

/// A month: the one stated (`YYYY-MM`), else the one `today` falls in.
fn month_of(stated: &str, today: &str) -> Result<String> {
    let stated = stated.trim();
    if stated.is_empty() {
        return Ok(civil::month_of(today).to_owned());
    }
    civil::parse_month(stated)
        .map(|_| stated.to_owned())
        .ok_or_else(|| CoreError::InvalidRequest {
            detail: format!("`{stated}` is not a month; a month is `YYYY-MM`"),
        })
}

fn limit_required(limit: u32, what: &str) -> Result<usize> {
    if limit == 0 {
        return Err(CoreError::InvalidRequest {
            detail: format!(
                "{what} carries no limit; a default is how an unbounded read gets written by accident"
            ),
        });
    }
    Ok(usize::try_from(limit).unwrap_or(usize::MAX))
}

fn done<T>(loaded: KitResult<T>) -> KitResult<(T, Option<centraid_apps_kit::Denial>)> {
    loaded.map(|value| (value, None))
}

// ---------------------------------------------------------------------------
// The ten arms (100-109).
// ---------------------------------------------------------------------------

pub(super) fn spending(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::MoneySpendingRequest,
) -> Result<Answer> {
    let today = today_of(vault, &asked.tz, now)?;
    let month = month_of(&asked.month, &today)?;
    settle(door, done(phone::spending(door, &month, &today)), |data| {
        Answer::MoneySpending(wire::MoneySpending {
            month: data.month,
            today,
            day_of_month: data.day_of_month,
            days_in_month: data.days_in_month,
            days_left: data.days_left,
            per_currency: data
                .per_currency
                .iter()
                .map(|c| wire::money_spending::SpendingCurrency {
                    spent: Some(amount(&c.spent)),
                    planned: some_amount(c.planned.as_ref()),
                    left: some_amount(c.left.as_ref()),
                    progress_bp: c.progress_bp,
                    refund_credit: Some(amount(&c.refund_credit)),
                })
                .collect(),
            categories: data
                .categories
                .iter()
                .map(|c| wire::money_spending::SpendingCategory {
                    currency: c.currency.clone(),
                    category_id: c.category_id.clone(),
                    label: c.label.clone(),
                    group: c.group.clone(),
                    planned: some_amount(c.planned.as_ref()),
                    carry_in: Some(amount(&c.carry_in)),
                    spent: Some(amount(&c.spent)),
                    left: some_amount(c.left.as_ref()),
                    over: c.over,
                    refund_credit: Some(amount(&c.refund_credit)),
                })
                .collect(),
            uncategorised: data
                .uncategorised
                .iter()
                .map(|u| counted(u.count, &u.amount))
                .collect(),
            in_out_net: data
                .in_out_net
                .iter()
                .map(|n| wire::money_spending::InOutNet {
                    incoming: Some(amount(&n.incoming)),
                    outgoing: Some(amount(&n.outgoing)),
                    net: Some(amount(&n.net)),
                })
                .collect(),
            transfers_excluded: data
                .transfers_excluded
                .iter()
                .map(|e| counted(e.count, &e.amount))
                .collect(),
            future_excluded: data
                .future_excluded
                .iter()
                .map(|e| counted(e.count, &e.amount))
                .collect(),
            forecast: data
                .forecast
                .iter()
                .map(|f| wire::money_spending::ForecastLine {
                    spent_so_far: Some(amount(&f.spent_so_far)),
                    expected: Some(amount(&f.expected)),
                    month_end: Some(amount(&f.month_end)),
                })
                .collect(),
            definitions: data.definitions.iter().map(|d| (*d).to_owned()).collect(),
            empty: data.empty,
            last_import: data
                .last_import
                .map(|l| wire::money_spending::LastImportLine {
                    imported_at: l.imported_at,
                    source: l.source,
                    account_name: l.account_name,
                }),
            truncated: data.truncated,
        })
    })
}

pub(super) fn activity(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::MoneyActivityRequest,
) -> Result<Answer> {
    let limit = limit_required(asked.limit, "a money activity read")?;
    let today = today_of(vault, &asked.tz, now)?;
    let month = month_of(&asked.month, &today)?;
    use wire::MoneyCategoryFilter as F;
    let category = match F::try_from(asked.category_filter).unwrap_or(F::Unspecified) {
        F::Unspecified | F::Any => CategoryFilter::Any,
        F::Uncategorised => CategoryFilter::Uncategorised,
        F::Is => {
            if asked.category_id.trim().is_empty() {
                return Err(CoreError::InvalidRequest {
                    detail: "a money activity read for one category names no `category_id`"
                        .to_owned(),
                });
            }
            CategoryFilter::Is(asked.category_id.clone())
        }
    };
    let filter = ActivityFilter {
        account_id: asked.account_id.clone().filter(|id| !id.is_empty()),
        category,
    };
    let request = match &asked.after {
        Some(cursor) => PageRequest::after(
            limit,
            PageCursor {
                sort_key: cursor.sort_key.clone(),
                pk: cursor.pk.clone(),
            },
        ),
        None => PageRequest::first(limit),
    };
    settle(
        door,
        done(phone::activity(door, &month, &filter, &request, &today)),
        |data| {
            Answer::MoneyActivity(wire::MoneyActivity {
                month: data.month,
                today,
                rows: data.rows.into_iter().map(activity_row).collect(),
                needs_category: data
                    .needs_category
                    .iter()
                    .map(|n| counted(n.count, &n.amount))
                    .collect(),
                next: data
                    .cursor
                    .map(|(sort_key, pk)| wire::MoneyCursor { sort_key, pk }),
                truncated: data.truncated,
            })
        },
    )
}

pub(super) fn transaction(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::MoneyTransactionRequest,
) -> Result<Answer> {
    let today = today_of(vault, &asked.tz, now)?;
    settle(
        door,
        done(phone::transaction(door, &asked.txn_id, &today)),
        |found| {
            Answer::MoneyTransaction(match found {
                None => wire::MoneyTransaction::default(),
                Some(t) => wire::MoneyTransaction {
                    found: true,
                    txn_id: t.txn_id,
                    posted_on: t.posted_on,
                    display_name: t.display_name,
                    display_name_source: t.display_name_source,
                    raw: t.raw,
                    amount: Some(amount(&t.amount)),
                    account_id: t.account_id,
                    account_label: t.account_label,
                    category_id: t.category_id,
                    category_label: t.category_label,
                    memo: t.memo,
                    check_number: t.check_number,
                    bank_type: t.bank_type,
                    imported_from: t.imported_from,
                    flags: t.flags.into_iter().map(flag).collect(),
                    transfer_proposal: t.transfer_proposal.map(|o| {
                        wire::money_transaction::TransferOffer {
                            other_txn_id: o.other_txn_id,
                            other_account_label: o.other_account_label,
                            other_description: o.other_description,
                            other_posted_on: o.other_posted_on,
                            days_apart: o.days_apart,
                        }
                    }),
                    transferred_with: t.transferred_with,
                    rule_proposal: t.rule_proposal.map(|o| wire::money_transaction::RuleOffer {
                        kind: match_kind(o.kind),
                        pattern: o.pattern,
                        category_id: o.category_id,
                        category_label: o.category_label,
                        display_name: o.display_name,
                        support: count(o.support),
                        of: count(o.of),
                    }),
                    applied_rule_ids: t.applied_rule_ids,
                    seen_times: count(t.seen_times),
                    recurring: t.recurring.map(|r| wire::money_transaction::RecurringNote {
                        cadence: cadence(r.cadence),
                        next_due: r.next_due,
                        amount: Some(amount(&r.amount)),
                    }),
                },
            })
        },
    )
}

pub(super) fn cashflow(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::MoneyCashflowRequest,
) -> Result<Answer> {
    let today = today_of(vault, &asked.tz, now)?;
    let through = month_of(&asked.through, &today)?;
    settle(
        door,
        done(phone::cashflow(door, &through, &today)),
        |data| {
            Answer::MoneyCashflow(wire::MoneyCashflow {
                through: data.through,
                today,
                series: data
                    .series
                    .into_iter()
                    .map(|series| wire::money_cashflow::Series {
                        currency: series.currency,
                        months: series
                            .months
                            .iter()
                            .map(|m| wire::money_cashflow::Month {
                                month: m.month.clone(),
                                incoming: Some(amount(&m.incoming)),
                                outgoing: Some(amount(&m.outgoing)),
                                net: Some(amount(&m.net)),
                                savings_rate_bp: m.savings_rate_bp,
                                partial: m.partial,
                            })
                            .collect(),
                    })
                    .collect(),
                definitions: data.definitions.iter().map(|d| (*d).to_owned()).collect(),
                truncated: data.truncated,
            })
        },
    )
}

fn account_line(line: &phone::AccountLine) -> wire::money_accounts::AccountLine {
    wire::money_accounts::AccountLine {
        account_id: line.account_id.clone(),
        name: line.name.clone(),
        mask: line.mask.clone(),
        kind: line.kind.clone(),
        currency: line.currency.clone(),
        balance: some_amount(line.balance.as_ref()),
        checkpoint: line
            .checkpoint
            .as_ref()
            .map(|c| wire::money_accounts::CheckpointLine {
                as_of: c.as_of.clone(),
                stated: Some(amount(&c.stated)),
                delta: Some(amount(&c.delta)),
                agrees: c.agrees,
            }),
        closed: line.closed,
    }
}

pub(super) fn accounts(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::MoneyAccountsRequest,
) -> Result<Answer> {
    let today = today_of(vault, &asked.tz, now)?;
    settle(door, done(phone::accounts(door, &today)), |data| {
        Answer::MoneyAccounts(wire::MoneyAccounts {
            today,
            on_budget: data.on_budget.iter().map(account_line).collect(),
            off_budget: data.off_budget.iter().map(account_line).collect(),
            net_worth: data
                .net_worth
                .iter()
                .map(|n| wire::money_accounts::NetWorthLine {
                    amount: Some(amount(&n.amount)),
                    complete: n.complete,
                })
                .collect(),
            definitions: data.definitions.iter().map(|d| (*d).to_owned()).collect(),
        })
    })
}

pub(super) fn rules(door: &VaultDoor<'_>) -> Result<Answer> {
    settle(door, done(phone::rules(door)), |data| {
        Answer::MoneyRules(wire::MoneyRules {
            rules: data
                .rules
                .into_iter()
                .map(|r| wire::money_rules::RuleLine {
                    rule_id: r.rule_id,
                    kind: match_kind(r.kind),
                    pattern: r.pattern,
                    amount_min: r.amount_min,
                    amount_max: r.amount_max,
                    account_label: r.account_label,
                    category_label: r.category_label,
                    display_name: r.display_name,
                    specificity: r.specificity,
                })
                .collect(),
            limit: count(data.limit),
            truncated: data.truncated,
        })
    })
}

pub(super) fn categories(door: &VaultDoor<'_>) -> Result<Answer> {
    settle(door, done(phone::categories(door)), |data| {
        Answer::MoneyCategories(wire::MoneyCategories {
            groups: data
                .groups
                .into_iter()
                .map(|g| wire::money_categories::Group {
                    group_id: g.group_id,
                    label: g.label,
                    categories: g
                        .categories
                        .into_iter()
                        .map(|c| wire::money_categories::Category {
                            category_id: c.category_id,
                            label: c.label,
                            archived: c.archived,
                        })
                        .collect(),
                })
                .collect(),
        })
    })
}

pub(super) fn target_sheet(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::MoneyTargetSheetRequest,
) -> Result<Answer> {
    if asked.category_id.trim().is_empty() || asked.currency.trim().is_empty() {
        return Err(CoreError::InvalidRequest {
            detail: "a money target sheet names its `category_id` and `currency`".to_owned(),
        });
    }
    let today = today_of(vault, &asked.tz, now)?;
    let month = month_of(&asked.month, &today)?;
    let typing = asked
        .typing_amount_minor
        .map(|minor| (minor, asked.typing_carry));
    settle(
        door,
        done(phone::target_sheet(
            door,
            &month,
            &asked.category_id,
            &asked.currency.to_ascii_uppercase(),
            typing,
            &today,
        )),
        |sheet| {
            Answer::MoneyTargetSheet(wire::MoneyTargetSheet {
                category_id: sheet.category_id,
                category_label: sheet.category_label,
                month: sheet.month,
                currency: sheet.currency,
                amount: some_amount(sheet.amount.as_ref()),
                carry: sheet.carry,
                carry_in: Some(amount(&sheet.carry_in)),
                spent: Some(amount(&sheet.spent)),
                six_month_average: Some(amount(&sheet.six_month_average)),
                next_month_preview: Some(amount(&sheet.next_month_preview)),
            })
        },
    )
}

pub(super) fn recurring(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::MoneyRecurringRequest,
) -> Result<Answer> {
    let today = today_of(vault, &asked.tz, now)?;
    settle(door, done(phone::recurring_screen(door, &today)), |data| {
        Answer::MoneyRecurring(wire::MoneyRecurring {
            today,
            series: data
                .series
                .into_iter()
                .map(|l| wire::money_recurring::Line {
                    merchant: l.merchant,
                    account_label: l.account_label,
                    cadence: cadence(l.cadence),
                    cadence_words: l.cadence_words.to_owned(),
                    amount: Some(amount(&l.amount)),
                    next_due: l.next_due,
                    status: status(l.status),
                    seen_times: count(l.seen_times),
                    category_label: l.category_label,
                })
                .collect(),
            definitions: data.definitions.iter().map(|d| (*d).to_owned()).collect(),
            truncated: data.truncated,
        })
    })
}

pub(super) fn search(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::MoneySearchRequest,
) -> Result<Answer> {
    let limit = limit_required(asked.limit, "a money search")?;
    let today = today_of(vault, &asked.tz, now)?;
    let month = month_of(&asked.month, &today)?;
    // An empty term answers no results without reading.
    if asked.term.trim().is_empty() {
        return Ok(Answer::MoneySearch(wire::MoneySearch {
            term: asked.term.clone(),
            ..wire::MoneySearch::default()
        }));
    }
    settle(
        door,
        done(phone::search(door, &month, &asked.term, limit, &today)),
        |data| {
            Answer::MoneySearch(wire::MoneySearch {
                term: data.term,
                rows: data.rows.into_iter().map(activity_row).collect(),
                total_matches: count(data.total_matches),
                corrected: data.corrected,
                truncated: data.truncated,
                months_walked: count(data.months_walked),
            })
        },
    )
}

// ---------------------------------------------------------------------------
// Home's tile.
// ---------------------------------------------------------------------------

/// `Request.money.home_tile`: this month's spending per currency.
pub(crate) fn home_tile(
    vault: &Vault,
    asked: &wire::MoneyHomeTileRequest,
) -> Result<wire::MoneyHomeTile> {
    let now = vault.clock().now_text();
    let door = VaultDoor::new(vault);
    let today = today_of(vault, &asked.tz, &now)?;
    let month = civil::month_of(&today).to_owned();
    let loaded = phone::home_tile(&door, &month, &today);
    if let Some(failure) = door.take_failure() {
        return Err(failure);
    }
    let tile = loaded.map_err(kit_failure)?;
    Ok(wire::MoneyHomeTile {
        month: tile.month,
        spent: tile.spent.iter().map(amount).collect(),
        empty: tile.empty,
    })
}

fn kit_failure(error: centraid_apps_kit::error::KitError) -> CoreError {
    match error {
        centraid_apps_kit::error::KitError::FanOutExceeded { query, cap } => {
            CoreError::ReadBoundReached { query, cap }
        }
        other => CoreError::Invariant {
            context: format!("a money read broke its own contract: {other}"),
        },
    }
}

// ---------------------------------------------------------------------------
// The import plan.
// ---------------------------------------------------------------------------

fn refusal_plan(sentence: String) -> wire::MoneyImportPlan {
    wire::MoneyImportPlan {
        refusal: Some(sentence),
        statements: Vec::new(),
    }
}

fn account_refs(accounts: &[AccountRow]) -> Vec<AccountRef> {
    accounts
        .iter()
        .map(|a| AccountRef {
            account_id: a.account_id.clone(),
            currency: a.currency.clone(),
            external_ref: a.external_ref.clone(),
            // A member who typed only the last digits as the account number is
            // matched by them.
            mask: a
                .external_ref
                .clone()
                .filter(|r| r.chars().filter(char::is_ascii_alphanumeric).count() <= 8),
        })
        .collect()
}

/// The profile saved for this statement's layout: the first one whose
/// fingerprint the statement's re-detected profile carries.
fn matching_saved<'a>(
    saved: &'a [SavedProfile],
    statement: &Statement,
) -> Option<&'a SavedProfile> {
    let fresh = statement.profile.as_ref()?.to_saved()?;
    saved
        .iter()
        .find(|p| p.header_fingerprint == fresh.header_fingerprint)
}

fn profile_message(profile: SavedProfile) -> wire::MoneyImportProfile {
    let col = |value: Option<usize>| value.map(count);
    wire::MoneyImportProfile {
        header_fingerprint: profile.header_fingerprint,
        delimiter: profile.delimiter,
        skip_lines: count(profile.skip_lines),
        date_order: profile.date_order,
        sign_mode: profile.sign_mode,
        date_col: count(profile.date_col),
        amount_col: col(profile.amount_col),
        debit_col: col(profile.debit_col),
        credit_col: col(profile.credit_col),
        desc_col: count(profile.desc_col),
        memo_col: col(profile.memo_col),
        indicator_col: col(profile.indicator_col),
        indicator_out_value: profile.indicator_out_value,
    }
}

/// The `money.import_transactions` input for a plan's rows, as canonical JSON
/// bytes: the rows `keep` selects, each with a transaction id the phone mints
/// now. Empty when no row is kept.
fn publish_input(
    vault: &Vault,
    plan: &ImportPlan,
    account: &AccountRow,
    source: Source,
    keep: impl Fn(&RowVerdict) -> bool,
) -> Result<Vec<u8>> {
    let rows: Vec<serde_json::Value> = plan
        .rows
        .iter()
        .filter(|entry| keep(&entry.verdict))
        .filter_map(|entry| entry.row.as_ref())
        .map(|row| {
            let mut value = serde_json::to_value(row).map_err(|error| CoreError::Invariant {
                context: format!("an import row will not serialise: {error}"),
            })?;
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "txn_id".to_owned(),
                    serde_json::Value::String(vault.ids().next()),
                );
            }
            Ok(value)
        })
        .collect::<Result<_>>()?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut input = serde_json::json!({
        "account_id": account.account_id,
        "source": source.as_str(),
        "rows": rows,
    });
    if let (Some(object), Some(checkpoint)) = (input.as_object_mut(), &plan.checkpoint) {
        object.insert(
            "checkpoint".to_owned(),
            serde_json::json!({
                "as_of": checkpoint.as_of,
                "balance_minor": checkpoint.balance_minor,
                "currency": account.currency,
            }),
        );
    }
    serde_json::to_vec(&input).map_err(|error| CoreError::Invariant {
        context: format!("an import input will not serialise: {error}"),
    })
}

/// One statement, planned against one account.
fn plan_statement(
    vault: &Vault,
    door: &VaultDoor<'_>,
    account: &AccountRow,
    statement: &Statement,
    saved: &[SavedProfile],
    today: &str,
) -> Result<wire::MoneyStatementPlan> {
    let existing = match import::existing_window(statement) {
        Some((from, to)) => {
            let loaded = queries::load_existing(door, &account.account_id, &from, &to);
            if let Some(failure) = door.take_failure() {
                return Err(failure);
            }
            loaded.map_err(kit_failure)?
        }
        None => Vec::new(),
    };
    let rules = queries::load_rules(door);
    if let Some(failure) = door.take_failure() {
        return Err(failure);
    }
    let rules = rules.map_err(kit_failure)?.value;
    let categories = queries::load_categories(door);
    if let Some(failure) = door.take_failure() {
        return Err(failure);
    }
    let categories = categories.map_err(kit_failure)?;
    let plan = import::plan(
        statement,
        &account.account_id,
        &account.currency,
        &existing,
        &rules,
        today,
    );
    let shown = phone::import_plan(&plan, &categories, matching_saved(saved, statement));
    let source = statement.source;
    let new_only = publish_input(vault, &plan, account, source, |v| {
        matches!(v, RowVerdict::New)
    })?;
    let with_proposed = if plan
        .rows
        .iter()
        .any(|r| matches!(r.verdict, RowVerdict::ProposedDuplicate { .. }))
    {
        publish_input(vault, &plan, account, source, |v| {
            matches!(v, RowVerdict::New | RowVerdict::ProposedDuplicate { .. })
        })?
    } else {
        Vec::new()
    };
    Ok(statement_message(
        Some(account),
        None,
        shown,
        new_only,
        with_proposed,
    ))
}

fn statement_message(
    account: Option<&AccountRow>,
    refusal: Option<String>,
    shown: phone::MoneyImportPlan,
    publish_input: Vec<u8>,
    publish_input_with_proposed: Vec<u8>,
) -> wire::MoneyStatementPlan {
    use phone::VerdictKind as V;
    let currency = account.map_or("", |a| a.currency.as_str());
    let figure = |money: &Money| amount(money);
    wire::MoneyStatementPlan {
        account_id: account.map(|a| a.account_id.clone()),
        account_label: account.map(|a| a.name.clone()),
        statement_refusal: refusal,
        rows: shown
            .rows
            .into_iter()
            .map(|row| wire::MoneyImportPlanRow {
                line: count(row.line),
                verdict: (match row.verdict {
                    V::New => wire::MoneyImportVerdict::New,
                    V::AlreadyIn => wire::MoneyImportVerdict::AlreadyIn,
                    V::ProposedDuplicate => wire::MoneyImportVerdict::ProposedDuplicate,
                    V::RepeatInFile => wire::MoneyImportVerdict::RepeatInFile,
                    V::Rejected => wire::MoneyImportVerdict::Rejected,
                }) as i32,
                posted_on: row.posted_on,
                amount: some_amount(row.amount.as_ref()),
                description: row.description,
                display_name: row.display_name,
                category_label: row.category_label,
                future_dated: row.future_dated,
                existing_txn_id: row.existing_txn_id,
                reason: row.reason.map(str::to_owned),
            })
            .collect(),
        new: count(shown.new),
        already_in: count(shown.already_in),
        proposed_duplicates: count(shown.proposed_duplicates),
        repeats_in_file: count(shown.repeats_in_file),
        rejected: count(shown.rejected),
        future_dated: count(shown.future_dated),
        file_in: Some(figure(&shown.file_in)),
        file_out: Some(figure(&shown.file_out)),
        new_in: Some(figure(&shown.new_in)),
        new_out: Some(figure(&shown.new_out)),
        first_day: shown.first_day,
        last_day: shown.last_day,
        question: shown.question.map(|q| wire::MoneyDateOrderQuestion {
            samples: q.samples,
            options: q.options.into_iter().map(date_order).collect(),
        }),
        warnings: shown
            .warnings
            .into_iter()
            .map(|w| {
                (match w {
                    import::Warning::ProfileChanged => wire::MoneyImportWarning::ProfileChanged,
                    import::Warning::SignGuessed => wire::MoneyImportWarning::SignGuessed,
                }) as i32
            })
            .collect(),
        checkpoint: shown.checkpoint.map(|c| wire::MoneyImportCheckpoint {
            as_of: c.as_of,
            balance: Some(amount_in(c.balance_minor, currency)),
        }),
        profile_to_save: shown.profile_to_save.map(profile_message),
        publish_input,
        publish_input_with_proposed,
    }
}

fn refusal_sentence(refusal: &Refusal) -> String {
    refusal.to_string()
}

/// `Request.money.import_plan`: read the file once, plan it, drop the bytes.
pub(crate) fn import_plan(
    vault: &Vault,
    asked: &wire::MoneyImportPlanRequest,
) -> Result<wire::MoneyImportPlan> {
    let now = vault.clock().now_text();
    let door = VaultDoor::new(vault);
    let today = today_of(vault, &asked.tz, &now)?;
    if asked.content.len() > IMPORT_BYTES {
        return Ok(refusal_plan(
            Refusal::TooLarge {
                bytes: asked.content.len(),
                limit: IMPORT_BYTES,
            }
            .to_string(),
        ));
    }
    let load = |loaded: KitResult<Vec<AccountRow>>| -> Result<Vec<AccountRow>> {
        if let Some(failure) = door.take_failure() {
            return Err(failure);
        }
        loaded.map_err(kit_failure)
    };
    let accounts = load(queries::load_accounts(&door))?;
    let find = |id: &str| -> Result<&AccountRow> {
        accounts
            .iter()
            .find(|a| a.account_id == id)
            .ok_or_else(|| CoreError::InvalidRequest {
                detail: "a money import names an account this vault does not hold".to_owned(),
            })
    };
    let chosen = asked.account_id.as_deref().filter(|id| !id.is_empty());

    match wire::MoneySource::try_from(asked.source).unwrap_or(wire::MoneySource::Unspecified) {
        wire::MoneySource::Unspecified => Err(CoreError::InvalidRequest {
            detail: "a money import names its source, `csv` or `ofx`".to_owned(),
        }),
        wire::MoneySource::Csv => {
            let Some(id) = chosen else {
                return Err(CoreError::InvalidRequest {
                    detail: "a CSV import names the account it belongs to".to_owned(),
                });
            };
            let account = find(id)?;
            let saved = queries::load_saved_profiles(&door, &account.account_id);
            if let Some(failure) = door.take_failure() {
                return Err(failure);
            }
            let saved = saved.map_err(kit_failure)?;
            let mut options = saved.first().map_or_else(
                || CsvOptions::new(&account.currency),
                |profile| CsvOptions::from_saved(&account.currency, profile),
            );
            use wire::MoneyDateOrder as D;
            match D::try_from(asked.date_order).unwrap_or(D::Unspecified) {
                D::Mdy => options.date_order = Some(DateOrder::Mdy),
                D::Dmy => options.date_order = Some(DateOrder::Dmy),
                D::Ymd | D::Unspecified => {}
            }
            match wire::MoneySignChoice::try_from(asked.sign)
                .unwrap_or(wire::MoneySignChoice::Unspecified)
            {
                wire::MoneySignChoice::DebitsNegative => {
                    options.sign = Some(SignChoice::DebitsNegative);
                }
                wire::MoneySignChoice::DebitsPositive => {
                    options.sign = Some(SignChoice::DebitsPositive);
                }
                wire::MoneySignChoice::Unspecified => {}
            }
            let statement = match import::read_csv(&asked.content, &options) {
                Ok(statement) => statement,
                Err(refusal) => return Ok(refusal_plan(refusal_sentence(&refusal))),
            };
            Ok(wire::MoneyImportPlan {
                refusal: None,
                statements: vec![plan_statement(
                    vault, &door, account, &statement, &saved, &today,
                )?],
            })
        }
        wire::MoneySource::Ofx => {
            let file = match import::read_ofx(&asked.content) {
                Ok(file) => file,
                Err(refusal) => return Ok(refusal_plan(refusal_sentence(&refusal))),
            };
            let refs = account_refs(&accounts);
            let mut statements = Vec::with_capacity(file.statements.len());
            for one in &file.statements {
                let resolved: std::result::Result<&AccountRow, StatementRefusal> = match chosen {
                    Some(id) => {
                        let account = find(id)?;
                        import::ofx::check_currency(one, &account.currency).map(|()| account)
                    }
                    None => import::resolve_account(one, &refs).map(|matched| {
                        accounts
                            .iter()
                            .find(|a| a.account_id == matched.account_id)
                            .unwrap_or(&accounts[0])
                    }),
                };
                match resolved {
                    Ok(account) => {
                        statements.push(plan_statement(
                            vault,
                            &door,
                            account,
                            &one.statement,
                            &[],
                            &today,
                        )?);
                    }
                    Err(refusal) => statements.push(wire::MoneyStatementPlan {
                        statement_refusal: Some(refusal.sentence()),
                        ..wire::MoneyStatementPlan::default()
                    }),
                }
            }
            Ok(wire::MoneyImportPlan {
                refusal: None,
                statements,
            })
        }
    }
}

#[cfg(test)]
#[path = "money_tests.rs"]
mod tests;
