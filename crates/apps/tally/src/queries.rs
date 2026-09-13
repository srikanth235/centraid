//! `loadTally` — THE ONE READ, ported statement for statement.
//!
//! From `packages/blueprints/apps/tally/queries/dashboard.ts:191`. Its doctrine
//! at `:45-51` is the reason every window here is stated and every walk errors
//! at its ceiling: **a balance derived from a silently short ledger is a WRONG
//! NUMBER — not a slow screen.**
//!
//! Fourteen statements that do not depend on each other, then three that do
//! (the parties an id list names, the receipt contents, their
//! representations). v0 runs the fourteen in one `Promise.all`; here they run in
//! reading order, because a door is synchronous and the core serialises reads
//! under SQLite's own rules (#1020, Execution model) — the concurrency was
//! never the point, the **boundedness** was.
//!
//! **There is no SQL in this crate.** A statement is a
//! [`centraid_apps_kit::PageQuery`] — a projection, a `from`, a predicate and
//! an order, as data — and `crates/apps/kit` is the only place in the app plane
//! that turns one into a statement. `cargo xtask rules`' `sql-confinement`
//! scans this crate and finds none.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, in_list, read_pages, read_window};
use centraid_apps_kit::row::{Row, integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::balance::{BalanceData, BalanceExpense, BalanceSettlement};

/// The named windows, verbatim from `queries/dashboard.ts:52-61`.
///
/// A count here is a **stated** window, not a default: changing one changes
/// what Tally promises about how much ledger it reads.
pub const LEDGER_ROWS: usize = 2_000;
pub const TRASH_ROWS: usize = 100;
pub const RECURRING_ROWS: usize = 500;
pub const EXCEPTION_ROWS: usize = 2_000;

/// A split, a payer or a line per `(expense, person)`: 8,000 rows.
///
/// **The page size is 500, and v0's is 1,000** (D-1020-D3-12). v0 declares
/// `{pageSize: 1000, fanOutPages: 8}` and calls it 8,000 rows
/// (`queries/dashboard.ts:58`), but `MAX_PAGE_ROWS` clamps every page to 500,
/// so the walk reaches 4,000 and throws a sentence naming 8,000. At the window
/// Tally's own ceiling is stated at — 2,000 expenses, four sharers each —
/// that is 8,000 split rows and v0's dashboard throws. Sixteen pages of 500 is
/// the same stated ceiling and the first one that can be reached.
pub const LEDGER_FAN_OUT: FanOutBound = FanOutBound::new(500, 16);

/// An allocation per `(line, person)`: four times that, by the same arithmetic.
pub const ALLOCATION_FAN_OUT: FanOutBound = FanOutBound::new(500, 64);

/// A resolved person a ledger row is decorated with — v0's `ServerPerson`
/// (`queries/dashboard.ts:73`).
///
/// The colour is the PARTY HUE and never `identityColor` (#883, ruling
/// O-identity): the person wheel has eight places and the vault wheel's ninth
/// is the ink brand, so keying a person off it draws them as a black disc. The
/// owner is the one exception and is painted with the brand on purpose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    pub party_id: String,
    pub name: String,
    pub color: String,
    pub initials: String,
    pub is_me: bool,
}

/// One expense, as the ledger holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpenseRow {
    pub expense_id: String,
    pub group_id: Option<String>,
    pub description: String,
    pub amount_minor: i64,
    /// The currency `amount_minor` IS (#916, R1). Splits, payers and line items
    /// inherit it by construction and carry no column of their own.
    pub currency: String,
    pub paid_by: String,
    pub spent_on: String,
    pub category: String,
    pub split_method: String,
    /// The division's own parameters, as v0 stores them: JSON text or nothing.
    /// PROVENANCE, never a second arithmetic path.
    pub split_params_json: Option<String>,
    /// **Not selected by [`expenses_statement`]** — see its note. The columns
    /// exist and the dashboard's read does not ask for them, so every row the
    /// dashboard folds has `None` here: the money falls back to the group's and
    /// the rate suggestion can never be made. Kept as fields rather than
    /// dropped, so the day v0's projection is fixed both sides start answering.
    pub settlement_currency: Option<String>,
    pub original_currency: Option<String>,
    pub rate_scaled: Option<i64>,
    pub rate_scale: Option<i64>,
    pub rate_source: Option<String>,
    pub rate_date: Option<String>,
    pub deleted_at: Option<String>,
}

/// One typed line of an expense, receipt-backed or not.
///
/// Lines hang off the EXPENSE and the receipt is an optional decoration, so the
/// "By line" division has typed lines and no photo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineItem {
    pub line_item_id: String,
    pub kind: String,
    pub description: String,
    pub amount_minor: i64,
    pub sort_order: i64,
    /// Who the line is allocated to, per person.
    pub allocations: BTreeMap<String, i64>,
}

/// One settlement — real cash — as the ledger holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettlementRow {
    pub settlement_id: String,
    pub group_id: Option<String>,
    pub from_party: String,
    pub to_party: String,
    pub amount_minor: i64,
    /// What was PAID, in the money it was paid in (#916, R1).
    pub currency: Option<String>,
    pub paid_on: Option<String>,
}

/// One group, as the ledger holds it. Its **name and membership live on the
/// circle**: a group is a `social.circle` decorated by a `tally.group`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupRow {
    pub group_id: String,
    pub circle_id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub currency: String,
    pub simplify_opt_in: bool,
    pub archived_at: Option<String>,
}

/// What `loadTally` answers: the resident facts every Tally surface folds.
///
/// Named after v0's `TallyData` (`queries/dashboard.ts:176`) and carrying the
/// same fields.
// No `Eq`: a `Row` holds `Cell::Real`, and an f64 has no total equality. A
// fold that wanted to compare two `TallyData` by value would be comparing
// floats, which is the arithmetic this app exists to avoid.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TallyData {
    /// The owner's party id, or `None` when the vault row has none.
    pub me: Option<String>,
    /// The vault's base currency — what a single hero figure would be in.
    pub currency: String,
    /// Every party the ledger names, whether or not still a member, with the
    /// presentation `crates/design` lowers (name, hue, initials, `is_me`).
    pub people: BTreeMap<String, Person>,
    pub friends: Vec<String>,
    pub groups: Vec<GroupRow>,
    pub members_by_group: BTreeMap<String, Vec<String>>,
    pub expenses: Vec<ExpenseRow>,
    pub splits: BTreeMap<String, BTreeMap<String, i64>>,
    pub payers: BTreeMap<String, BTreeMap<String, i64>>,
    pub settlements: Vec<SettlementRow>,
    /// The typed lines of each expense that has any, by expense.
    pub lines: BTreeMap<String, Vec<LineItem>>,
    pub obligations: Vec<Row>,
    pub nudges: Vec<Row>,
    /// `true` when the ledger is longer than `LEDGER_ROWS`, so a surface can
    /// say the balance is over a window rather than over everything. v0 has no
    /// such field and no way to know.
    pub ledger_window_filled: bool,
}

impl TallyData {
    /// The facts the balance engine consumes, folded out of the resident ones.
    ///
    /// **Only live expenses.** A trashed expense keeps its splits — the sweep
    /// cascades them at purge — and the fold ignores them once the row leaves
    /// the `deleted_at IS NULL` window (`packages/vault/src/commands/tally.ts`'s
    /// `delete_expense` note). Folding a trashed expense is how a cancelled
    /// order stays on a balance.
    pub fn balance_data(&self) -> BalanceData {
        BalanceData {
            members_by_group: self.members_by_group.clone(),
            expenses: self
                .expenses
                .iter()
                .filter(|expense| expense.deleted_at.is_none())
                .map(|expense| BalanceExpense {
                    group_id: expense.group_id.clone(),
                    paid_by: expense.paid_by.clone(),
                    amount_minor: expense.amount_minor,
                    splits: self
                        .splits
                        .get(&expense.expense_id)
                        .cloned()
                        .unwrap_or_default(),
                    payers: self
                        .payers
                        .get(&expense.expense_id)
                        .cloned()
                        .unwrap_or_default(),
                })
                .collect(),
            settlements: self
                .settlements
                .iter()
                .map(|settlement| BalanceSettlement {
                    group_id: settlement.group_id.clone(),
                    from_party: settlement.from_party.clone(),
                    to_party: settlement.to_party.clone(),
                    amount_minor: settlement.amount_minor,
                })
                .collect(),
        }
    }

    /// A settlement's money: its own, else its group's, else the base
    /// (`queries/dashboard.ts:750`).
    #[must_use]
    pub fn settlement_currency(&self, settlement: &SettlementRow) -> String {
        settlement.currency.clone().unwrap_or_else(|| {
            settlement.group_id.as_deref().map_or_else(
                || self.currency.clone(),
                |group_id| self.group_currency(group_id),
            )
        })
    }

    /// A group's own currency, else the vault's base
    /// (`queries/dashboard.ts:687`).
    pub fn group_currency(&self, group_id: &str) -> String {
        self.groups
            .iter()
            .find(|group| group.group_id == group_id)
            .map_or_else(|| self.currency.clone(), |group| group.currency.clone())
    }

    /// An expense's currency: its settlement currency, else its group's, else
    /// the base (`queries/dashboard.ts:697`).
    pub fn expense_currency(&self, expense: &ExpenseRow) -> String {
        expense
            .settlement_currency
            .clone()
            .or_else(|| {
                expense
                    .group_id
                    .as_deref()
                    .map(|group_id| self.group_currency(group_id))
            })
            .unwrap_or_else(|| self.currency.clone())
    }
}

// ---------------------------------------------------------------------------
// The statements. One function per statement, named as v0 names it, so the
// plan snapshot and the work-counter row read the same on both sides.
// ---------------------------------------------------------------------------

fn query(name: &str, select: &str, from: &str, order: PageOrder) -> PageQuery {
    PageQuery::new(name, select, from, order)
}

/// `tally.dashboard.vault` — the owner and the base currency.
pub fn vault_statement() -> PageQuery {
    query(
        "tally.dashboard.vault",
        "vault_id, self_party_id, base_currency",
        "core_vault",
        PageOrder::asc("vault_id", "vault_id"),
    )
}

/// `tally.dashboard.friends` — the friend roster.
pub fn friends_statement() -> PageQuery {
    query(
        "tally.dashboard.friends",
        "friend_id, party_id",
        "tally_friend",
        PageOrder::asc("friend_id", "friend_id"),
    )
}

/// `tally.dashboard.groups` — selects `currency` since #996 R22, because a
/// group is one ledger in one money.
pub fn groups_statement() -> PageQuery {
    query(
        "tally.dashboard.groups",
        "group_id, circle_id, icon, color, simplify_opt_in, archived_at, currency",
        "tally_group",
        PageOrder::asc("group_id", "group_id"),
    )
}

/// `tally.dashboard.circles` — the group's name and membership live here.
pub fn circles_statement() -> PageQuery {
    query(
        "tally.dashboard.circles",
        "circle_id, name",
        "social_circle",
        PageOrder::asc("circle_id", "circle_id"),
    )
}

/// `tally.dashboard.circleMembers` — current membership.
pub fn circle_members_statement() -> PageQuery {
    query(
        "tally.dashboard.circleMembers",
        "member_id, circle_id, party_id",
        "social_circle_member",
        PageOrder::asc("member_id", "member_id"),
    )
}

/// `tally.dashboard.expenses` — ONE page of `LEDGER_ROWS`, newest first.
///
/// A single page and not a walk: the window is the promise, and a ledger
/// longer than it is a ledger the dashboard states it did not read all of.
///
/// **THE PROJECTION IS v0's, EXACTLY, AND THAT IS A FINDING NOT A CHOICE**
/// (#1020, D-1020-T2a). v0 selects these thirteen columns and no others
/// (`queries/dashboard.ts:287-290`), which means `settlement_currency`,
/// `original_amount_minor`, `original_currency` and the four `rate_*` columns
/// are **undefined in every row the dashboard folds** — so `ledgerRow`'s
/// `e.settlement_currency ?? data.currency` labels a JPY expense with the
/// vault's base money, `rateSuggestions` can never produce a row, and the
/// export ships the same mislabelling to a file. The port reproduces it,
/// because the 29 committed cases are v0's answers; the receipt carries the
/// one-line fix and the evidence. Selecting the columns here would have made
/// the port silently right and the parity comparison impossible.
pub fn expenses_statement() -> PageQuery {
    query(
        "tally.dashboard.expenses",
        "expense_id, group_id, description, amount_minor, currency, paid_by, split_method, \
         split_params_json, spent_on, category, txn_id, created_at, updated_at",
        "tally_expense",
        PageOrder::desc("spent_on", "expense_id"),
    )
    .filter("deleted_at IS NULL", Vec::new())
}

/// `tally.dashboard.splits` — **the keyset is the table's own pair.**
/// A cursor on `expense_id` alone stops at the first sharer
/// (`queries/dashboard.ts:282`).
pub fn splits_statement() -> PageQuery {
    query(
        "tally.dashboard.splits",
        "expense_id, party_id, share_minor",
        "tally_expense_split",
        PageOrder::asc("expense_id", "party_id"),
    )
}

/// `tally.dashboard.payers` — the same pair keyset, for the same reason.
pub fn payers_statement() -> PageQuery {
    query(
        "tally.dashboard.payers",
        "expense_id, party_id, paid_minor",
        "tally_expense_payer",
        PageOrder::asc("expense_id", "party_id"),
    )
}

/// `tally.dashboard.settlements` — real cash.
pub fn settlements_statement() -> PageQuery {
    query(
        "tally.dashboard.settlements",
        "settlement_id, group_id, from_party, to_party, amount_minor, currency, paid_on, txn_id, \
         created_at",
        "tally_settlement",
        PageOrder::asc("settlement_id", "settlement_id"),
    )
    .filter("deleted_at IS NULL", Vec::new())
}

/// `tally.dashboard.obligations` — an obligation carries its own currency and
/// is never group-scoped, so there is nothing else it could inherit
/// (`queries/dashboard.ts:742`).
pub fn obligations_statement() -> PageQuery {
    query(
        "tally.dashboard.obligations",
        "obligation_id, from_party, to_party, amount_minor, currency, reason, incurred_on, \
         settled_at",
        "tally_obligation",
        PageOrder::asc("obligation_id", "obligation_id"),
    )
    .filter("settled_at IS NULL AND deleted_at IS NULL", Vec::new())
}

/// `tally.dashboard.receipts` — a receipt IS the `role='receipt'` attachment on
/// the expense (#883, ruling O-attach).
pub fn receipts_statement() -> PageQuery {
    query(
        "tally.dashboard.receipts",
        "attachment_id, target_type, target_id, content_id, role, is_primary",
        "core_attachment",
        PageOrder::asc("attachment_id", "attachment_id"),
    )
    .filter(
        "target_type = ? AND role = ?",
        vec![
            PageBindValue::from("tally.expense"),
            PageBindValue::from("receipt"),
        ],
    )
}

/// `tally.dashboard.receiptLines` — walked under [`LEDGER_FAN_OUT`].
pub fn receipt_lines_statement() -> PageQuery {
    query(
        "tally.dashboard.receiptLines",
        "line_item_id, expense_id, receipt_id, kind, description, amount_minor, sort_order",
        "tally_expense_line_item",
        PageOrder::asc("line_item_id", "line_item_id"),
    )
}

/// `tally.dashboard.receiptAllocations` — walked under [`ALLOCATION_FAN_OUT`],
/// keyed on the table's own pair.
pub fn receipt_allocations_statement() -> PageQuery {
    query(
        "tally.dashboard.receiptAllocations",
        "line_item_id, party_id, share_minor",
        "tally_expense_line_allocation",
        PageOrder::asc("line_item_id", "party_id"),
    )
}

/// `tally.dashboard.nudges` — prepared, never sent.
pub fn nudges_statement() -> PageQuery {
    query(
        "tally.dashboard.nudges",
        "nudge_id, party_id, group_id, as_of_minor, note, prepared_at, created_at",
        "tally_nudge",
        PageOrder::desc("prepared_at", "nudge_id"),
    )
}

/// `tally.dashboard.parties` — DEPENDENT: the party set the rest of the read
/// turned out to name.
pub fn parties_statement(party_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("party_id", party_ids)?;
    Ok(query(
        "tally.dashboard.parties",
        "party_id, display_name, sort_name, kind",
        "core_party",
        PageOrder::asc("party_id", "party_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `tally.dashboard.trash` — the other side of the expenses window.
pub fn trash_statement() -> PageQuery {
    query(
        "tally.dashboard.trash",
        "expense_id, group_id, description, amount_minor, currency, paid_by, spent_on, category, \
         deleted_at, purge_at",
        "tally_expense",
        PageOrder::desc("deleted_at", "expense_id"),
    )
    .filter("deleted_at IS NOT NULL", Vec::new())
}

/// `tally.dashboard.recurring` — the standing orders.
pub fn recurring_statement() -> PageQuery {
    query(
        "tally.dashboard.recurring",
        "template_id, group_id, description, original_amount_minor, original_currency, \
         settlement_currency, paid_by, category, rrule, anchor_start, tz, rate_scaled, rate_scale, \
         rate_source, rate_date, status, last_materialized_start, updated_at",
        "tally_recurring_expense",
        PageOrder::desc("updated_at", "template_id"),
    )
}

/// `tally.dashboard.recurringExceptions` — keyed on `original_start_local`
/// with `recurrence_semantics`, and **the spelling is the trap**: three readers
/// spelled it `original_start` and one spelled the zone `time_zone`, so each
/// read nothing and a skipped occurrence silently came back on three surfaces
/// (`packages/core/src/time/occurrence.ts:1-16`; #1020 apps seam 8).
pub fn recurring_exceptions_statement() -> PageQuery {
    query(
        "tally.dashboard.recurringExceptions",
        "exception_id, target_type, target_id, original_start_local, recurrence_semantics, scope, \
         action, override_json",
        "schedule_recurrence_exception",
        PageOrder::asc("exception_id", "exception_id"),
    )
    .filter(
        "target_type = ?",
        vec![PageBindValue::from("tally.recurring_expense")],
    )
}

/// How far apart two postings of one movement may sit, in whole days
/// (`queries/matches.ts:31`).
pub const MATCH_WINDOW_DAYS: i64 = 4;

/// The most recent transactions a proposal is looked for among
/// (`queries/matches.ts:34`).
pub const MATCH_SCAN_ROWS: usize = 500;

/// The chain of revisions a `history` walk reads (`queries/history.ts:23`).
///
/// **The chain's own length IS the window** — v0 walks to the end of the set
/// rather than taking a number, which is what `readPages` does here, so a
/// heavily edited expense cannot lose its oldest revisions silently.
pub fn history_statement(expense_id: &str) -> PageQuery {
    query(
        "tally.history.revisions",
        "revision_id, entity_type, entity_id, operation, snapshot_json, recorded_at, undo_until, \
         undone_at",
        "core_entity_revision",
        PageOrder::desc("recorded_at", "revision_id"),
    )
    .filter(
        "entity_type = ? AND entity_id = ?",
        vec![
            PageBindValue::from("tally.expense"),
            PageBindValue::from(expense_id),
        ],
    )
}

/// `tally.export.revisions` — THE WINDOW ASKS FOR THE ROWS IT WANTS (#928,
/// re-cut by #996 wave 4). The entity type and the exported ids are both in the
/// statement, so the walk cannot fill with rows the export is about to discard,
/// and it ends where the set does rather than at a number.
pub fn export_revisions_statement(expense_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("entity_id", expense_ids)?;
    let mut bind = vec![PageBindValue::from("tally.expense")];
    bind.extend(fragment.bind);
    Ok(query(
        "tally.export.revisions",
        "revision_id, entity_type, entity_id, operation, recorded_at, undone_at",
        "core_entity_revision",
        PageOrder::desc("recorded_at", "revision_id"),
    )
    .filter(&format!("entity_type = ? AND {}", fragment.sql), bind))
}

/// `tally.matches.transactions` — the finance plane's postings, newest first.
/// A `void` posting is not a movement and is never half of a proposal.
pub fn match_transactions_statement() -> PageQuery {
    query(
        "tally.matches.transactions",
        "txn_id, account_id, posted_at, amount_minor, currency, direction, description",
        "core_transaction",
        PageOrder::desc("posted_at", "txn_id"),
    )
    .filter("status <> ?", vec![PageBindValue::from("void")])
}

/// `tally.matches.decisions` — the owner's answers, either way.
///
/// A pair the owner has answered leaves the list FOR GOOD, and both answers
/// are the same row shape: `core_link` between two transactions, live. Nothing
/// is merged and nothing is hidden (#996, ruling R20(c)).
pub fn match_decisions_statement() -> PageQuery {
    query(
        "tally.matches.decisions",
        "link_id, from_id, to_id",
        "core_link",
        PageOrder::asc("link_id", "link_id"),
    )
    .filter(
        "from_type = ? AND to_type = ? AND valid_to IS NULL",
        vec![
            PageBindValue::from("core.transaction"),
            PageBindValue::from("core.transaction"),
        ],
    )
}

/// `tally.matches.accounts` — the names the two sides of a proposal wear.
pub fn match_accounts_statement(account_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("account_id", account_ids)?;
    Ok(query(
        "tally.matches.accounts",
        "account_id, name, external_ref",
        "core_account",
        PageOrder::asc("account_id", "account_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// Every statement `loadTally` makes that needs no earlier answer, in reading
/// order. Named so a test can assert the set rather than re-list it.
pub fn independent_statements() -> Vec<PageQuery> {
    vec![
        vault_statement(),
        friends_statement(),
        groups_statement(),
        circles_statement(),
        circle_members_statement(),
        expenses_statement(),
        splits_statement(),
        payers_statement(),
        settlements_statement(),
        obligations_statement(),
        receipts_statement(),
        receipt_lines_statement(),
        receipt_allocations_statement(),
        nudges_statement(),
    ]
}

// ---------------------------------------------------------------------------
// The fold.
// ---------------------------------------------------------------------------

/// A stated window, WALKED rather than clamped.
///
/// v0 asks for its windows as one page and takes `.rows`, which the door
/// clamps to `MAX_PAGE_ROWS` — so a 2,000-row window reads 500 and the fold
/// runs over a quarter of the ledger with nothing saying so. See
/// [`centraid_apps_kit::reads::read_window`] for the whole finding.
/// `filled` is carried into [`TallyData`] so a surface can say the ledger is
/// longer than what was read.
fn window(
    door: &dyn PageDoor,
    statement: &PageQuery,
    rows: usize,
) -> KitResult<centraid_apps_kit::reads::Window> {
    read_window(door, statement, rows)
}

fn expense_row(row: &Row) -> Option<ExpenseRow> {
    Some(ExpenseRow {
        expense_id: text_of(row, "expense_id")?,
        group_id: text_of(row, "group_id"),
        description: text_of(row, "description").unwrap_or_default(),
        amount_minor: integer_or_zero(row, "amount_minor"),
        currency: text_of(row, "currency").unwrap_or_default(),
        paid_by: text_of(row, "paid_by").unwrap_or_default(),
        spent_on: text_of(row, "spent_on").unwrap_or_default(),
        category: text_of(row, "category").unwrap_or_default(),
        // `exact` is the default the column carries, and the method is
        // PROVENANCE — never a second arithmetic path.
        split_method: text_of(row, "split_method").unwrap_or_else(|| "exact".to_owned()),
        split_params_json: text_of(row, "split_params_json"),
        settlement_currency: text_of(row, "settlement_currency"),
        original_currency: text_of(row, "original_currency"),
        rate_scaled: optional_integer(row, "rate_scaled"),
        rate_scale: optional_integer(row, "rate_scale"),
        rate_source: text_of(row, "rate_source"),
        rate_date: text_of(row, "rate_date"),
        deleted_at: text_of(row, "deleted_at"),
    })
}

/// A person from a resolved name: the hue and the initials are
/// `crates/design`'s, the one lowering of `packages/design` (#1020, D-1020-T1).
fn person_of_name(party_id: &str, name: &str, is_me: bool) -> Person {
    Person {
        party_id: party_id.to_owned(),
        name: name.to_owned(),
        color: centraid_design::party_color(party_id),
        initials: centraid_design::identity_initials(name),
        is_me,
    }
}

/// An integer column, or `None` when the projection never asked for it.
///
/// NOT `integer_or_zero`: a rate of zero and a rate nobody read are different
/// facts, and collapsing them is how a missing projection becomes a 1:1 rate.
fn optional_integer(row: &Row, column: &str) -> Option<i64> {
    row.get(column)
        .and_then(centraid_apps_kit::row::Cell::integer)
}

/// Fold a `(expense_id, party_id) -> amount` table into a nested map.
fn pairs(rows: &[Row], amount_column: &str) -> BTreeMap<String, BTreeMap<String, i64>> {
    let mut out: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for row in rows {
        let Some(expense_id) = text_of(row, "expense_id") else {
            continue;
        };
        let Some(party_id) = text_of(row, "party_id") else {
            continue;
        };
        out.entry(expense_id)
            .or_default()
            .insert(party_id, integer_or_zero(row, amount_column));
    }
    out
}

/// THE ONE READ.
///
/// Seventeen statements, then the party resolution that depends on what the
/// first sixteen turned out to name.
pub fn load_tally(door: &dyn PageDoor) -> KitResult<TallyData> {
    let vault = window(door, &vault_statement(), 1)?;
    let friends = window(door, &friends_statement(), LEDGER_ROWS)?;
    let groups = window(door, &groups_statement(), LEDGER_ROWS)?;
    let circles = window(door, &circles_statement(), LEDGER_ROWS)?;
    let members = window(door, &circle_members_statement(), LEDGER_ROWS)?;
    let expenses = window(door, &expenses_statement(), LEDGER_ROWS)?;
    let splits = read_pages(door, &splits_statement(), LEDGER_FAN_OUT)?;
    let payers = read_pages(door, &payers_statement(), LEDGER_FAN_OUT)?;
    let settlements = read_pages(door, &settlements_statement(), LEDGER_FAN_OUT)?;
    let obligations = read_pages(door, &obligations_statement(), LEDGER_FAN_OUT)?;
    let _receipts = read_pages(door, &receipts_statement(), LEDGER_FAN_OUT)?;
    let _lines = read_pages(door, &receipt_lines_statement(), LEDGER_FAN_OUT)?;
    let _allocations = read_pages(door, &receipt_allocations_statement(), ALLOCATION_FAN_OUT)?;
    let nudges = window(door, &nudges_statement(), LEDGER_ROWS)?;

    let vault_row = vault.rows.first();
    let me = vault_row.and_then(|row| text_of(row, "self_party_id"));
    let currency = vault_row
        .and_then(|row| text_of(row, "base_currency"))
        .unwrap_or_else(|| "USD".to_owned());

    let circle_names: BTreeMap<String, String> = circles
        .rows
        .iter()
        .filter_map(|row| Some((text_of(row, "circle_id")?, text_of(row, "name")?)))
        .collect();
    let group_rows: Vec<GroupRow> = groups
        .rows
        .iter()
        .filter_map(|row| {
            let circle_id = text_of(row, "circle_id")?;
            Some(GroupRow {
                group_id: text_of(row, "group_id")?,
                name: circle_names.get(&circle_id).cloned().unwrap_or_default(),
                circle_id,
                icon: text_of(row, "icon").unwrap_or_default(),
                color: text_of(row, "color").unwrap_or_default(),
                currency: text_of(row, "currency").unwrap_or_else(|| currency.clone()),
                simplify_opt_in: integer_or_zero(row, "simplify_opt_in") == 1,
                archived_at: text_of(row, "archived_at"),
            })
        })
        .collect();
    let group_of_circle: BTreeMap<String, String> = group_rows
        .iter()
        .map(|group| (group.circle_id.clone(), group.group_id.clone()))
        .collect();

    let mut members_by_group: BTreeMap<String, Vec<String>> = group_rows
        .iter()
        .map(|group| (group.group_id.clone(), Vec::new()))
        .collect();
    for row in &members.rows {
        let Some(circle_id) = text_of(row, "circle_id") else {
            continue;
        };
        let Some(party_id) = text_of(row, "party_id") else {
            continue;
        };
        if let Some(group_id) = group_of_circle.get(&circle_id) {
            members_by_group
                .entry(group_id.clone())
                .or_default()
                .push(party_id);
        }
    }

    let expense_rows: Vec<ExpenseRow> = expenses.rows.iter().filter_map(expense_row).collect();
    let split_map = pairs(&splits, "share_minor");
    let payer_map = pairs(&payers, "paid_minor");

    let settlement_rows: Vec<SettlementRow> = settlements
        .iter()
        .filter_map(|row| {
            Some(SettlementRow {
                settlement_id: text_of(row, "settlement_id")?,
                group_id: text_of(row, "group_id"),
                from_party: text_of(row, "from_party")?,
                to_party: text_of(row, "to_party")?,
                amount_minor: integer_or_zero(row, "amount_minor"),
                currency: text_of(row, "currency"),
                paid_on: text_of(row, "paid_on"),
            })
        })
        .collect();

    // THE TYPED LINES, and their allocations. Both walks are bounded and both
    // ceilings are Tally's own; the allocation one is four times the line one
    // because an allocation exists per `(line, person)`.
    let mut allocations_by_line: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for row in &_allocations {
        let Some(line_item_id) = text_of(row, "line_item_id") else {
            continue;
        };
        let Some(party_id) = text_of(row, "party_id") else {
            continue;
        };
        allocations_by_line
            .entry(line_item_id)
            .or_default()
            .insert(party_id, integer_or_zero(row, "share_minor"));
    }
    let mut lines: BTreeMap<String, Vec<LineItem>> = BTreeMap::new();
    for row in &_lines {
        let Some(line_item_id) = text_of(row, "line_item_id") else {
            continue;
        };
        let Some(expense_id) = text_of(row, "expense_id") else {
            continue;
        };
        lines.entry(expense_id).or_default().push(LineItem {
            allocations: allocations_by_line
                .get(&line_item_id)
                .cloned()
                .unwrap_or_default(),
            line_item_id,
            kind: text_of(row, "kind").unwrap_or_default(),
            description: text_of(row, "description").unwrap_or_default(),
            amount_minor: integer_or_zero(row, "amount_minor"),
            sort_order: integer_or_zero(row, "sort_order"),
        });
    }
    // A line's place in the receipt is its own column, not the order the rows
    // came back in.
    for lines in lines.values_mut() {
        lines.sort_by_key(|line| line.sort_order);
    }

    // THE PARTY SET, and the subtlety of the whole read
    // (`queries/dashboard.ts:400-424`). Circle membership is current state, the
    // ledger durable history, so a member who left must stay nameable wherever
    // an expense or settlement still refers to them. The set is the union of
    // circle members, every `paid_by`, every co-payer and sharer ON A LIVE
    // EXPENSE, and both sides of every settlement.
    let live: BTreeSet<&str> = expense_rows
        .iter()
        .filter(|expense| expense.deleted_at.is_none())
        .map(|expense| expense.expense_id.as_str())
        .collect();
    let mut party_ids: BTreeSet<String> = BTreeSet::new();
    party_ids.extend(me.clone());
    party_ids.extend(
        friends
            .rows
            .iter()
            .filter_map(|row| text_of(row, "party_id")),
    );
    for roster in members_by_group.values() {
        party_ids.extend(roster.iter().cloned());
    }
    for expense in &expense_rows {
        if !live.contains(expense.expense_id.as_str()) {
            continue;
        }
        party_ids.insert(expense.paid_by.clone());
        party_ids.extend(
            split_map
                .get(&expense.expense_id)
                .into_iter()
                .flat_map(BTreeMap::keys)
                .cloned(),
        );
        party_ids.extend(
            payer_map
                .get(&expense.expense_id)
                .into_iter()
                .flat_map(BTreeMap::keys)
                .cloned(),
        );
    }
    for settlement in &settlement_rows {
        party_ids.insert(settlement.from_party.clone());
        party_ids.insert(settlement.to_party.clone());
    }

    // THE PEOPLE TABLE, with the three defaults v0 spells and the reason each
    // one differs (`queries/dashboard.ts:468-497`). The OWNER is "You" in the
    // ink brand; a FRIEND with no display name is "Friend"; any other party the
    // ledger names is "Someone". Three words, not one placeholder: the owner is
    // never a stranger, and a friend with a missing name is a different repair
    // job from a co-payer nobody ever added.
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    let ids: Vec<String> = party_ids.into_iter().collect();
    if !ids.is_empty() {
        let statement = parties_statement(&ids)?;
        let parties = read_pages(door, &statement, LEDGER_FAN_OUT)?;
        for row in &parties {
            if let Some(party_id) = text_of(row, "party_id")
                && let Some(name) = text_of(row, "display_name")
            {
                names.insert(party_id, name);
            }
        }
    }
    let friend_ids: Vec<String> = friends
        .rows
        .iter()
        .filter_map(|row| text_of(row, "party_id"))
        .collect();
    let mut people: BTreeMap<String, Person> = BTreeMap::new();
    if let Some(me) = me.clone() {
        people.insert(
            me.clone(),
            Person {
                party_id: me,
                name: "You".to_owned(),
                color: centraid_design::BRAND.to_owned(),
                initials: centraid_design::identity_initials("You"),
                is_me: true,
            },
        );
    }
    for party_id in &friend_ids {
        let name = names
            .get(party_id)
            .filter(|name| !name.is_empty())
            .cloned()
            .unwrap_or_else(|| "Friend".to_owned());
        people.insert(party_id.clone(), person_of_name(party_id, &name, false));
    }
    // EVERY id the ledger named, not only the ones with a party row: a sharer
    // whose `core_party` row is gone still has to be nameable, and "Someone" is
    // that name.
    for party_id in &ids {
        if people.contains_key(party_id) {
            continue;
        }
        let name = names
            .get(party_id)
            .filter(|name| !name.is_empty())
            .cloned()
            .unwrap_or_else(|| "Someone".to_owned());
        people.insert(party_id.clone(), person_of_name(party_id, &name, false));
    }

    Ok(TallyData {
        me,
        currency,
        people,
        friends: friend_ids,
        groups: group_rows,
        members_by_group,
        expenses: expense_rows,
        splits: split_map,
        payers: payer_map,
        settlements: settlement_rows,
        lines,
        obligations,
        nudges: nudges.rows,
        ledger_window_filled: expenses.filled,
    })
}

/// The trash shelf, the standing orders and their exceptions: the three pages
/// `dashboardHandler` adds on top of [`load_tally`]
/// (`queries/dashboard.ts:944`, `:959`, `:973`).
pub fn load_dashboard_extras(door: &dyn PageDoor) -> KitResult<(Vec<Row>, Vec<Row>, Vec<Row>)> {
    Ok((
        window(door, &trash_statement(), TRASH_ROWS)?.rows,
        window(door, &recurring_statement(), RECURRING_ROWS)?.rows,
        window(door, &recurring_exceptions_statement(), EXCEPTION_ROWS)?.rows,
    ))
}

/// Whether an error is a ceiling rather than anything else, so a surface can
/// tell "the set this joins over is not bounded" from a door that said no.
pub fn is_fan_out_ceiling(error: &KitError) -> bool {
    matches!(error, KitError::FanOutExceeded { .. })
}

/// A `YYYY-MM-DD` floor, or none.
///
/// **A malformed bound must not narrow a ledger** (`queries/export.ts:22`,
/// `:27-33`): anything not matching the ten-character shape is no floor at all,
/// and a row with no date cannot fall inside a bounded range so a bound
/// excludes it. The whole comparison is on the text (#1020 apps seam 5).
pub fn floor_date(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|at| bytes[*at].is_ascii_digit());
    shaped.then_some(text)
}

/// Whether a date string falls on or after a floor. Lexicographic, because
/// `YYYY-MM-DD` sorts as text exactly as it sorts as a date.
pub fn on_or_after(date: Option<&str>, floor: Option<&str>) -> bool {
    match (date, floor) {
        (_, None) => true,
        (None, Some(_)) => false,
        (Some(date), Some(floor)) => date.len() == 10 && date >= floor,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::grammar;

    #[test]
    fn every_statement_passes_the_doors_grammar() {
        let mut statements = independent_statements();
        statements.push(trash_statement());
        statements.push(recurring_statement());
        statements.push(recurring_exceptions_statement());
        statements.push(parties_statement(&["party-1".to_owned()]).unwrap());
        for statement in &statements {
            let shape = grammar::parse(statement)
                .unwrap_or_else(|error| panic!("{}: {error}", statement.name));
            assert_eq!(
                shape.tables.len(),
                1,
                "{} reads more than one table; every Tally statement is single-table",
                statement.name
            );
        }
    }

    #[test]
    fn the_projection_carries_both_order_columns() {
        // Without both, the cursor is read off a column the page did not
        // select and the walk is not a walk (`statement.ts:43-48`).
        let mut statements = independent_statements();
        statements.push(trash_statement());
        statements.push(recurring_statement());
        statements.push(recurring_exceptions_statement());
        for statement in &statements {
            for column in [&statement.order.sort_column, &statement.order.pk_column] {
                assert!(
                    statement
                        .select
                        .split(',')
                        .any(|projected| projected.trim() == column),
                    "{} orders by {column} and does not select it",
                    statement.name
                );
            }
        }
    }

    #[test]
    fn the_pair_keyed_tables_are_keyed_on_their_own_pair() {
        // A cursor on `expense_id` alone stops at the first sharer.
        for statement in [
            splits_statement(),
            payers_statement(),
            receipt_allocations_statement(),
        ] {
            assert_ne!(
                statement.order.sort_column, statement.order.pk_column,
                "{} must compare the table's own pair",
                statement.name
            );
            assert_eq!(statement.order.pk_column, "party_id");
        }
    }

    #[test]
    fn the_stated_ceilings_are_the_ones_v0_meant_and_can_be_reached() {
        assert_eq!(LEDGER_FAN_OUT.cap(), 8_000);
        assert_eq!(ALLOCATION_FAN_OUT.cap(), 32_000);
        assert_eq!(LEDGER_ROWS, 2_000);
        // The window Tally promises needs the ceiling it states: 2,000
        // expenses with four sharers each is exactly 8,000 split rows, and a
        // bound that stopped at 4,000 would refuse the promise.
        assert!(LEDGER_FAN_OUT.cap() >= LEDGER_ROWS * 4);
    }

    #[test]
    fn a_malformed_bound_is_no_floor_and_a_dateless_row_is_excluded_by_one() {
        assert_eq!(floor_date("2099-05-10"), Some("2099-05-10"));
        assert_eq!(floor_date("not-a-date"), None);
        assert_eq!(floor_date("2099-5-10"), None);
        assert!(on_or_after(None, None), "no floor keeps every row");
        assert!(!on_or_after(None, Some("2099-05-10")));
        assert!(on_or_after(Some("2099-05-11"), Some("2099-05-10")));
        assert!(!on_or_after(Some("2099-05-09"), Some("2099-05-10")));
    }
}
