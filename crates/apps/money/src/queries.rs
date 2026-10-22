//! MONEY'S READS, as statements-as-data with stated ceilings.
//!
//! **There is no SQL in this crate.** A statement is a
//! [`centraid_apps_kit::PageQuery`] and the kit is the only place that turns
//! one into a statement. Every read here is bounded by a number this module
//! states, and a read that reaches its ceiling says so in its value
//! (`filled`/`truncated`) rather than answering short: **a balance or a total
//! derived from a silently short ledger is a wrong number, not a slow screen.**
//!
//! ## The model Money reads (#1135)
//!
//! A line is a `txn` row: the account, the day, the signed amount, a status, a
//! category and the other half of a transfer. What the member calls it is the
//! entity's `title`; **what the bank said** (its words, a memo, a check number,
//! the file format) is what the statement origin's `source` row last stated. The
//! paged door serves one table per statement, so a screen is a keyset window of
//! `txn` and then, for the ids it returned, one bounded read of `entity` (the
//! name, and whether the line is in the trash) and one of `source` (the bank's
//! words). An account is its `account` row, its entity (the name), its statement
//! `origin` (the bank number is the origin's `ref`, the remembered column layout
//! its `config`) and the `archived` flag edge that closes it. A category is a
//! `concept` of kind `category` under its group, a plan a `budget` row.
//!
//! The ceilings:
//!
//! | Name | Value | What it bounds |
//! | --- | --- | --- |
//! | [`MONTH_ROWS`] | 2,000 | one month window of one vault |
//! | [`CASHFLOW_MONTHS`] | 12 | the windows the cash-flow screen folds |
//! | [`SEARCH_ROWS`] | 200 | the lines one search answers, best match first |
//! | [`ACCOUNT_ROWS`] | 40,000 | one account's whole history, for its balance |
//! | [`MATCH_SCAN_ROWS`] | 500 | the newest rows of each account a transfer is looked for among |
//! | [`EXISTING_ROWS`] | 40,000 | the rows an import plan compares against |
//! | [`crate::rules::RULES`] | 500 | rules |

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::Denial;
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::{Page, PageRequest};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, Read, Window, read_page, read_pages};
use centraid_apps_kit::row::{Cell, Row, integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_search::{Answer, Principal, Search, SearchError, SearchRequest};

use crate::civil;
use crate::import::{Direction, ExistingTxn};
use crate::rules::{MatchKind, RULES, Rule};

/// One month window of transactions.
pub const MONTH_ROWS: usize = 2_000;
/// The month windows the cash-flow fold reads.
pub const CASHFLOW_MONTHS: usize = 12;
/// One account's whole history, for a derived balance.
pub const ACCOUNT_ROWS: usize = 40_000;
/// Newest rows per account a transfer is looked for among.
pub const MATCH_SCAN_ROWS: usize = 500;
/// Rows an import plan compares against.
pub const EXISTING_ROWS: usize = 40_000;
/// Accounts a vault lists.
pub const ACCOUNT_LIMIT: usize = 200;
/// Plans read at once (13 months of ~40 categories is 520).
pub const TARGET_ROWS: usize = 1_000;
/// Checkpoints read at once; one page, so no keyset ties can matter.
pub const CHECKPOINT_ROWS: usize = 400;
/// Categories, including archived ones.
pub const CATEGORY_ROWS: usize = 300;
/// Live transfers.
pub const LINK_ROWS: usize = 2_000;
/// Lines in the trash that a read subtracts from its window.
pub const TRASHED_ROWS: usize = 40_000;

/// The group a category belongs to when it is income: the seeded group's id.
pub const INCOME_GROUP: &str = "category:income";
/// The flag that closes an account and archives a category.
pub const ARCHIVED: &str = "flag:archived";

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

/// An account as Money shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountRow {
    pub account_id: String,
    pub name: String,
    /// `checking` | `savings` | `credit_card` | `cash`.
    pub kind: String,
    pub on_budget: bool,
    /// Where the account stood before its first line.
    pub opening_minor: i64,
    /// The day the account was closed (the `archived` flag's), if it was.
    pub closed_on: Option<String>,
    pub currency: String,
    /// The bank's account number, if the member entered one.
    pub external_ref: Option<String>,
}

/// A transaction as Money shows it: the line, the member's name for it and what
/// the bank said.
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
    /// The other half of a transfer the member accepted.
    pub transfer_id: Option<String>,
    /// The member's name for it, when it is not the bank's words.
    pub display_name: Option<String>,
    /// `member`, when [`Self::display_name`] is set.
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

/// One live transfer: the debit end `from`, the credit end `to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferLink {
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

const TXN_COLUMNS: &str =
    "id, account_id, posted_on, amount_minor, currency, status, category_id, transfer_id";

/// `money.transactions.month` — a month's rows by `posted_on` range, newest
/// first. The month is a bind, never a pattern: `posted_on` is a printed day
/// (R-1099-2) and a range uses the index.
pub fn month_statement(month: &str, filter: &ActivityFilter) -> KitResult<PageQuery> {
    let next = civil::add_months(month, 1).ok_or_else(|| KitError::GrammarRefused {
        query: "money.transactions.month".to_owned(),
        why: "not a month".to_owned(),
    })?;
    let mut predicate = String::from("posted_on >= ? AND posted_on < ?");
    let mut bind = vec![
        PageBindValue::from(format!("{month}-01")),
        PageBindValue::from(format!("{next}-01")),
    ];
    if let Some(account) = &filter.account_id {
        predicate.push_str(" AND account_id = ?");
        bind.push(PageBindValue::from(account.as_str()));
    }
    match &filter.category {
        CategoryFilter::Any => {}
        CategoryFilter::Uncategorised => {
            predicate.push_str(" AND category_id IS NULL AND status <> 'void'");
        }
        CategoryFilter::Is(category) => {
            predicate.push_str(" AND category_id = ?");
            bind.push(PageBindValue::from(category.as_str()));
        }
    }
    Ok(query(
        "money.transactions.month",
        TXN_COLUMNS,
        "txn",
        PageOrder::desc("posted_on", "id"),
    )
    .filter(&predicate, bind))
}

/// `money.transaction` — one row by id.
pub fn transaction_statement(txn_id: &str) -> PageQuery {
    query(
        "money.transaction",
        TXN_COLUMNS,
        "txn",
        PageOrder::asc("id", "id"),
    )
    .filter("id = ?", vec![PageBindValue::from(txn_id)])
}

/// `money.imports.last` — the newest statement line, by when a statement last
/// spoke of it.
pub fn last_import_statement() -> PageQuery {
    query(
        "money.imports.last",
        "id, entity_id, seen_at, stated",
        "source",
        PageOrder::desc("seen_at", "id"),
    )
    .filter(
        "system = ? AND entity_id IS NOT NULL",
        vec![PageBindValue::from("statement")],
    )
}

/// The member's name and whether it is in the trash, for a set of lines.
const ENTITIES: Read = Read {
    name: "money.transactions.entities",
    table: "entity",
    select: "id, title, deleted_at",
    order: ("id", "id"),
    column: "id",
};

/// What a statement last said of a set of lines.
const STATEMENTS: Read = Read {
    name: "money.transactions.statements",
    table: "source",
    select: "entity_id, external_id, stated",
    order: ("entity_id", "entity_id"),
    column: "entity_id",
};

/// `money.transactions.trashed` — the lines in the trash (a trashed account takes
/// its lines with it), which a window subtracts.
pub fn trashed_statement() -> PageQuery {
    query(
        "money.transactions.trashed",
        "id",
        "entity",
        PageOrder::asc("id", "id"),
    )
    .filter(
        "kind = ? AND deleted_at IS NOT NULL",
        vec![PageBindValue::from("txn")],
    )
}

/// `money.accounts` — Money's accounts.
pub fn accounts_statement() -> PageQuery {
    query(
        "money.accounts",
        "id, type, currency, opening_minor, on_budget",
        "account",
        PageOrder::asc("id", "id"),
    )
}

/// `money.accounts.entities` — the accounts' names, and which are in the trash.
pub fn account_entities_statement() -> PageQuery {
    query(
        "money.accounts.entities",
        "id, title",
        "entity",
        PageOrder::asc("id", "id"),
    )
    .filter(
        "kind = ? AND deleted_at IS NULL",
        vec![PageBindValue::from("account")],
    )
}

/// `money.accounts.origins` — the statement origins: the bank's number is each
/// one's `ref`, its remembered column layout its `config`.
pub fn origins_statement() -> PageQuery {
    query(
        "money.accounts.origins",
        "id, ref, fills, config",
        "origin",
        PageOrder::asc("id", "id"),
    )
    .filter("system = ?", vec![PageBindValue::from("statement")])
}

/// `money.archived` — everything carrying the `archived` flag (a closed account,
/// an archived category) and when it was marked.
pub fn archived_statement() -> PageQuery {
    query(
        "money.archived",
        "from_id, created_at",
        "edge",
        PageOrder::asc("from_id", "from_id"),
    )
    .filter(
        "rel = ? AND to_id = ?",
        vec![PageBindValue::from("tagged"), PageBindValue::from(ARCHIVED)],
    )
}

/// `money.account.ledger` — one account's rows, oldest first, only the columns
/// a balance needs.
pub fn ledger_statement(account_id: &str) -> PageQuery {
    query(
        "money.account.ledger",
        "id, posted_on, amount_minor, status",
        "txn",
        PageOrder::asc("posted_on", "id"),
    )
    .filter("account_id = ?", vec![PageBindValue::from(account_id)])
}

/// `money.account.recent` — one account's newest rows, for a transfer scan.
pub fn recent_statement(account_id: &str) -> PageQuery {
    query(
        "money.account.recent",
        TXN_COLUMNS,
        "txn",
        PageOrder::desc("posted_on", "id"),
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
        "month, category_id, amount_minor, currency, carry",
        "budget",
        PageOrder::asc("month", "category_id"),
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
        "id, pattern, category_id, position",
        "rule",
        PageOrder::asc("position", "id"),
    )
}

/// `money.checkpoints` — newest first.
pub fn checkpoints_statement() -> PageQuery {
    query(
        "money.checkpoints",
        "account_id, day, balance_minor",
        "checkpoint",
        PageOrder::desc("day", "account_id"),
    )
}

/// `money.categories` — the categories and the groups they sit under.
pub fn categories_statement() -> PageQuery {
    query(
        "money.categories",
        "id, key, parent_id",
        "concept",
        PageOrder::asc("id", "id"),
    )
    .filter("kind = ?", vec![PageBindValue::from("category")])
}

/// `money.categories.entities` — their names.
pub fn category_entities_statement() -> PageQuery {
    query(
        "money.categories.entities",
        "id, title",
        "entity",
        PageOrder::asc("id", "id"),
    )
    .filter(
        "kind = ? AND deleted_at IS NULL",
        vec![PageBindValue::from("category")],
    )
}

/// `money.links.transfer` — the debit half of each transfer the member accepted;
/// `transfer_id` is the credit half.
pub fn transfer_links_statement() -> PageQuery {
    query(
        "money.links.transfer",
        "id, transfer_id",
        "txn",
        PageOrder::asc("id", "id"),
    )
    .filter(
        "transfer_id IS NOT NULL AND amount_minor < ?",
        vec![PageBindValue::from(0_i64)],
    )
}

/// `money.import.existing` — an account's rows in a day range, for a plan.
pub fn existing_statement(account_id: &str, from_day: &str, to_day: &str) -> KitResult<PageQuery> {
    Ok(query(
        "money.import.existing",
        TXN_COLUMNS,
        "txn",
        PageOrder::asc("posted_on", "id"),
    )
    .filter(
        "account_id = ? AND posted_on >= ? AND posted_on <= ?",
        vec![
            PageBindValue::from(account_id),
            PageBindValue::from(from_day),
            PageBindValue::from(to_day),
        ],
    ))
}

// ---------------------------------------------------------------------------
// Loaders.
// ---------------------------------------------------------------------------

/// Rows asked for in one page.
///
/// The door's ceiling: the vault's `keyset_page` serves a page asked at exactly
/// 500 with its `next` intact (#1099 W4-a).
pub const PAGE_ROWS: usize = 500;

const SMALL: FanOutBound = FanOutBound::new(PAGE_ROWS, 4);
const LARGE: FanOutBound = FanOutBound::new(PAGE_ROWS, 82);
/// One chunk of ids, one page of its rows.
const CHUNK: FanOutBound = FanOutBound::new(PAGE_ROWS, 2);

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

fn real_of(row: &Row, column: &str) -> f64 {
    match row.get(column) {
        Some(Cell::Real(value)) => *value,
        #[allow(clippy::cast_precision_loss)]
        Some(Cell::Integer(value)) => *value as f64,
        _ => 0.0,
    }
}

/// The base columns of a line; the bank's words and the member's name are
/// [`decorate`]'s. The amount is signed in the vault and a magnitude here.
fn txn_of(row: &Row) -> TxnRow {
    let signed = integer_or_zero(row, "amount_minor");
    TxnRow {
        txn_id: text_of(row, "id").unwrap_or_default(),
        account_id: text_of(row, "account_id").unwrap_or_default(),
        posted_on: text_of(row, "posted_on").unwrap_or_default(),
        amount_minor: signed.abs(),
        currency: text_of(row, "currency").unwrap_or_default(),
        direction: if signed < 0 {
            Direction::Debit
        } else {
            Direction::Credit
        },
        status: text_of(row, "status").unwrap_or_default(),
        description: String::new(),
        category_concept_id: text_of(row, "category_id"),
        external_id: None,
        transfer_id: text_of(row, "transfer_id"),
        display_name: None,
        display_name_source: None,
        memo: None,
        check_number: None,
        bank_type: None,
        imported_from: None,
    }
}

/// The lines in the trash.
fn trashed(door: &dyn PageDoor) -> KitResult<BTreeSet<String>> {
    Ok(read_pages(door, &trashed_statement(), LARGE)?
        .iter()
        .filter_map(|row| text_of(row, "id"))
        .collect())
}

/// Takes the lines in the trash out of a window.
fn drop_trashed(door: &dyn PageDoor, rows: &mut Vec<TxnRow>) -> KitResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let gone = trashed(door)?;
    if !gone.is_empty() {
        rows.retain(|row| !gone.contains(&row.txn_id));
    }
    Ok(())
}

fn stated_text(stated: &serde_json::Value, path: &[&str]) -> Option<String> {
    let mut at = stated;
    for key in path {
        at = at.get(key)?;
    }
    at.as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// Fills each row's words: what the bank said (its text, memo, check number,
/// type and file format, from the statement the line came in) and the member's
/// name for it when it differs. Takes lines in the trash out.
pub fn decorate(door: &dyn PageDoor, rows: &mut Vec<TxnRow>) -> KitResult<()> {
    let mut entities: BTreeMap<String, Row> = BTreeMap::new();
    let mut statements: BTreeMap<String, Row> = BTreeMap::new();
    let ids: Vec<String> = rows.iter().map(|row| row.txn_id.clone()).collect();
    for chunk in ids.chunks(PAGE_ROWS) {
        for row in ENTITIES.within(CHUNK, door, chunk, None)? {
            if let Some(id) = text_of(&row, "id") {
                entities.insert(id, row);
            }
        }
        for row in STATEMENTS.within(CHUNK, door, chunk, None)? {
            if let Some(id) = text_of(&row, "entity_id") {
                statements.insert(id, row);
            }
        }
    }
    rows.retain(|row| {
        entities
            .get(&row.txn_id)
            .is_none_or(|entity| matches!(entity.get("deleted_at"), None | Some(Cell::Null)))
    });
    for txn in rows.iter_mut() {
        let title = entities
            .get(&txn.txn_id)
            .and_then(|entity| text_of(entity, "title"))
            .unwrap_or_default();
        let source = statements.get(&txn.txn_id);
        let stated = source
            .and_then(|row| text_of(row, "stated"))
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .unwrap_or(serde_json::Value::Null);
        txn.external_id = source.and_then(|row| text_of(row, "external_id"));
        txn.description = stated_text(&stated, &["title"]).unwrap_or_else(|| title.clone());
        if !title.is_empty() && title != txn.description {
            txn.display_name = Some(title);
            txn.display_name_source = Some("member".to_owned());
        }
        txn.memo = stated_text(&stated, &["line", "memo"]);
        txn.check_number = stated_text(&stated, &["line", "check_number"]);
        txn.bank_type = stated_text(&stated, &["line", "bank_type"]);
        txn.imported_from = stated_text(&stated, &["line", "imported_from"]);
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
    let mut window = load_month_base(door, month, filter)?;
    decorate(door, &mut window.value)?;
    Ok(window)
}

/// A month's rows without their words: all a fold needs.
pub fn load_month_plain(
    door: &dyn PageDoor,
    month: &str,
    filter: &ActivityFilter,
) -> KitResult<Bounded<Vec<TxnRow>>> {
    let mut window = load_month_base(door, month, filter)?;
    drop_trashed(door, &mut window.value)?;
    Ok(window)
}

fn load_month_base(
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
/// first and decorated (a merchant is read off the bank's own words);
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
    decorate(door, &mut rows)?;
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
    decorate(door, &mut rows)?;
    Ok(ActivityPage {
        rows,
        next: page.next.map(|cursor| (cursor.sort_key, cursor.pk)),
    })
}

/// One transaction with its words, or none.
pub fn load_transaction(door: &dyn PageDoor, txn_id: &str) -> KitResult<Option<TxnRow>> {
    let page = read_page(door, &transaction_statement(txn_id), &PageRequest::first(1))?;
    let mut rows: Vec<TxnRow> = page.rows.iter().map(txn_of).collect();
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

/// The newest import, if any line was ever imported.
pub fn load_last_import(door: &dyn PageDoor) -> KitResult<Option<LastImport>> {
    let page = read_page(door, &last_import_statement(), &PageRequest::first(1))?;
    let Some(row) = page.rows.first() else {
        return Ok(None);
    };
    let stated = text_of(row, "stated")
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .unwrap_or(serde_json::Value::Null);
    let account_id = match text_of(row, "entity_id") {
        Some(id) => load_transaction(door, &id)?.map(|t| t.account_id),
        None => None,
    };
    Ok(Some(LastImport {
        imported_at: text_of(row, "seen_at").unwrap_or_default(),
        source: stated_text(&stated, &["line", "imported_from"]).unwrap_or_default(),
        account_id,
    }))
}

/// The days the `archived` flag was put on, by what carries it.
fn archived_on(door: &dyn PageDoor) -> KitResult<BTreeMap<String, String>> {
    Ok(read_pages(door, &archived_statement(), SMALL)?
        .iter()
        .filter_map(|row| {
            Some((
                text_of(row, "from_id")?,
                text_of(row, "created_at")?.chars().take(10).collect(),
            ))
        })
        .collect())
}

/// The bank's number and the remembered layout of each account, by account id.
struct Origin {
    reference: String,
    config: Option<String>,
}

fn origins(door: &dyn PageDoor) -> KitResult<BTreeMap<String, Origin>> {
    Ok(read_pages(door, &origins_statement(), SMALL)?
        .iter()
        .filter_map(|row| {
            Some((
                text_of(row, "fills")?,
                Origin {
                    reference: text_of(row, "ref")?,
                    config: text_of(row, "config"),
                },
            ))
        })
        .collect())
}

/// Money's accounts (those not in the trash), with their currency, the bank's
/// number and the day they were closed.
pub fn load_accounts(door: &dyn PageDoor) -> KitResult<Vec<AccountRow>> {
    let rows = read_window(door, &accounts_statement(), ACCOUNT_LIMIT)?.rows;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let names: BTreeMap<String, String> = read_pages(door, &account_entities_statement(), SMALL)?
        .iter()
        .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
        .collect();
    let origins = origins(door)?;
    let closed = archived_on(door)?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let id = text_of(row, "id")?;
            let name = names.get(&id)?.clone();
            // With no number the origin's `ref` is the account's own id.
            let external_ref = origins
                .get(&id)
                .map(|origin| origin.reference.clone())
                .filter(|reference| *reference != id);
            Some(AccountRow {
                name,
                kind: text_of(row, "type").unwrap_or_default(),
                on_budget: integer_or_zero(row, "on_budget") != 0,
                opening_minor: integer_or_zero(row, "opening_minor"),
                closed_on: closed.get(&id).cloned(),
                currency: text_of(row, "currency").unwrap_or_default(),
                external_ref,
                account_id: id,
            })
        })
        .collect())
}

/// An account's rows for its balance, oldest first; `truncated` means the
/// balance cannot be derived.
pub fn load_ledger(door: &dyn PageDoor, account_id: &str) -> KitResult<Bounded<Vec<TxnRow>>> {
    let window = read_window(door, &ledger_statement(account_id), ACCOUNT_ROWS)?;
    let mut rows: Vec<TxnRow> = window
        .rows
        .iter()
        .map(|row| {
            let mut txn = txn_of(row);
            txn.account_id = account_id.to_owned();
            txn
        })
        .collect();
    drop_trashed(door, &mut rows)?;
    Ok(Bounded {
        value: rows,
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
                category_concept_id: text_of(row, "category_id").unwrap_or_default(),
                amount_minor: integer_or_zero(row, "amount_minor"),
                currency: text_of(row, "currency").unwrap_or_default(),
                carry: integer_or_zero(row, "carry") != 0,
            })
            .collect(),
        truncated: window.filled,
    })
}

/// A rule's pattern is one JSON value: `{"match", "text", "min", "max", "account"}`.
fn rule_of(row: &Row) -> Rule {
    let pattern: serde_json::Value = text_of(row, "pattern")
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(serde_json::Value::Null);
    let bound = |key: &str| pattern.get(key).and_then(serde_json::Value::as_i64);
    #[allow(clippy::cast_possible_truncation)]
    let position = real_of(row, "position") as i64;
    Rule {
        rule_id: text_of(row, "id").unwrap_or_default(),
        kind: match pattern.get("match").and_then(serde_json::Value::as_str) {
            Some("is") => MatchKind::Is,
            Some("matches") => MatchKind::Matches,
            _ => MatchKind::Contains,
        },
        pattern: stated_text(&pattern, &["text"]).unwrap_or_default(),
        amount_min_minor: bound("min"),
        amount_max_minor: bound("max"),
        account_id: stated_text(&pattern, &["account"]),
        category_concept_id: text_of(row, "category_id"),
        position,
    }
}

/// The rules, at most [`RULES`]; `truncated` when the vault holds more.
pub fn load_rules(door: &dyn PageDoor) -> KitResult<Bounded<Vec<Rule>>> {
    let window = read_window(door, &rules_statement(), RULES)?;
    Ok(Bounded {
        value: window.rows.iter().map(rule_of).collect(),
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
    let currencies: BTreeMap<String, String> =
        read_window(door, &accounts_statement(), ACCOUNT_LIMIT)?
            .rows
            .iter()
            .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "currency")?)))
            .collect();
    Ok(Bounded {
        truncated: page.next.is_some(),
        value: page
            .rows
            .iter()
            .map(|row| {
                let account_id = text_of(row, "account_id").unwrap_or_default();
                CheckpointRow {
                    currency: currencies.get(&account_id).cloned().unwrap_or_default(),
                    account_id,
                    as_of: text_of(row, "day").unwrap_or_default(),
                    balance_minor: integer_or_zero(row, "balance_minor"),
                }
            })
            .collect(),
    })
}

/// The categories, archived ones marked.
pub fn load_categories(door: &dyn PageDoor) -> KitResult<Vec<CategoryRow>> {
    let archived = archived_on(door)?;
    let names: BTreeMap<String, String> = read_pages(door, &category_entities_statement(), SMALL)?
        .iter()
        .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
        .collect();
    let rows = read_window(door, &categories_statement(), CATEGORY_ROWS)?.rows;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let concept_id = text_of(row, "id")?;
            Some(CategoryRow {
                archived: archived.contains_key(&concept_id),
                notation: text_of(row, "key").unwrap_or_default(),
                label: names.get(&concept_id)?.clone(),
                parent: text_of(row, "parent_id"),
                concept_id,
            })
        })
        .collect())
}

/// Live transfers, at most [`LINK_ROWS`].
pub fn load_transfer_links(door: &dyn PageDoor) -> KitResult<Bounded<Vec<TransferLink>>> {
    let window = read_window(door, &transfer_links_statement(), LINK_ROWS)?;
    Ok(Bounded {
        value: window
            .rows
            .iter()
            .map(|row| TransferLink {
                from_txn: text_of(row, "id").unwrap_or_default(),
                to_txn: text_of(row, "transfer_id").unwrap_or_default(),
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
    let mut lines: Vec<TxnRow> = rows.iter().map(txn_of).collect();
    decorate(door, &mut lines)?;
    Ok(lines
        .into_iter()
        .map(|line| ExistingTxn {
            void: line.status == "void",
            txn_id: line.txn_id,
            external_id: line.external_id,
            posted_on: line.posted_on,
            amount_minor: line.amount_minor,
            direction: line.direction,
            description: line.description,
            display_name: line.display_name,
        })
        .collect())
}

fn column_of(layout: &serde_json::Value, key: &str) -> Option<usize> {
    layout
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
}

/// The layout remembered for an account: the one its statements were last read
/// with, if any.
pub fn load_saved_profiles(
    door: &dyn PageDoor,
    account_id: &str,
) -> KitResult<Vec<crate::import::SavedProfile>> {
    let layout = origins(door)?
        .remove(account_id)
        .and_then(|origin| origin.config)
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    Ok(layout
        .map(|layout| crate::import::SavedProfile {
            header_fingerprint: stated_text(&layout, &["header_fingerprint"]).unwrap_or_default(),
            delimiter: stated_text(&layout, &["delimiter"]).unwrap_or_default(),
            skip_lines: column_of(&layout, "skip_lines").unwrap_or(0),
            date_order: stated_text(&layout, &["date_order"]).unwrap_or_default(),
            sign_mode: stated_text(&layout, &["sign_mode"]).unwrap_or_default(),
            date_col: column_of(&layout, "date_col").unwrap_or(0),
            amount_col: column_of(&layout, "amount_col"),
            debit_col: column_of(&layout, "debit_col"),
            credit_col: column_of(&layout, "credit_col"),
            desc_col: column_of(&layout, "desc_col").unwrap_or(0),
            memo_col: column_of(&layout, "memo_col"),
            indicator_col: column_of(&layout, "indicator_col"),
            indicator_out_value: stated_text(&layout, &["indicator_out_value"]),
        })
        .into_iter()
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
    decorate(door, &mut out)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Search.
// ---------------------------------------------------------------------------

/// The most transactions one search answers.
pub const SEARCH_ROWS: usize = 200;

/// The kind a transaction is in the full-text index.
pub const TXN_KIND: &str = "txn";

/// What a search found: the lines, best match first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchData {
    pub rows: Vec<TxnRow>,
}

/// The lines among a set of ids.
const TXNS: Read = Read {
    name: "money.search.transactions",
    table: "txn",
    select: TXN_COLUMNS,
    order: ("id", "id"),
    column: "id",
};

/// The lines the full-text index ranked, as rows, in the index's order.
///
/// A line in the trash is dropped ([`decorate`]). A hit the table no longer
/// holds is dropped too.
///
/// # Errors
///
/// A door refusal or a reached bound, as every read here.
pub fn load_search(door: &dyn PageDoor, ids: &[String]) -> KitResult<SearchData> {
    let mut found: BTreeMap<String, TxnRow> = BTreeMap::new();
    for chunk in ids.chunks(PAGE_ROWS) {
        for row in TXNS.within(CHUNK, door, chunk, None)? {
            let line = txn_of(&row);
            found.insert(line.txn_id.clone(), line);
        }
    }
    let mut rows: Vec<TxnRow> = ids.iter().filter_map(|id| found.remove(id)).collect();
    decorate(door, &mut rows)?;
    Ok(SearchData { rows })
}

/// Search the ledger from a term: the full-text index over every transaction
/// ever imported, ranked, its title (what the member calls the line) first and
/// the bank's words, the category, the account and the notes about it after.
/// A blank term, a term with no searchable word and a zero `limit` answer the
/// empty shape and no denial; a door the index cannot use at all is the answer's
/// denial, because a surface renders it.
///
/// # Errors
///
/// A reached bound, as [`load_search`].
pub fn load_search_term(
    door: &dyn PageDoor,
    search: &dyn Search,
    principal: &Principal,
    term: &str,
    limit: usize,
) -> KitResult<(SearchData, Option<Denial>)> {
    let term = term.trim();
    if term.is_empty() || limit == 0 {
        return Ok((SearchData::default(), None));
    }
    let request = SearchRequest::new(TXN_KIND, term, limit.min(SEARCH_ROWS));
    let page = match search.query(principal, &request) {
        Ok(Answer::Data { page, .. }) => page,
        Ok(Answer::Denied(denial)) => {
            return Ok((
                SearchData::default(),
                Some(Denial {
                    code: denial.code,
                    message: denial.message,
                    revoked_at: denial.revoked_at,
                }),
            ));
        }
        Err(SearchError::NoSearchableWords { .. }) => return Ok((SearchData::default(), None)),
        Err(other) => {
            return Ok((
                SearchData::default(),
                Some(Denial {
                    code: None,
                    message: Some(other.to_string()),
                    revoked_at: None,
                }),
            ));
        }
    };
    let ids: Vec<String> = page.rows.into_iter().map(|target| target.id).collect();
    match load_search(door, &ids) {
        Ok(data) => Ok((data, None)),
        Err(KitError::Door(message)) => Ok((
            SearchData::default(),
            Some(Denial {
                code: None,
                message: Some(message),
                revoked_at: None,
            }),
        )),
        Err(other) => Err(other),
    }
}
