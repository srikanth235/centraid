//! MONEY'S READS, as statements-as-data with stated ceilings.
//!
//! **There is no SQL in this crate.** A statement is a
//! [`centraid_apps_kit::PageQuery`] and the kit is the only place that turns
//! one into a statement. Every read here is bounded by a number this module
//! states, and a read that reaches its ceiling says so in its value
//! (`filled`/`truncated`) rather than answering short: **a balance or a total
//! derived from a silently short ledger is a wrong number, not a slow screen.**
//!
//! A transaction is read from `core_transaction` alone, keyset-ordered, and its
//! Money decoration (`money_transaction`: the member's name, the memo, the
//! cheque number) is read by id in a second bounded statement. A join would put
//! two `txn_id` columns under the keyset's row value, which no door can order.
//!
//! The ceilings (R-1099-44 and the plan):
//!
//! | Name | Value | What it bounds |
//! | --- | --- | --- |
//! | [`MONTH_ROWS`] | 2,000 | one month window of one vault |
//! | [`CASHFLOW_MONTHS`] | 12 | the windows the cash-flow screen folds |
//! | [`SEARCH_MONTHS`] | 12 | the windows a search walks, newest first |
//! | [`ACCOUNT_ROWS`] | 40,000 | one account's whole history, for its balance |
//! | [`MATCH_SCAN_ROWS`] | 500 | the newest rows of each account a transfer is looked for among |
//! | [`EXISTING_ROWS`] | 40,000 | the rows an import plan compares against |
//! | [`crate::rules::RULES`] | 500 | rules |

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::{Page, PageRequest};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, Window, in_list, read_page, read_pages};
use centraid_apps_kit::row::{Row, integer_or_zero, text_of};
use centraid_apps_kit::spelling::WalkedWords;
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::civil;
use crate::import::{Direction, ExistingTxn};
use crate::rules::{MatchKind, RULES, Rule};

/// One month window of transactions.
pub const MONTH_ROWS: usize = 2_000;
/// The month windows the cash-flow fold reads.
pub const CASHFLOW_MONTHS: usize = 12;
/// The month windows a search walks, newest first (R-1099-44).
pub const SEARCH_MONTHS: usize = 12;
/// One account's whole history, for a derived balance.
pub const ACCOUNT_ROWS: usize = 40_000;
/// Newest rows per account a transfer is looked for among.
pub const MATCH_SCAN_ROWS: usize = 500;
/// Rows an import plan compares against.
pub const EXISTING_ROWS: usize = 40_000;
/// Accounts a vault lists.
pub const ACCOUNT_LIMIT: usize = 200;
/// Targets read at once (13 months of ~40 categories is 520).
pub const TARGET_ROWS: usize = 1_000;
/// Checkpoints read at once; one page, so no keyset ties can matter.
pub const CHECKPOINT_ROWS: usize = 400;
/// Categories, including archived ones.
pub const CATEGORY_ROWS: usize = 300;
/// Live transfer links.
pub const LINK_ROWS: usize = 2_000;
/// Rows of a decoration read: ids per statement.
const DECORATION_CHUNK: usize = 400;

/// The scheme every Money category lives in.
pub const CATEGORIES_SCHEME_ID: &str = "money:categories";
/// The `transfer` link relation's concept id.
pub const TRANSFER_RELATION_ID: &str = "money:relation:transfer";
/// The group a category belongs to when it is income.
pub const INCOME_GROUP: &str = "money:cat:income";

/// Money's reads that can stop at a ceiling say so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bounded<T> {
    pub value: T,
    /// The set was longer than the window: `value` is a prefix of it.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Rows.
// ---------------------------------------------------------------------------

/// An account as Money shows it: Money's decoration and the spine's currency.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRow {
    pub account_id: String,
    pub name: String,
    /// `checking` | `savings` | `credit_card` | `cash`.
    pub kind: String,
    pub on_budget: bool,
    pub opening_minor: i64,
    pub opening_on: Option<String>,
    pub closed_on: Option<String>,
    pub currency: String,
    /// The bank-side id the member entered, if any.
    pub external_ref: Option<String>,
}

/// A transaction with its Money decoration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxnRow {
    pub txn_id: String,
    pub account_id: String,
    /// The printed day, `YYYY-MM-DD`.
    pub posted_on: String,
    /// The magnitude, > 0.
    pub amount_minor: i64,
    pub currency: String,
    pub direction: Direction,
    /// `pending` | `posted` | `void`.
    pub status: String,
    /// The bank's words.
    pub description: String,
    pub category_concept_id: Option<String>,
    pub external_id: Option<String>,
    pub display_name: Option<String>,
    /// `rule` | `member`.
    pub display_name_source: Option<String>,
    pub memo: Option<String>,
    pub check_number: Option<String>,
    pub bank_type: Option<String>,
    pub imported_from: Option<String>,
}

impl TxnRow {
    #[must_use]
    pub fn is_void(&self) -> bool {
        self.status == "void"
    }

    /// Positive in, negative out.
    #[must_use]
    pub const fn signed_minor(&self) -> i64 {
        self.direction.signed(self.amount_minor)
    }

    /// What the member calls it: their name, else the bank's words.
    #[must_use]
    pub fn name(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.description)
    }
}

/// A plan for a category in a month.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetRow {
    pub month: String,
    pub category_concept_id: String,
    pub amount_minor: i64,
    pub currency: String,
    pub carry: bool,
}

/// A balance a statement or the member stated for a day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointRow {
    pub account_id: String,
    pub as_of: String,
    pub source: String,
    /// Signed.
    pub balance_minor: i64,
    pub currency: String,
}

/// A category (or a group of them) with its place in the two-level tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryRow {
    pub concept_id: String,
    pub notation: String,
    pub label: String,
    /// `None` for a group.
    pub parent: Option<String>,
    pub archived: bool,
}

/// One live transfer link: the debit end `from`, the credit end `to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferLink {
    pub link_id: String,
    pub from_txn: String,
    pub to_txn: String,
}

/// Which rows of a month an Activity list shows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActivityFilter {
    pub account_id: Option<String>,
    pub category: CategoryFilter,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum CategoryFilter {
    #[default]
    Any,
    /// Rows with no category: "needs a category".
    Uncategorised,
    Is(String),
}

// ---------------------------------------------------------------------------
// The statements.
// ---------------------------------------------------------------------------

fn query(name: &str, select: &str, from: &str, order: PageOrder) -> PageQuery {
    PageQuery::new(name, select, from, order)
}

const TXN_COLUMNS: &str = "txn_id, account_id, posted_at, amount_minor, currency, direction, \
                           status, description, category_concept_id, external_id";

/// `money.transactions.month` — a month's rows by `posted_at` range, newest
/// first. The month is a bind, never a pattern: `posted_at` is
/// `YYYY-MM-DDT00:00:00Z` (R-1099-2) and a range uses the index.
pub fn month_statement(month: &str, filter: &ActivityFilter) -> KitResult<PageQuery> {
    let next = civil::add_months(month, 1).ok_or_else(|| KitError::GrammarRefused {
        query: "money.transactions.month".to_owned(),
        why: "not a month".to_owned(),
    })?;
    let mut predicate = String::from("posted_at >= ? AND posted_at < ?");
    let mut bind = vec![
        PageBindValue::from(civil::month_start_stamp(month)),
        PageBindValue::from(civil::month_start_stamp(&next)),
    ];
    if let Some(account) = &filter.account_id {
        predicate.push_str(" AND account_id = ?");
        bind.push(PageBindValue::from(account.as_str()));
    }
    match &filter.category {
        CategoryFilter::Any => {}
        CategoryFilter::Uncategorised => {
            predicate.push_str(" AND category_concept_id IS NULL AND status <> 'void'");
        }
        CategoryFilter::Is(category) => {
            predicate.push_str(" AND category_concept_id = ?");
            bind.push(PageBindValue::from(category.as_str()));
        }
    }
    Ok(query(
        "money.transactions.month",
        TXN_COLUMNS,
        "core_transaction",
        PageOrder::desc("posted_at", "txn_id"),
    )
    .filter(&predicate, bind))
}

/// `money.transaction` — one row by id.
pub fn transaction_statement(txn_id: &str) -> PageQuery {
    query(
        "money.transaction",
        TXN_COLUMNS,
        "core_transaction",
        PageOrder::asc("txn_id", "txn_id"),
    )
    .filter("txn_id = ?", vec![PageBindValue::from(txn_id)])
}

/// `money.imports.last` — the newest import, by its stamp.
pub fn last_import_statement() -> PageQuery {
    query(
        "money.imports.last",
        "txn_id, imported_at, imported_from",
        "money_transaction",
        PageOrder::desc("imported_at", "txn_id"),
    )
}

/// `money.transactions.decorations` — Money's columns for a set of rows.
pub fn decoration_statement(txn_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("txn_id", txn_ids)?;
    Ok(query(
        "money.transactions.decorations",
        "txn_id, display_name, display_name_source, memo, check_number, bank_type, imported_from",
        "money_transaction",
        PageOrder::asc("txn_id", "txn_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `money.accounts` — Money's accounts.
pub fn accounts_statement() -> PageQuery {
    query(
        "money.accounts",
        "account_id, name, kind, on_budget, opening_minor, opening_on, closed_on",
        "money_account",
        PageOrder::asc("account_id", "account_id"),
    )
}

/// `money.accounts.spine` — the spine's currency and bank-side id for them.
pub fn account_spine_statement(account_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("account_id", account_ids)?;
    Ok(query(
        "money.accounts.spine",
        "account_id, currency, external_ref",
        "core_account",
        PageOrder::asc("account_id", "account_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `money.account.ledger` — one account's rows, oldest first, only the columns
/// a balance needs.
pub fn ledger_statement(account_id: &str) -> PageQuery {
    query(
        "money.account.ledger",
        "txn_id, posted_at, amount_minor, direction, status",
        "core_transaction",
        PageOrder::asc("posted_at", "txn_id"),
    )
    .filter("account_id = ?", vec![PageBindValue::from(account_id)])
}

/// `money.account.recent` — one account's newest rows, for a transfer scan.
pub fn recent_statement(account_id: &str) -> PageQuery {
    query(
        "money.account.recent",
        TXN_COLUMNS,
        "core_transaction",
        PageOrder::desc("posted_at", "txn_id"),
    )
    .filter(
        "account_id = ? AND status <> ?",
        vec![PageBindValue::from(account_id), PageBindValue::from("void")],
    )
}

/// `money.targets` — the plans of an inclusive month range.
pub fn targets_statement(from_month: &str, to_month: &str) -> PageQuery {
    query(
        "money.targets",
        "month, category_concept_id, amount_minor, currency, carry",
        "money_target",
        PageOrder::asc("month", "category_concept_id"),
    )
    .filter(
        "month >= ? AND month <= ?",
        vec![
            PageBindValue::from(from_month),
            PageBindValue::from(to_month),
        ],
    )
}

/// `money.rules` — in application order.
pub fn rules_statement() -> PageQuery {
    query(
        "money.rules",
        "rule_id, match_kind, pattern, amount_min_minor, amount_max_minor, account_id, \
         set_category_concept_id, set_display_name, position",
        "money_rule",
        PageOrder::asc("position", "rule_id"),
    )
}

/// `money.checkpoints` — newest first.
pub fn checkpoints_statement() -> PageQuery {
    query(
        "money.checkpoints",
        "account_id, as_of, source, balance_minor, currency",
        "money_balance_checkpoint",
        PageOrder::desc("as_of", "account_id"),
    )
}

/// `money.categories` — the scheme's concepts.
pub fn categories_statement() -> PageQuery {
    query(
        "money.categories",
        "concept_id, notation, pref_label, broader_concept_id",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
    .filter(
        "scheme_id = ?",
        vec![PageBindValue::from(CATEGORIES_SCHEME_ID)],
    )
}

/// `money.categories.archived.concept` — the flags scheme's `archived` concept
/// (found by its notation: a single table, because the vault's paged door takes
/// no join).
pub fn archived_concept_statement() -> PageQuery {
    query(
        "money.categories.archived.concept",
        "concept_id",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
    .filter("notation = ?", vec![PageBindValue::from("archived")])
}

/// `money.categories.archived` — the tags that mark a concept archived.
pub fn archived_statement(flag_concept_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("concept_id", flag_concept_ids)?;
    let mut bind = vec![PageBindValue::from("core.concept")];
    bind.extend(fragment.bind);
    Ok(query(
        "money.categories.archived",
        "tag_id, target_id",
        "core_tag",
        PageOrder::asc("tag_id", "tag_id"),
    )
    .filter(&format!("target_type = ? AND {}", fragment.sql), bind))
}

/// `money.links.transfer` — live transfer links between two transactions.
pub fn transfer_links_statement() -> PageQuery {
    query(
        "money.links.transfer",
        "link_id, from_id, to_id",
        "core_link",
        PageOrder::asc("link_id", "link_id"),
    )
    .filter(
        "from_type = ? AND to_type = ? AND relation_concept_id = ? AND valid_to IS NULL",
        vec![
            PageBindValue::from("core.transaction"),
            PageBindValue::from("core.transaction"),
            PageBindValue::from(TRANSFER_RELATION_ID),
        ],
    )
}

/// `money.import.existing` — an account's rows in a day range, for a plan.
pub fn existing_statement(account_id: &str, from_day: &str, to_day: &str) -> KitResult<PageQuery> {
    let after = civil::shift(to_day, 1).ok_or_else(|| KitError::GrammarRefused {
        query: "money.import.existing".to_owned(),
        why: "not a day".to_owned(),
    })?;
    Ok(query(
        "money.import.existing",
        "txn_id, external_id, posted_at, amount_minor, direction, description, status",
        "core_transaction",
        PageOrder::asc("posted_at", "txn_id"),
    )
    .filter(
        "account_id = ? AND posted_at >= ? AND posted_at < ?",
        vec![
            PageBindValue::from(account_id),
            PageBindValue::from(format!("{from_day}T00:00:00Z")),
            PageBindValue::from(format!("{after}T00:00:00Z")),
        ],
    ))
}

/// `money.import.profile` — the saved layouts of an account.
pub fn profiles_statement(account_id: &str) -> PageQuery {
    query(
        "money.import.profile",
        "account_id, header_fingerprint, delimiter, skip_lines, date_order, sign_mode, \
         date_col, amount_col, debit_col, credit_col, desc_col, memo_col, indicator_col, \
         indicator_out_value",
        "money_import_profile",
        PageOrder::asc("header_fingerprint", "header_fingerprint"),
    )
    .filter("account_id = ?", vec![PageBindValue::from(account_id)])
}

// ---------------------------------------------------------------------------
// Loaders.
// ---------------------------------------------------------------------------

/// Rows asked for in one page: ONE UNDER the door's ceiling of 500.
///
/// The vault's `keyset_page` probes for a next page by asking its own runner for
/// `limit + 1` rows, and that runner clamps to the same 500, so a page asked for
/// at exactly 500 reports no next page and a walk silently stops there (found
/// in the year-3 suite, reported to the root; a vault fix makes this 500 again).
/// At 499 the probe fits under the clamp, and a window over a month of 512 rows
/// is whole.
pub const PAGE_ROWS: usize = 499;

const SMALL: FanOutBound = FanOutBound::new(PAGE_ROWS, 4);
const LARGE: FanOutBound = FanOutBound::new(PAGE_ROWS, 82);

/// A stated window of `rows`, walked page by page (the kit's `read_window`, at
/// [`PAGE_ROWS`]).
fn read_window(door: &dyn PageDoor, query: &PageQuery, rows: usize) -> KitResult<Window> {
    let mut collected: Vec<Row> = Vec::new();
    let mut after = None;
    while collected.len() < rows {
        let want = (rows - collected.len()).min(PAGE_ROWS);
        let page = door.page(
            query,
            &PageRequest {
                limit: want,
                after: after.clone(),
            },
        )?;
        collected.extend(page.rows);
        match page.next {
            None => {
                return Ok(Window {
                    rows: collected,
                    filled: false,
                });
            }
            Some(next) => after = Some(next),
        }
    }
    Ok(Window {
        rows: collected,
        filled: true,
    })
}

fn day_of(row: &Row) -> String {
    text_of(row, "posted_at")
        .map(|stamp| stamp.chars().take(10).collect())
        .unwrap_or_default()
}

fn direction_of(row: &Row) -> Direction {
    if text_of(row, "direction").as_deref() == Some("credit") {
        Direction::Credit
    } else {
        Direction::Debit
    }
}

fn txn_of(row: &Row) -> TxnRow {
    TxnRow {
        txn_id: text_of(row, "txn_id").unwrap_or_default(),
        account_id: text_of(row, "account_id").unwrap_or_default(),
        posted_on: day_of(row),
        amount_minor: integer_or_zero(row, "amount_minor"),
        currency: text_of(row, "currency").unwrap_or_default(),
        direction: direction_of(row),
        status: text_of(row, "status").unwrap_or_default(),
        description: text_of(row, "description").unwrap_or_default(),
        category_concept_id: text_of(row, "category_concept_id"),
        external_id: text_of(row, "external_id"),
        display_name: None,
        display_name_source: None,
        memo: None,
        check_number: None,
        bank_type: None,
        imported_from: None,
    }
}

/// Fills each row's Money columns, `DECORATION_CHUNK` ids to a statement.
pub fn decorate(door: &dyn PageDoor, rows: &mut [TxnRow]) -> KitResult<()> {
    let mut found: BTreeMap<String, Row> = BTreeMap::new();
    let ids: Vec<String> = rows.iter().map(|row| row.txn_id.clone()).collect();
    for chunk in ids.chunks(DECORATION_CHUNK) {
        for row in read_pages(door, &decoration_statement(chunk)?, SMALL)? {
            if let Some(id) = text_of(&row, "txn_id") {
                found.insert(id, row);
            }
        }
    }
    for txn in rows.iter_mut() {
        if let Some(row) = found.get(&txn.txn_id) {
            txn.display_name = text_of(row, "display_name");
            txn.display_name_source = text_of(row, "display_name_source");
            txn.memo = text_of(row, "memo");
            txn.check_number = text_of(row, "check_number");
            txn.bank_type = text_of(row, "bank_type");
            txn.imported_from = text_of(row, "imported_from");
        }
    }
    Ok(())
}

/// A month's rows, decorated; `truncated` when the month held more than
/// [`MONTH_ROWS`].
pub fn load_month(
    door: &dyn PageDoor,
    month: &str,
    filter: &ActivityFilter,
) -> KitResult<Bounded<Vec<TxnRow>>> {
    let mut window = load_month_plain(door, month, filter)?;
    if !window.value.is_empty() {
        decorate(door, &mut window.value)?;
    }
    Ok(window)
}

/// A month's rows without Money's columns: all a fold needs.
pub fn load_month_plain(
    door: &dyn PageDoor,
    month: &str,
    filter: &ActivityFilter,
) -> KitResult<Bounded<Vec<TxnRow>>> {
    let window = read_window(door, &month_statement(month, filter)?, MONTH_ROWS)?;
    Ok(Bounded {
        value: window.rows.iter().map(txn_of).collect(),
        truncated: window.filled,
    })
}

/// The rows of the `months` windows ending at `through_month`, oldest window
/// first and undecorated (a merchant is read off the bank's own words);
/// `truncated` when any window held more than [`MONTH_ROWS`].
pub fn load_lookback(
    door: &dyn PageDoor,
    through_month: &str,
    months: usize,
) -> KitResult<Bounded<Vec<TxnRow>>> {
    let mut rows = Vec::new();
    let mut truncated = false;
    for back in (0..months).rev() {
        let Some(month) = civil::add_months(through_month, -i32::try_from(back).unwrap_or(0))
        else {
            continue;
        };
        let window = read_window(
            door,
            &month_statement(&month, &ActivityFilter::default())?,
            MONTH_ROWS,
        )?;
        truncated |= window.filled;
        rows.extend(window.rows.iter().map(txn_of));
    }
    Ok(Bounded {
        value: rows,
        truncated,
    })
}

/// One page of Activity: a month, filtered, newest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityPage {
    pub rows: Vec<TxnRow>,
    /// The cursor of the next page, if there is one.
    pub next: Option<(String, String)>,
}

/// One keyset page of a month's Activity.
pub fn load_activity_page(
    door: &dyn PageDoor,
    month: &str,
    filter: &ActivityFilter,
    request: &PageRequest,
) -> KitResult<ActivityPage> {
    let request = PageRequest {
        limit: request.limit.min(PAGE_ROWS),
        after: request.after.clone(),
    };
    let page: Page<Row> = read_page(door, &month_statement(month, filter)?, &request)?;
    let mut rows: Vec<TxnRow> = page.rows.iter().map(txn_of).collect();
    if !rows.is_empty() {
        decorate(door, &mut rows)?;
    }
    Ok(ActivityPage {
        rows,
        next: page.next.map(|cursor| (cursor.sort_key, cursor.pk)),
    })
}

/// One transaction with its Money columns, or none.
pub fn load_transaction(door: &dyn PageDoor, txn_id: &str) -> KitResult<Option<TxnRow>> {
    let page = read_page(door, &transaction_statement(txn_id), &PageRequest::first(1))?;
    let mut rows: Vec<TxnRow> = page.rows.iter().map(txn_of).collect();
    if rows.is_empty() {
        return Ok(None);
    }
    decorate(door, &mut rows)?;
    Ok(rows.pop())
}

/// When and from what the newest import came.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastImport {
    pub imported_at: String,
    /// `csv` | `ofx`.
    pub source: String,
    pub account_id: Option<String>,
}

/// The newest import, if any row was ever imported.
pub fn load_last_import(door: &dyn PageDoor) -> KitResult<Option<LastImport>> {
    let page = read_page(door, &last_import_statement(), &PageRequest::first(1))?;
    let Some(row) = page.rows.first() else {
        return Ok(None);
    };
    let account_id = match text_of(row, "txn_id") {
        Some(id) => load_transaction(door, &id)?.map(|t| t.account_id),
        None => None,
    };
    Ok(Some(LastImport {
        imported_at: text_of(row, "imported_at").unwrap_or_default(),
        source: text_of(row, "imported_from").unwrap_or_default(),
        account_id,
    }))
}

/// Money's accounts, with the spine's currency.
pub fn load_accounts(door: &dyn PageDoor) -> KitResult<Vec<AccountRow>> {
    let rows = read_window(door, &accounts_statement(), ACCOUNT_LIMIT)?.rows;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|r| text_of(r, "account_id"))
        .collect();
    let mut spine: BTreeMap<String, Row> = BTreeMap::new();
    for row in read_pages(door, &account_spine_statement(&ids)?, SMALL)? {
        if let Some(id) = text_of(&row, "account_id") {
            spine.insert(id, row);
        }
    }
    Ok(rows
        .iter()
        .map(|row| {
            let id = text_of(row, "account_id").unwrap_or_default();
            let core = spine.get(&id);
            AccountRow {
                name: text_of(row, "name").unwrap_or_default(),
                kind: text_of(row, "kind").unwrap_or_default(),
                on_budget: integer_or_zero(row, "on_budget") != 0,
                opening_minor: integer_or_zero(row, "opening_minor"),
                opening_on: text_of(row, "opening_on"),
                closed_on: text_of(row, "closed_on"),
                currency: core
                    .and_then(|c| text_of(c, "currency"))
                    .unwrap_or_default(),
                external_ref: core.and_then(|c| text_of(c, "external_ref")),
                account_id: id,
            }
        })
        .collect())
}

/// An account's rows for its balance, oldest first; `truncated` means the
/// balance cannot be derived.
pub fn load_ledger(door: &dyn PageDoor, account_id: &str) -> KitResult<Bounded<Vec<TxnRow>>> {
    let window = read_window(door, &ledger_statement(account_id), ACCOUNT_ROWS)?;
    Ok(Bounded {
        value: window
            .rows
            .iter()
            .map(|row| {
                let mut txn = txn_of(row);
                txn.account_id = account_id.to_owned();
                txn
            })
            .collect(),
        truncated: window.filled,
    })
}

/// The plans of an inclusive month range.
pub fn load_targets(
    door: &dyn PageDoor,
    from_month: &str,
    to_month: &str,
) -> KitResult<Bounded<Vec<TargetRow>>> {
    let window = read_window(door, &targets_statement(from_month, to_month), TARGET_ROWS)?;
    Ok(Bounded {
        value: window
            .rows
            .iter()
            .map(|row| TargetRow {
                month: text_of(row, "month").unwrap_or_default(),
                category_concept_id: text_of(row, "category_concept_id").unwrap_or_default(),
                amount_minor: integer_or_zero(row, "amount_minor"),
                currency: text_of(row, "currency").unwrap_or_default(),
                carry: integer_or_zero(row, "carry") != 0,
            })
            .collect(),
        truncated: window.filled,
    })
}

fn kind_of(text: &str) -> MatchKind {
    match text {
        "is" => MatchKind::Is,
        "matches" => MatchKind::Matches,
        _ => MatchKind::Contains,
    }
}

fn optional_integer(row: &Row, column: &str) -> Option<i64> {
    row.get(column)
        .and_then(centraid_apps_kit::row::Cell::integer)
}

/// The rules, at most [`RULES`]; `truncated` when the vault holds more.
pub fn load_rules(door: &dyn PageDoor) -> KitResult<Bounded<Vec<Rule>>> {
    let window = read_window(door, &rules_statement(), RULES)?;
    Ok(Bounded {
        value: window
            .rows
            .iter()
            .map(|row| Rule {
                rule_id: text_of(row, "rule_id").unwrap_or_default(),
                kind: kind_of(&text_of(row, "match_kind").unwrap_or_default()),
                pattern: text_of(row, "pattern").unwrap_or_default(),
                amount_min_minor: optional_integer(row, "amount_min_minor"),
                amount_max_minor: optional_integer(row, "amount_max_minor"),
                account_id: text_of(row, "account_id"),
                category_concept_id: text_of(row, "set_category_concept_id"),
                display_name: text_of(row, "set_display_name"),
                position: integer_or_zero(row, "position"),
            })
            .collect(),
        truncated: window.filled,
    })
}

/// Every checkpoint, newest first, at most [`CHECKPOINT_ROWS`] (one page).
pub fn load_checkpoints(door: &dyn PageDoor) -> KitResult<Bounded<Vec<CheckpointRow>>> {
    let page = read_page(
        door,
        &checkpoints_statement(),
        &PageRequest::first(CHECKPOINT_ROWS),
    )?;
    Ok(Bounded {
        truncated: page.next.is_some(),
        value: page
            .rows
            .iter()
            .map(|row| CheckpointRow {
                account_id: text_of(row, "account_id").unwrap_or_default(),
                as_of: text_of(row, "as_of").unwrap_or_default(),
                source: text_of(row, "source").unwrap_or_default(),
                balance_minor: integer_or_zero(row, "balance_minor"),
                currency: text_of(row, "currency").unwrap_or_default(),
            })
            .collect(),
    })
}

/// The categories scheme, archived ones marked.
pub fn load_categories(door: &dyn PageDoor) -> KitResult<Vec<CategoryRow>> {
    let flags: Vec<String> = read_pages(door, &archived_concept_statement(), SMALL)?
        .iter()
        .filter_map(|row| text_of(row, "concept_id"))
        .collect();
    let archived: BTreeSet<String> = if flags.is_empty() {
        BTreeSet::new()
    } else {
        read_pages(door, &archived_statement(&flags)?, SMALL)?
            .iter()
            .filter_map(|row| text_of(row, "target_id"))
            .collect()
    };
    let rows = read_window(door, &categories_statement(), CATEGORY_ROWS)?.rows;
    Ok(rows
        .iter()
        .map(|row| {
            let concept_id = text_of(row, "concept_id").unwrap_or_default();
            CategoryRow {
                archived: archived.contains(&concept_id),
                notation: text_of(row, "notation").unwrap_or_default(),
                label: text_of(row, "pref_label").unwrap_or_default(),
                parent: text_of(row, "broader_concept_id"),
                concept_id,
            }
        })
        .collect())
}

/// Live transfer links, at most [`LINK_ROWS`].
pub fn load_transfer_links(door: &dyn PageDoor) -> KitResult<Bounded<Vec<TransferLink>>> {
    let window = read_window(door, &transfer_links_statement(), LINK_ROWS)?;
    Ok(Bounded {
        value: window
            .rows
            .iter()
            .map(|row| TransferLink {
                link_id: text_of(row, "link_id").unwrap_or_default(),
                from_txn: text_of(row, "from_id").unwrap_or_default(),
                to_txn: text_of(row, "to_id").unwrap_or_default(),
            })
            .collect(),
        truncated: window.filled,
    })
}

/// The rows an import plan compares against, in the day range
/// [`crate::import::existing_window`] named. A range holding more than
/// [`EXISTING_ROWS`] rows errors (a plan over part of the account would
/// propose duplicates it should have known).
pub fn load_existing(
    door: &dyn PageDoor,
    account_id: &str,
    from_day: &str,
    to_day: &str,
) -> KitResult<Vec<ExistingTxn>> {
    let rows = read_pages(
        door,
        &existing_statement(account_id, from_day, to_day)?,
        LARGE,
    )?;
    Ok(rows
        .iter()
        .map(|row| ExistingTxn {
            txn_id: text_of(row, "txn_id").unwrap_or_default(),
            external_id: text_of(row, "external_id"),
            posted_on: day_of(row),
            amount_minor: integer_or_zero(row, "amount_minor"),
            direction: direction_of(row),
            description: text_of(row, "description").unwrap_or_default(),
            display_name: None,
            void: text_of(row, "status").as_deref() == Some("void"),
        })
        .collect())
}

/// The newest [`MATCH_SCAN_ROWS`] non-void rows of each account.
pub fn load_transfer_candidates(
    door: &dyn PageDoor,
    accounts: &[AccountRow],
) -> KitResult<Vec<TxnRow>> {
    let mut out = Vec::new();
    for account in accounts {
        let window = read_window(
            door,
            &recent_statement(&account.account_id),
            MATCH_SCAN_ROWS,
        )?;
        out.extend(window.rows.iter().map(txn_of));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Search (R-1099-44).
// ---------------------------------------------------------------------------

/// What a search found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHits {
    pub rows: Vec<TxnRow>,
    /// Matches found in the months walked, before `limit`.
    pub total_matches: usize,
    /// The typed words, corrected, if the exact walk found nothing and the
    /// corrected one did.
    pub corrected: Option<String>,
    /// A month hit [`MONTH_ROWS`], so some of its rows were not read. (A walk
    /// always stops at [`SEARCH_MONTHS`]; the screen says how far back it looked.)
    pub truncated: bool,
}

fn searchable(row: &TxnRow, categories: &BTreeMap<String, String>) -> Vec<String> {
    let mut texts = vec![row.description.to_lowercase()];
    texts.extend(row.display_name.as_ref().map(|n| n.to_lowercase()));
    texts.extend(row.memo.as_ref().map(|n| n.to_lowercase()));
    texts.extend(
        row.category_concept_id
            .as_ref()
            .and_then(|id| categories.get(id))
            .map(|label| label.to_lowercase()),
    );
    texts
}

/// Searches the newest [`SEARCH_MONTHS`] months from `month` (inclusive) back:
/// description, the member's name, the category label and the memo, by
/// lowercase `contains`, with the kit's walked-word typo correction. There is
/// no index (Q-1097-1 retired the full-text one); the walk is the search.
pub fn search(
    door: &dyn PageDoor,
    from_month: &str,
    term: &str,
    limit: usize,
) -> KitResult<SearchHits> {
    let needle = term.trim().to_lowercase();
    let empty = SearchHits {
        rows: Vec::new(),
        total_matches: 0,
        corrected: None,
        truncated: false,
    };
    if needle.is_empty() {
        return Ok(empty);
    }
    let categories: BTreeMap<String, String> = load_categories(door)?
        .into_iter()
        .map(|c| (c.concept_id, c.label))
        .collect();
    let mut truncated = false;
    let mut walked: Vec<TxnRow> = Vec::new();
    let mut month = from_month.to_owned();
    for step in 0..SEARCH_MONTHS {
        let window = load_month(door, &month, &ActivityFilter::default())?;
        truncated |= window.truncated;
        walked.extend(window.value);
        if step + 1 < SEARCH_MONTHS {
            match civil::add_months(&month, -1) {
                Some(previous) => month = previous,
                None => break,
            }
        }
    }
    let haystacks: Vec<Vec<String>> = walked.iter().map(|r| searchable(r, &categories)).collect();
    let find = |needle: &str| -> Vec<usize> {
        haystacks
            .iter()
            .enumerate()
            .filter(|(_, texts)| texts.iter().any(|text| text.contains(needle)))
            .map(|(at, _)| at)
            .collect()
    };
    let mut matched = find(&needle);
    let mut corrected = None;
    if matched.is_empty() {
        let mut words = WalkedWords::new();
        for texts in &haystacks {
            words.add_row(texts.iter().map(String::as_str));
        }
        if let Some(words) = words.correct(term) {
            let again = find(&words.to_lowercase());
            if !again.is_empty() {
                matched = again;
                corrected = Some(words);
            }
        }
    }
    Ok(SearchHits {
        total_matches: matched.len(),
        rows: matched
            .into_iter()
            .take(limit)
            .map(|at| walked[at].clone())
            .collect(),
        corrected,
        truncated,
    })
}
