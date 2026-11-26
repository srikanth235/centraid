use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{DEFAULT_PAGE, Param, ParamTy, Read, ReadDecl, Shape, asc, desc, param, read};

use super::{Held, Titled, Trashed, trash};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountSummary {
    pub id: String,
    pub title: String,
    pub account_type: String,
    pub currency: String,
    pub opening_minor: i64,
    pub opening_on: Option<String>,
    pub on_budget: bool,
    pub archived_at: Option<String>,
    pub starred_at: Option<String>,
}

impl AccountSummary {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            account_type: row.get("account_type")?,
            currency: row.get("currency")?,
            opening_minor: row.get("opening_minor")?,
            opening_on: row.get("opening_on")?,
            on_budget: row.get::<_, i64>("on_budget")? != 0,
            archived_at: row.get("archived_at")?,
            starred_at: row.get("starred_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountBalance {
    pub total_minor: i64,
    pub txn_count: i64,
}

impl AccountBalance {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            total_minor: row.get("total_minor")?,
            txn_count: row.get("txn_count")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountLayout {
    pub id: String,
    pub config: Option<String>,
}

impl AccountLayout {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            config: row.get("config")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxnSummary {
    pub id: String,
    pub title: String,
    pub account_id: String,
    pub account_title: String,
    pub currency: String,
    pub posted_on: String,
    pub amount_minor: i64,
    pub status: String,
    pub entered: String,
    pub memo: Option<String>,
    pub starred_at: Option<String>,
}

impl TxnSummary {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            account_id: row.get("account_id")?,
            account_title: row.get("account_title")?,
            currency: row.get("currency")?,
            posted_on: row.get("posted_on")?,
            amount_minor: row.get("amount_minor")?,
            status: row.get("status")?,
            entered: row.get("entered")?,
            memo: row.get("memo")?,
            starred_at: row.get("starred_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxnDetail {
    pub id: String,
    pub title: String,
    pub account_id: String,
    pub account_title: String,
    pub currency: String,
    pub posted_on: String,
    pub amount_minor: i64,
    pub status: String,
    pub entered: String,
    pub memo: Option<String>,
    pub original_amount_minor: Option<i64>,
    pub original_currency: Option<String>,
    pub starred_at: Option<String>,
    pub arrived_via: Option<String>,
    pub arrived_label: Option<String>,
    pub updated_at: String,
}

impl TxnDetail {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            account_id: row.get("account_id")?,
            account_title: row.get("account_title")?,
            currency: row.get("currency")?,
            posted_on: row.get("posted_on")?,
            amount_minor: row.get("amount_minor")?,
            status: row.get("status")?,
            entered: row.get("entered")?,
            memo: row.get("memo")?,
            original_amount_minor: row.get("original_amount_minor")?,
            original_currency: row.get("original_currency")?,
            starred_at: row.get("starred_at")?,
            arrived_via: row.get("arrived_via")?,
            arrived_label: row.get("arrived_label")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TxnSplit {
    pub txn_id: String,
    pub position: f64,
    pub category_id: String,
    pub category_title: String,
    pub amount_minor: i64,
    pub memo: Option<String>,
}

impl TxnSplit {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            txn_id: row.get("txn_id")?,
            position: row.get("position")?,
            category_id: row.get("category_id")?,
            category_title: row.get("category_title")?,
            amount_minor: row.get("amount_minor")?,
            memo: row.get("memo")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxnSource {
    pub id: String,
    pub stated_title: Option<String>,
    pub stated: String,
    pub seen_at: String,
}

impl TxnSource {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            stated_title: row.get("stated_title")?,
            stated: row.get("stated")?,
            seen_at: row.get("seen_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferPair {
    pub a_id: String,
    pub b_id: String,
    pub a_title: String,
    pub b_title: String,
    pub a_minor: i64,
    pub b_minor: i64,
    pub a_currency: String,
    pub b_currency: String,
    pub a_day: String,
    pub b_day: String,
}

impl TransferPair {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            a_id: row.get("a_id")?,
            b_id: row.get("b_id")?,
            a_title: row.get("a_title")?,
            b_title: row.get("b_title")?,
            a_minor: row.get("a_minor")?,
            b_minor: row.get("b_minor")?,
            a_currency: row.get("a_currency")?,
            b_currency: row.get("b_currency")?,
            a_day: row.get("a_day")?,
            b_day: row.get("b_day")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpendingTotal {
    pub total_minor: i64,
    pub line_count: i64,
}

impl SpendingTotal {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            total_minor: row.get("total_minor")?,
            line_count: row.get("line_count")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CashflowTotal {
    pub inflow_minor: i64,
    pub outflow_minor: i64,
    pub line_count: i64,
}

impl CashflowTotal {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            inflow_minor: row.get("inflow_minor")?,
            outflow_minor: row.get("outflow_minor")?,
            line_count: row.get("line_count")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetRow {
    pub category_id: String,
    pub category_title: String,
    pub month: String,
    pub amount_minor: i64,
    pub carry: bool,
}

impl BudgetRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            category_id: row.get("category_id")?,
            category_title: row.get("category_title")?,
            month: row.get("month")?,
            amount_minor: row.get("amount_minor")?,
            carry: row.get::<_, i64>("carry")? != 0,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryRow {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub color: Option<String>,
}

impl CategoryRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            parent_id: row.get("parent_id")?,
            color: row.get("color")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuleRow {
    pub id: String,
    pub pattern: String,
    pub display_name: Option<String>,
    pub category_id: String,
    pub category_title: String,
    pub position: f64,
}

impl RuleRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            pattern: row.get("pattern")?,
            display_name: row.get("display_name")?,
            category_id: row.get("category_id")?,
            category_title: row.get("category_title")?,
            position: row.get("position")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointRow {
    pub account_id: String,
    pub day: String,
    pub balance_minor: i64,
}

impl CheckpointRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            account_id: row.get("account_id")?,
            day: row.get("day")?,
            balance_minor: row.get("balance_minor")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchDismissalRow {
    pub hand_id: String,
    pub statement_id: String,
    pub hand_title: String,
    pub statement_title: String,
    pub hand_day: String,
    pub statement_day: String,
    pub amount_minor: i64,
    pub currency: String,
}

impl MatchDismissalRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            hand_id: row.get("hand_id")?,
            statement_id: row.get("statement_id")?,
            hand_title: row.get("hand_title")?,
            statement_title: row.get("statement_title")?,
            hand_day: row.get("hand_day")?,
            statement_day: row.get("statement_day")?,
            amount_minor: row.get("amount_minor")?,
            currency: row.get("currency")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultCurrency {
    pub currency: String,
}

impl VaultCurrency {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            currency: row.get("currency")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityRef {
    pub id: String,
    pub kind: String,
    pub title: String,
}

impl EntityRef {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            title: row.get("title")?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Count(pub i64);

impl Count {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self(row.get("count")?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Id(pub String);

impl Id {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self(row.get("id")?))
    }
}

fn lines(row: &Row<'_>) -> rusqlite::Result<Held> {
    Ok(Held {
        kind: "txn".to_owned(),
        count: row.get("count")?,
    })
}

const ACCOUNT_PARAM: &[Param] = &[param("account", ParamTy::Id)];
const BY_ID_PARAM: &[Param] = &[param("id", ParamTy::Id)];
const TXN_PARAM: &[Param] = &[param("txn", ParamTy::Id)];
const CATEGORY_PARAM: &[Param] = &[param("category", ParamTy::Id)];
const MONTH_PARAM: &[Param] = &[param("month", ParamTy::Text)];
const BALANCE_PARAMS: &[Param] = &[
    param("account", ParamTy::Id),
    param("after_day", ParamTy::Text),
];
const SPENDING_PARAMS: &[Param] = &[
    param("category", ParamTy::Id),
    param("from_day", ParamTy::Text),
    param("to_day", ParamTy::Text),
];
const WINDOW_PARAMS: &[Param] = &[
    param("from_day", ParamTy::Text),
    param("to_day", ParamTy::Text),
];

pub const ACCOUNT_LINES: Read<Held> = read(
    ReadDecl {
        name: "money.account_lines",
        shape: Shape::Aggregate,
        sql: "SELECT count(*) AS count FROM txn t JOIN entity e ON e.id = t.id \
              WHERE t.account_id = :account AND e.deleted_at IS NULL",
        params: ACCOUNT_PARAM,
        reads: &["txn"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    lines,
);

pub const VAULT_CURRENCY: Read<VaultCurrency> = read(
    ReadDecl {
        name: "money.vault_currency",
        shape: Shape::ByKey,
        sql: "SELECT currency FROM vault WHERE id = 1",
        params: &[],
        reads: &[],
        across: &["vault"],
        bound: 1,
        cursor: &[],
    },
    VaultCurrency::of,
);

pub const ACCOUNTS: Read<AccountSummary> = read(
    ReadDecl {
        name: "money.accounts",
        shape: Shape::PagedList,
        sql: "SELECT e.id AS id, e.title AS title, a.type AS account_type, a.currency AS currency, \
                     a.opening_minor AS opening_minor, a.opening_on AS opening_on, \
                     a.on_budget AS on_budget, e.archived_at AS archived_at, e.starred_at AS starred_at \
              FROM entity e INDEXED BY entity_by_title \
              CROSS JOIN account a INDEXED BY sqlite_autoindex_account_1 ON a.id = e.id \
              WHERE e.kind = 'account' AND e.deleted_at IS NULL AND e.archived_at IS NULL \
                AND (e.title, e.id) > (:after_title, :after_id) \
              ORDER BY e.title ASC, e.id ASC LIMIT :n",
        params: &[],
        reads: &["account"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("title", "after_title"), asc("id", "after_id")],
    },
    AccountSummary::of,
);

pub const ACCOUNTS_ARCHIVED: Read<AccountSummary> = read(
    ReadDecl {
        name: "money.accounts_archived",
        shape: Shape::PagedList,
        sql: "SELECT e.id AS id, e.title AS title, a.type AS account_type, a.currency AS currency, \
                     a.opening_minor AS opening_minor, a.opening_on AS opening_on, \
                     a.on_budget AS on_budget, e.archived_at AS archived_at, e.starred_at AS starred_at \
              FROM entity e INDEXED BY entity_archived \
              CROSS JOIN account a INDEXED BY sqlite_autoindex_account_1 ON a.id = e.id \
              WHERE e.kind = 'account' AND e.deleted_at IS NULL AND e.archived_at IS NOT NULL \
                AND (e.archived_at, e.id) < (:after_at, :after_id) \
              ORDER BY e.archived_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["account"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("archived_at", "after_at"), desc("id", "after_id")],
    },
    AccountSummary::of,
);

pub const ACCOUNT_BY_ID: Read<AccountSummary> = read(
    ReadDecl {
        name: "money.account_by_id",
        shape: Shape::ByKey,
        sql: "SELECT entity.id AS id, entity.title AS title, account.type AS account_type, account.currency AS currency, \
                     account.opening_minor AS opening_minor, account.opening_on AS opening_on, \
                     account.on_budget AS on_budget, entity.archived_at AS archived_at, entity.starred_at AS starred_at \
              FROM entity \
              CROSS JOIN account INDEXED BY sqlite_autoindex_account_1 ON account.id = entity.id \
              WHERE entity.id = :id AND entity.deleted_at IS NULL",
        params: BY_ID_PARAM,
        reads: &["account"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    AccountSummary::of,
);

pub const ACCOUNT_BALANCE: Read<AccountBalance> = read(
    ReadDecl {
        name: "money.account_balance",
        shape: Shape::Aggregate,
        sql: "SELECT COALESCE(SUM(t.amount_minor), 0) AS total_minor, COUNT(*) AS txn_count \
              FROM txn t INDEXED BY txn_by_account_day \
              JOIN entity e ON e.id = t.id \
              WHERE t.account_id = :account AND t.posted_on > :after_day \
                AND t.status = 'posted' AND e.deleted_at IS NULL",
        params: BALANCE_PARAMS,
        reads: &["txn"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    AccountBalance::of,
);

pub const ACCOUNT_LAYOUT: Read<AccountLayout> = read(
    ReadDecl {
        name: "money.account_layout",
        shape: Shape::ByKey,
        sql: "SELECT origin.id AS id, origin.config AS config \
              FROM origin INDEXED BY origin_one_per_home \
              WHERE origin.fills = :account AND origin.system = 'statement'",
        params: ACCOUNT_PARAM,
        reads: &[],
        across: &["origin"],
        bound: 1,
        cursor: &[],
    },
    AccountLayout::of,
);

pub const TXN_ACTIVITY: Read<TxnSummary> = read(
    ReadDecl {
        name: "money.txn_activity",
        shape: Shape::PagedList,
        sql: "SELECT t.id AS id, e.title AS title, t.account_id AS account_id, \
                     ae.title AS account_title, a.currency AS currency, \
                     t.posted_on AS posted_on, t.amount_minor AS amount_minor, \
                     t.status AS status, t.entered AS entered, t.memo AS memo, \
                     e.starred_at AS starred_at \
              FROM txn t INDEXED BY txn_by_day \
              JOIN entity e ON e.id = t.id \
              JOIN account a ON a.id = t.account_id \
              JOIN entity ae ON ae.id = a.id \
              WHERE e.deleted_at IS NULL AND (t.posted_on, t.id) < (:after_day, :after_id) \
              ORDER BY t.posted_on DESC, t.id DESC LIMIT :n",
        params: &[],
        reads: &["txn", "account"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("posted_on", "after_day"), desc("id", "after_id")],
    },
    TxnSummary::of,
);

pub const TXN_BY_ACCOUNT: Read<TxnSummary> = read(
    ReadDecl {
        name: "money.txn_by_account",
        shape: Shape::PagedList,
        sql: "SELECT t.id AS id, e.title AS title, t.account_id AS account_id, \
                     ae.title AS account_title, a.currency AS currency, \
                     t.posted_on AS posted_on, t.amount_minor AS amount_minor, \
                     t.status AS status, t.entered AS entered, t.memo AS memo, \
                     e.starred_at AS starred_at \
              FROM txn t INDEXED BY txn_by_account_day \
              JOIN entity e ON e.id = t.id \
              JOIN account a ON a.id = t.account_id \
              JOIN entity ae ON ae.id = a.id \
              WHERE t.account_id = :account AND e.deleted_at IS NULL \
                AND (t.posted_on, t.id) < (:after_day, :after_id) \
              ORDER BY t.posted_on DESC, t.id DESC LIMIT :n",
        params: ACCOUNT_PARAM,
        reads: &["txn", "account"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("posted_on", "after_day"), desc("id", "after_id")],
    },
    TxnSummary::of,
);

pub const TXN_BY_CATEGORY: Read<TxnSummary> = read(
    ReadDecl {
        name: "money.txn_by_category",
        shape: Shape::PagedList,
        sql: "SELECT t.id AS id, e.title AS title, t.account_id AS account_id, \
                     ae.title AS account_title, a.currency AS currency, \
                     t.posted_on AS posted_on, s.amount_minor AS amount_minor, \
                     t.status AS status, t.entered AS entered, t.memo AS memo, \
                     e.starred_at AS starred_at \
              FROM txn_split s INDEXED BY txn_split_by_category \
              JOIN txn t ON t.id = s.txn_id \
              JOIN entity e ON e.id = t.id \
              JOIN account a ON a.id = t.account_id \
              JOIN entity ae ON ae.id = a.id \
              WHERE s.category_id = :category AND e.deleted_at IS NULL \
                AND s.txn_id < :after_id \
              ORDER BY s.txn_id DESC LIMIT :n",
        params: CATEGORY_PARAM,
        reads: &["txn_split", "txn", "account"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("id", "after_id")],
    },
    TxnSummary::of,
);

pub const TXN_BY_ID: Read<TxnDetail> = read(
    ReadDecl {
        name: "money.txn_by_id",
        shape: Shape::ByKey,
        sql: "SELECT txn.id AS id, entity.title AS title, txn.account_id AS account_id, \
                     (SELECT title FROM entity WHERE id = account.id) AS account_title, account.currency AS currency, \
                     txn.posted_on AS posted_on, txn.amount_minor AS amount_minor, \
                     txn.status AS status, txn.entered AS entered, txn.memo AS memo, \
                     txn.original_amount_minor AS original_amount_minor, \
                     txn.original_currency AS original_currency, \
                     entity.starred_at AS starred_at, entity.arrived_via AS arrived_via, \
                     entity.arrived_label AS arrived_label, entity.updated_at AS updated_at \
              FROM txn \
              JOIN entity ON entity.id = txn.id \
              JOIN account ON account.id = txn.account_id \
              WHERE txn.id = :id AND entity.deleted_at IS NULL",
        params: BY_ID_PARAM,
        reads: &["txn", "account"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    TxnDetail::of,
);

pub const TXN_SPLITS: Read<TxnSplit> = read(
    ReadDecl {
        name: "money.txn_splits",
        shape: Shape::BoundedChild,
        sql: "SELECT s.txn_id AS txn_id, s.position AS position, s.category_id AS category_id, \
                     ce.title AS category_title, s.amount_minor AS amount_minor, s.memo AS memo \
              FROM txn_split s \
              JOIN entity ce ON ce.id = s.category_id \
              WHERE s.txn_id = :txn \
              ORDER BY s.position ASC LIMIT 50",
        params: TXN_PARAM,
        reads: &["txn_split"],
        across: &["entity"],
        bound: 50,
        cursor: &[],
    },
    TxnSplit::of,
);

pub const TXN_SOURCES: Read<TxnSource> = read(
    ReadDecl {
        name: "money.txn_sources",
        shape: Shape::BoundedChild,
        sql: "SELECT s.id AS id, s.stated_title AS stated_title, s.stated AS stated, s.seen_at AS seen_at \
              FROM source s INDEXED BY source_by_entity \
              WHERE s.entity_id = :txn \
              LIMIT 10",
        params: TXN_PARAM,
        reads: &[],
        across: &["source"],
        bound: 10,
        cursor: &[],
    },
    TxnSource::of,
);

pub const TXN_TRANSFER: Read<TransferPair> = read(
    ReadDecl {
        name: "money.txn_transfer",
        shape: Shape::BoundedChild,
        sql: "SELECT tr.a AS a_id, tr.b AS b_id, \
                     ea.title AS a_title, eb.title AS b_title, \
                     ta.amount_minor AS a_minor, tb.amount_minor AS b_minor, \
                     aa.currency AS a_currency, ab.currency AS b_currency, \
                     ta.posted_on AS a_day, tb.posted_on AS b_day \
              FROM transfer tr \
              JOIN txn ta ON ta.id = tr.a JOIN entity ea ON ea.id = tr.a JOIN account aa ON aa.id = ta.account_id \
              JOIN txn tb ON tb.id = tr.b JOIN entity eb ON eb.id = tr.b JOIN account ab ON ab.id = tb.account_id \
              WHERE tr.a = :txn AND ea.deleted_at IS NULL AND eb.deleted_at IS NULL \
              UNION ALL \
              SELECT tr.a AS a_id, tr.b AS b_id, \
                     ea.title AS a_title, eb.title AS b_title, \
                     ta.amount_minor AS a_minor, tb.amount_minor AS b_minor, \
                     aa.currency AS a_currency, ab.currency AS b_currency, \
                     ta.posted_on AS a_day, tb.posted_on AS b_day \
              FROM transfer tr \
              JOIN txn ta ON ta.id = tr.a JOIN entity ea ON ea.id = tr.a JOIN account aa ON aa.id = ta.account_id \
              JOIN txn tb ON tb.id = tr.b JOIN entity eb ON eb.id = tr.b JOIN account ab ON ab.id = tb.account_id \
              WHERE tr.b = :txn AND ea.deleted_at IS NULL AND eb.deleted_at IS NULL \
              LIMIT 2",
        params: TXN_PARAM,
        reads: &["transfer", "txn", "account"],
        across: &["entity"],
        bound: 2,
        cursor: &[],
    },
    TransferPair::of,
);

pub const SPENDING_BY_CATEGORY: Read<SpendingTotal> = read(
    ReadDecl {
        name: "money.spending_by_category",
        shape: Shape::Aggregate,
        sql: "SELECT COALESCE(SUM(s.amount_minor), 0) AS total_minor, COUNT(*) AS line_count \
              FROM txn_split s INDEXED BY txn_split_by_category \
              JOIN txn t ON t.id = s.txn_id \
              JOIN entity e ON e.id = t.id \
              WHERE s.category_id = :category \
                AND t.posted_on >= :from_day AND t.posted_on <= :to_day \
                AND e.deleted_at IS NULL \
                AND NOT EXISTS (SELECT 1 FROM transfer tr WHERE tr.a = t.id) \
                AND NOT EXISTS (SELECT 1 FROM transfer tr WHERE tr.b = t.id)",
        params: SPENDING_PARAMS,
        reads: &["txn_split", "txn", "transfer"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    SpendingTotal::of,
);

pub const CASHFLOW_WINDOW: Read<CashflowTotal> = read(
    ReadDecl {
        name: "money.cashflow_window",
        shape: Shape::Aggregate,
        sql: "SELECT COALESCE(SUM(CASE WHEN t.amount_minor > 0 THEN t.amount_minor ELSE 0 END), 0) AS inflow_minor, \
                     COALESCE(SUM(CASE WHEN t.amount_minor < 0 THEN -t.amount_minor ELSE 0 END), 0) AS outflow_minor, \
                     COUNT(*) AS line_count \
              FROM txn t INDEXED BY txn_by_day \
              JOIN entity e ON e.id = t.id \
              WHERE t.posted_on >= :from_day AND t.posted_on <= :to_day \
                AND e.deleted_at IS NULL \
                AND NOT EXISTS (SELECT 1 FROM transfer tr WHERE tr.a = t.id) \
                AND NOT EXISTS (SELECT 1 FROM transfer tr WHERE tr.b = t.id)",
        params: WINDOW_PARAMS,
        reads: &["txn", "transfer"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    CashflowTotal::of,
);

pub const BUDGETS_FOR_MONTH: Read<BudgetRow> = read(
    ReadDecl {
        name: "money.budgets_for_month",
        shape: Shape::BoundedChild,
        sql: "SELECT b.category_id AS category_id, ce.title AS category_title, \
                     b.month AS month, b.amount_minor AS amount_minor, b.carry AS carry \
              FROM budget b INDEXED BY budget_by_month \
              JOIN entity ce ON ce.id = b.category_id \
              WHERE b.month = :month AND ce.deleted_at IS NULL \
              ORDER BY b.category_id ASC LIMIT 200",
        params: MONTH_PARAM,
        reads: &["budget"],
        across: &["entity"],
        bound: 200,
        cursor: &[],
    },
    BudgetRow::of,
);

pub const CATEGORIES: Read<CategoryRow> = read(
    ReadDecl {
        name: "money.categories",
        shape: Shape::PagedList,
        sql: "SELECT e.id AS id, e.title AS title, e.parent_id AS parent_id, c.color AS color \
              FROM entity e INDEXED BY entity_by_title \
              LEFT JOIN concept c ON c.id = e.id \
              WHERE e.kind = 'category' AND e.deleted_at IS NULL \
                AND (e.title, e.id) > (:after_title, :after_id) \
              ORDER BY e.title ASC, e.id ASC LIMIT :n",
        params: &[],
        reads: &[],
        across: &["entity", "concept"],
        bound: 200,
        cursor: &[asc("title", "after_title"), asc("id", "after_id")],
    },
    CategoryRow::of,
);

pub const RULES_BY_CATEGORY: Read<RuleRow> = read(
    ReadDecl {
        name: "money.rules_by_category",
        shape: Shape::BoundedChild,
        sql: "SELECT r.id AS id, r.pattern AS pattern, r.display_name AS display_name, \
                     r.category_id AS category_id, ce.title AS category_title, r.position AS position \
              FROM rule r INDEXED BY rule_by_category \
              JOIN entity ce ON ce.id = r.category_id \
              WHERE r.category_id = :category AND ce.deleted_at IS NULL \
              LIMIT 100",
        params: CATEGORY_PARAM,
        reads: &["rule"],
        across: &["entity"],
        bound: 100,
        cursor: &[],
    },
    RuleRow::of,
);

pub const CHECKPOINTS: Read<CheckpointRow> = read(
    ReadDecl {
        name: "money.checkpoints",
        shape: Shape::BoundedChild,
        sql: "SELECT c.account_id AS account_id, c.day AS day, c.balance_minor AS balance_minor \
              FROM checkpoint c \
              WHERE c.account_id = :account \
              ORDER BY c.day DESC LIMIT 100",
        params: ACCOUNT_PARAM,
        reads: &["checkpoint"],
        across: &[],
        bound: 100,
        cursor: &[],
    },
    CheckpointRow::of,
);

pub const TRANSFERS: Read<TransferPair> = read(
    ReadDecl {
        name: "money.transfers",
        shape: Shape::PagedList,
        sql: "SELECT tr.a AS a_id, tr.b AS b_id, \
                     ea.title AS a_title, eb.title AS b_title, \
                     ta.amount_minor AS a_minor, tb.amount_minor AS b_minor, \
                     aa.currency AS a_currency, ab.currency AS b_currency, \
                     ta.posted_on AS a_day, tb.posted_on AS b_day \
              FROM transfer tr INDEXED BY sqlite_autoindex_transfer_1 \
              CROSS JOIN txn ta ON ta.id = tr.a JOIN entity ea ON ea.id = tr.a JOIN account aa ON aa.id = ta.account_id \
              JOIN txn tb ON tb.id = tr.b JOIN entity eb ON eb.id = tr.b JOIN account ab ON ab.id = tb.account_id \
              WHERE ea.deleted_at IS NULL AND eb.deleted_at IS NULL AND tr.a < :after_id \
              ORDER BY tr.a DESC LIMIT :n",
        params: &[],
        reads: &["transfer", "txn", "account"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("a_id", "after_id")],
    },
    TransferPair::of,
);

pub const MATCH_DISMISSALS: Read<MatchDismissalRow> = read(
    ReadDecl {
        name: "money.match_dismissals",
        shape: Shape::PagedList,
        sql: "SELECT d.hand_id AS hand_id, d.statement_id AS statement_id, \
                     eh.title AS hand_title, es.title AS statement_title, \
                     th.posted_on AS hand_day, ts.posted_on AS statement_day, \
                     th.amount_minor AS amount_minor, a.currency AS currency \
              FROM txn_match_dismissal d INDEXED BY txn_match_dismissal_by_statement \
              CROSS JOIN txn th ON th.id = d.hand_id JOIN entity eh ON eh.id = d.hand_id \
              JOIN txn ts ON ts.id = d.statement_id JOIN entity es ON es.id = d.statement_id \
              JOIN account a ON a.id = th.account_id \
              WHERE eh.deleted_at IS NULL AND es.deleted_at IS NULL \
                AND (d.statement_id, d.hand_id) < (:after_stmt, :after_hand) \
              ORDER BY d.statement_id DESC, d.hand_id DESC LIMIT :n",
        params: &[],
        reads: &["txn_match_dismissal", "txn", "account"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[
            desc("statement_id", "after_stmt"),
            desc("hand_id", "after_hand"),
        ],
    },
    MatchDismissalRow::of,
);

pub const LINKED: Read<Id> = read(
    ReadDecl {
        name: "money.linked",
        shape: Shape::BoundedChild,
        sql: "SELECT l.b AS id FROM link l \
              WHERE l.a = :id \
                AND EXISTS (SELECT 1 FROM entity e WHERE e.id = l.b AND e.deleted_at IS NULL) \
              UNION \
              SELECT l.a AS id FROM link l \
              WHERE l.b = :id \
                AND EXISTS (SELECT 1 FROM entity e WHERE e.id = l.a AND e.deleted_at IS NULL) \
              ORDER BY id LIMIT 50",
        params: BY_ID_PARAM,
        reads: &[],
        across: &["link", "entity"],
        bound: 50,
        cursor: &[],
    },
    Id::of,
);

pub const MENTIONED_IN: Read<Titled> = read(
    ReadDecl {
        name: "money.mentioned_in",
        shape: Shape::BoundedChild,
        sql: "SELECT m.note_id AS id, e.title AS title \
              FROM mention m JOIN entity e ON e.id = m.note_id \
              WHERE m.to_id = :id AND e.deleted_at IS NULL \
              ORDER BY m.note_id DESC LIMIT 20",
        params: BY_ID_PARAM,
        reads: &[],
        across: &["mention", "entity"],
        bound: 20,
        cursor: &[],
    },
    Titled::of,
);

pub const ATTACHMENTS: Read<EntityRef> = read(
    ReadDecl {
        name: "money.attachments",
        shape: Shape::BoundedChild,
        sql: "SELECT e.id AS id, e.kind AS kind, e.title AS title \
              FROM edge x JOIN entity e ON e.id = x.from_id \
              WHERE x.to_id = :id AND x.rel = 'attached' AND e.deleted_at IS NULL \
              ORDER BY x.from_id DESC LIMIT 20",
        params: BY_ID_PARAM,
        reads: &[],
        across: &["edge", "entity"],
        bound: 20,
        cursor: &[],
    },
    EntityRef::of,
);

pub const REVISIONS_COUNT: Read<Count> = read(
    ReadDecl {
        name: "money.revisions_count",
        shape: Shape::Aggregate,
        sql: "SELECT count(*) AS count FROM revision WHERE entity_id = :id",
        params: BY_ID_PARAM,
        reads: &[],
        across: &["revision"],
        bound: 1,
        cursor: &[],
    },
    Count::of,
);

pub const ENTITY_REF: Read<EntityRef> = read(
    ReadDecl {
        name: "money.entity_ref",
        shape: Shape::ByKey,
        sql: "SELECT id, kind, title FROM entity WHERE id = :id AND deleted_at IS NULL",
        params: BY_ID_PARAM,
        reads: &[],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    EntityRef::of,
);

pub const TRASH: Read<Trashed> = trash!("money.trash", "'account', 'txn'");

pub const READS: &[ReadDecl] = &[
    ACCOUNT_LINES.decl,
    VAULT_CURRENCY.decl,
    ACCOUNTS.decl,
    ACCOUNTS_ARCHIVED.decl,
    ACCOUNT_BY_ID.decl,
    ACCOUNT_BALANCE.decl,
    ACCOUNT_LAYOUT.decl,
    TXN_ACTIVITY.decl,
    TXN_BY_ACCOUNT.decl,
    TXN_BY_CATEGORY.decl,
    TXN_BY_ID.decl,
    TXN_SPLITS.decl,
    TXN_SOURCES.decl,
    TXN_TRANSFER.decl,
    SPENDING_BY_CATEGORY.decl,
    CASHFLOW_WINDOW.decl,
    BUDGETS_FOR_MONTH.decl,
    CATEGORIES.decl,
    RULES_BY_CATEGORY.decl,
    CHECKPOINTS.decl,
    TRANSFERS.decl,
    MATCH_DISMISSALS.decl,
    LINKED.decl,
    MENTIONED_IN.decl,
    ATTACHMENTS.decl,
    REVISIONS_COUNT.decl,
    ENTITY_REF.decl,
    TRASH.decl,
];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "account",
        "money",
        "account",
        "accounts",
        Trash::Listed("money.trash"),
    )
    .holds(&["txn"], &["money.account_lines"])
    .footers(&[Footer::Linked, Footer::MentionedIn])
    .exports(Export::Within("txn"))
    .shares(Share::Never("an account's balances stay on the phone")),
    KindDecl::new(
        "txn",
        "money",
        "transaction",
        "transactions",
        Trash::Listed("money.trash"),
    )
    .takes_captures()
    .holds(&["photo", "document"], &["entity.held_counts"])
    .footers(&[
        Footer::Attachments,
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
        Footer::Says,
    ])
    .exports(Export::File {
        header: "centraid.money.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "category",
        "money",
        "category",
        "categories",
        Trash::Purged("a category is purged outright; its lines are filed under its group"),
    )
    .sits_in(&["category"]),
];
