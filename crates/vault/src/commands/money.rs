//! Money's verbs for accounts, categories, budgets and checkpoints, and the reads a screen makes
//! of them ([#1135](https://github.com/srikanth235/centraid/issues/1135), #1214).
//!
//! Money says where the member's money went. **Nothing stored is a figure**: no balance, total or
//! rollup is written; a screen derives them at read time ([`balance_on`], [`spending_in_month`],
//! [`budgets_of_month`]). What is written is a decision (a name, a category, a budget, a rule) or a
//! fact the bank stated (a line, a checkpoint).
//!
//! - **An account** is an entity with a type (a lookup: `account_type`), a currency (changing it
//!   rescales every figure kept in it, and is refused when one would lose a fraction), and the
//!   balance it opened with on a day (`opening_on`: lines on or before it
//!   are already in that balance). A statement origin fills it only once a statement is read or its
//!   bank number or column layout is remembered (`origin.ref`, `origin.config`): an account kept by
//!   hand has none. Closing is the `archived` flag, a rename is `entity.retitle`, and trashing an
//!   account takes its lines with it, as a holder takes what it holds (`entity.trash`).
//! - **A line** is [`super::txn`]'s: entered by hand on any account or stated by a bank, with its
//!   categories in `txn_split` (one place, E3). **The amount is signed: money out is negative.**
//! - **A category** is a concept; a group is a category with no parent. Its position in the
//!   hierarchy is its home (`entity.parent_id`).
//! - **A budget** is a category's amount for a month in the vault's currency (it has no currency of
//!   its own), and a checkpoint is a balance the bank stated that a derived balance is compared with.
//!   Neither is part of a category's snapshot (B1): setting one writes no copy of the others.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::entity::{STALE_GUARD, with_rev};
use crate::commands::txn_portable::exponent;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;
use crate::model::{Kind, fold_label};

// ---------------------------------------------------------------------------
// Small helpers. SQL lives in `crates/vault` by construction.
// ---------------------------------------------------------------------------

/// Every month a category has a budget for: a seek by the primary
/// key `(category_id, month)`. `money_walks.rs` plans it.
pub const PLANS_OF_CATEGORY: &str =
    "SELECT month, amount_minor, carry FROM budget WHERE category_id = ?1";

/// A category's budgets of one month, across every category: a seek by `budget_by_month`.
pub const BUDGETS_OF_MONTH: &str =
    "SELECT category_id, amount_minor, carry FROM budget WHERE month = ?1 ORDER BY category_id";

pub(crate) fn unless(ok: bool, sentence: &str) -> Option<String> {
    (!ok).then(|| sentence.to_owned())
}

/// Whether `id` names a live entity of this kind.
pub(crate) fn is_live(connection: &Connection, id: &str, kind: Kind) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM entity WHERE id = ?1 AND kind = ?2 AND deleted_at IS NULL)",
        [id, kind.as_str()],
        |row| row.get(0),
    )?)
}

pub(crate) fn is_free(connection: &Connection, id: &str) -> Result<bool> {
    Ok(!connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM entity WHERE id = ?1)",
        [id],
        |row| row.get::<_, bool>(0),
    )?)
}

/// Whether the text is a real day, `YYYY-MM-DD`.
pub(crate) fn is_day(connection: &Connection, text: &str) -> Result<bool> {
    Ok(connection.query_row("SELECT date(?1) IS ?1", [text], |row| row.get(0))?)
}

fn is_month(connection: &Connection, text: &str) -> Result<bool> {
    is_day(connection, &format!("{text}-01"))
}

fn integer(ctx: &CommandCtx<'_, '_>, key: &str) -> Option<i64> {
    ctx.input.get(key).and_then(Json::as_i64)
}

/// A name with its runs of whitespace collapsed.
pub(crate) fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A sentence when a category, live and not archived, is not there to file a line under.
pub(crate) fn fileable(connection: &Connection, id: &str) -> Result<Option<String>> {
    let held: Option<bool> = connection
        .query_row(
            "SELECT archived_at IS NOT NULL FROM entity
              WHERE id = ?1 AND kind = 'category' AND deleted_at IS NULL",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match held {
        None => Some("There is no such category.".to_owned()),
        Some(true) => Some("That category is archived. Unarchive it first.".to_owned()),
        Some(false) => None,
    })
}

/// Whether the text names a kind of account (a row of the `account_type` lookup).
fn is_account_type(connection: &Connection, code: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM account_type WHERE code = ?1)",
        [code],
        |row| row.get(0),
    )?)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// The bank number as an origin's `ref`: the number, or the account's own id.
fn origin_ref(account_id: &str, number: Option<&str>) -> String {
    number
        .map(str::trim)
        .filter(|number| !number.is_empty())
        .unwrap_or(account_id)
        .to_owned()
}

fn number_is_taken(connection: &Connection, number: &str, except: Option<&str>) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM origin WHERE system = 'statement' AND ref = ?1
                           AND fills IS NOT ?2)",
        rusqlite::params![number.trim(), except],
        |row| row.get(0),
    )?)
}

fn name_is_taken(connection: &Connection, name: &str, except: Option<&str>) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM entity e
                         WHERE e.kind = 'account' AND e.deleted_at IS NULL AND e.id IS NOT ?2
                           AND lower(trim(e.title)) = lower(trim(?1)))",
        rusqlite::params![name, except],
        |row| row.get(0),
    )?)
}

/// The statement origin that fills an account, made when there is none (a bank number or a
/// remembered layout is a fact about it, and an import finds it by its home).
fn ensure_origin(ctx: &CommandCtx<'_, '_>, account_id: &str, number: Option<&str>) -> Result<()> {
    let connection = ctx.connection();
    let held: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM origin WHERE fills = ?1)",
        [account_id],
        |row| row.get(0),
    )?;
    if held {
        return Ok(());
    }
    let title: String = connection.query_row(
        "SELECT title FROM entity WHERE id = ?1",
        [account_id],
        |row| row.get(0),
    )?;
    connection.execute(
        "INSERT INTO origin (id, system, ref, label, fills, fills_kind, created_at)
         VALUES (?1, 'statement', ?2, ?3, ?4, 'account', ?5)",
        rusqlite::params![
            ctx.next_id(),
            origin_ref(account_id, number),
            title,
            account_id,
            ctx.now
        ],
    )?;
    Ok(())
}

fn pre_new_account(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    if let Some(id) = ctx.optional_str("id")
        && !is_free(connection, id)?
    {
        return Ok(Some("An account with that id already exists.".to_owned()));
    }
    let name = squash(ctx.required_str("title")?);
    if name.is_empty() {
        return Ok(Some("An account needs a name.".to_owned()));
    }
    if name_is_taken(connection, &name, None)? {
        return Ok(Some(
            "You already have an account with that name.".to_owned(),
        ));
    }
    if !is_account_type(connection, ctx.required_str("type")?)? {
        return Ok(Some("That is not a kind of account.".to_owned()));
    }
    if let Some(currency) = ctx.optional_str("currency")
        && !is_currency(currency)
    {
        return Ok(Some(
            "A currency is a three-letter code like USD.".to_owned(),
        ));
    }
    if let Some(number) = ctx.optional_str("external_ref")
        && !number.trim().is_empty()
        && number_is_taken(connection, number, None)?
    {
        return Ok(Some(
            "Another account already has that bank number.".to_owned(),
        ));
    }
    opening_sentence(ctx)
}

/// A currency code: three letters. It is kept upper-case.
fn is_currency(text: &str) -> bool {
    let text = text.trim();
    text.len() == 3 && text.chars().all(|c| c.is_ascii_alphabetic())
}

/// An opening balance is as of a real day; one that is not nothing needs its day, or no
/// one can say which lines it already holds.
fn opening_sentence(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let day = ctx.optional_str("opening_on");
    if let Some(day) = day
        && !is_day(ctx.connection(), day)?
    {
        return Ok(Some("That is not a real date.".to_owned()));
    }
    Ok(
        (integer(ctx, "opening_minor").unwrap_or(0) != 0 && day.is_none())
            .then(|| "An opening balance needs the day it was true.".to_owned()),
    )
}

#[derive(serde::Deserialize)]
struct AddAccountInput {
    id: Option<String>,
    title: String,
    #[serde(rename = "type")]
    account_type: String,
    currency: Option<String>,
    opening_minor: Option<i64>,
    opening_on: Option<String>,
    on_budget: Option<bool>,
    external_ref: Option<String>,
}

fn add_account(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: AddAccountInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let title = squash(&input.title);
    let id = match input.id.as_deref() {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Account, &title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Account, &title)?,
    };
    let currency = match input.currency.as_deref() {
        Some(currency) => currency.trim().to_uppercase(),
        None => connection.query_row("SELECT currency FROM vault", [], |row| row.get(0))?,
    };
    connection.execute(
        "INSERT INTO account (id, type, currency, opening_minor, opening_on, on_budget)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            id,
            input.account_type,
            currency,
            input.opening_minor.unwrap_or(0),
            input.opening_on,
            i64::from(input.on_budget.unwrap_or(true)),
        ],
    )?;
    if let Some(number) = input
        .external_ref
        .as_deref()
        .filter(|number| !number.trim().is_empty())
    {
        ensure_origin(ctx, &id, Some(number))?;
    }
    Ok(json!({ "id": id, "currency": currency }))
}

fn pre_account(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let id = ctx.required_str("id")?;
    Ok(unless(
        is_live(ctx.connection(), id, Kind::Account)?,
        "There is no such account.",
    ))
}

/// The tables that keep a figure in an account's currency, each with the filter that reaches the
/// account's rows. `original_*` (another currency) and a budget (per category) are not among them.
const FIGURES: [(&str, &str, &str); 4] = [
    ("account", "opening_minor", "id = ?1"),
    ("txn", "amount_minor", "account_id = ?1"),
    (
        "txn_split",
        "amount_minor",
        "txn_id IN (SELECT id FROM txn WHERE account_id = ?1)",
    ),
    ("checkpoint", "balance_minor", "account_id = ?1"),
];

/// How an account's figures scale when its currency changes: `Some((true, f))` multiplies by `f`,
/// `Some((false, f))` divides, `None` leaves them be.
fn scale(connection: &Connection, id: &str, currency: &str) -> Result<Option<(bool, i64)>> {
    let held: String =
        connection.query_row("SELECT currency FROM account WHERE id = ?1", [id], |row| {
            row.get(0)
        })?;
    let (old, new) = (exponent(&held), exponent(currency));
    let factor = 10_i64.pow(old.abs_diff(new));
    Ok((old != new).then_some((new > old, factor)))
}

/// A sentence when changing the account to `currency` would lose a fraction of a figure or
/// overflow one.
fn rescale_sentence(connection: &Connection, id: &str, currency: &str) -> Result<Option<String>> {
    let Some((up, factor)) = scale(connection, id, currency)? else {
        return Ok(None);
    };
    for (table, column, filter) in FIGURES {
        if up {
            let widest: Option<i64> = connection.query_row(
                &format!("SELECT MAX(ABS({column})) FROM {table} WHERE {filter}"),
                [id],
                |row| row.get(0),
            )?;
            if widest.is_some_and(|widest| widest.checked_mul(factor).is_none()) {
                return Ok(Some(format!(
                    "A figure in this account is too large to hold in {currency}."
                )));
            }
        } else {
            let lost: i64 = connection.query_row(
                &format!(
                    "SELECT COUNT(*) FROM {table} WHERE {filter} AND {column} % {factor} <> 0"
                ),
                [id],
                |row| row.get(0),
            )?;
            if lost > 0 {
                return Ok(Some(format!(
                    "{currency} has no cents, and {lost} figure{} in this account {}.",
                    if lost == 1 { "" } else { "s" },
                    if lost == 1 { "has some" } else { "have some" },
                )));
            }
        }
    }
    Ok(None)
}

/// Give the account `currency`, keeping every figure in the account's currency worth what it was:
/// the digits scale by the change of the currencies' minor units. Whether anything changed.
fn relabel(connection: &Connection, id: &str, currency: &str) -> Result<bool> {
    let Some(scaled) = scale(connection, id, currency)? else {
        return Ok(connection.execute(
            "UPDATE account SET currency = ?2 WHERE id = ?1 AND currency IS NOT ?2",
            [id, currency],
        )? > 0);
    };
    let (up, factor) = scaled;
    let operator = if up { '*' } else { '/' };
    for (table, column, filter) in FIGURES.iter().skip(1) {
        connection.execute(
            &format!("UPDATE {table} SET {column} = {column} {operator} {factor} WHERE {filter}"),
            [id],
        )?;
    }
    connection.execute(
        &format!(
            "UPDATE account SET currency = ?2, opening_minor = opening_minor {operator} {factor}
              WHERE id = ?1"
        ),
        [id, currency],
    )?;
    Ok(true)
}

fn pre_edit_account(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = pre_account(ctx)? {
        return Ok(Some(sentence));
    }
    let connection = ctx.connection();
    let id = ctx.required_str("id")?;
    if let Some(title) = ctx.optional_str("title") {
        let name = squash(title);
        if name.is_empty() {
            return Ok(Some("An account needs a name.".to_owned()));
        }
        if name_is_taken(connection, &name, Some(id))? {
            return Ok(Some(
                "You already have an account with that name.".to_owned(),
            ));
        }
    }
    if let Some(wanted) = ctx.optional_str("type")
        && !is_account_type(connection, wanted)?
    {
        return Ok(Some("That is not a kind of account.".to_owned()));
    }
    if let Some(currency) = ctx.optional_str("currency") {
        if !is_currency(currency) {
            return Ok(Some(
                "A currency is a three-letter code like USD.".to_owned(),
            ));
        }
        if let Some(sentence) = rescale_sentence(connection, id, &currency.trim().to_uppercase())? {
            return Ok(Some(sentence));
        }
    }
    if let Some(number) = ctx.optional_str("external_ref")
        && !number.trim().is_empty()
        && number_is_taken(connection, number, Some(id))?
    {
        return Ok(Some(
            "Another account already has that bank number.".to_owned(),
        ));
    }
    Ok(None)
}

#[derive(serde::Deserialize)]
struct EditAccountInput {
    id: String,
    title: Option<String>,
    #[serde(rename = "type")]
    account_type: Option<String>,
    currency: Option<String>,
    on_budget: Option<bool>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    external_ref: Option<Option<String>>,
}

fn edit_account(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditAccountInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let id = input.id.as_str();
    let mut changed = false;
    if let Some(title) = input.title.as_deref() {
        let name = squash(title);
        changed |= connection.execute(
            "UPDATE entity SET title = ?2 WHERE id = ?1 AND title IS NOT ?2",
            [id, &name],
        )? > 0;
        // The origin, when there is one, is labelled by the account's name.
        connection.execute(
            "UPDATE origin SET label = ?2 WHERE system = 'statement' AND fills = ?1",
            [id, &name],
        )?;
    }
    if let Some(account_type) = input.account_type.as_deref() {
        changed |= connection.execute(
            "UPDATE account SET type = ?2 WHERE id = ?1 AND type IS NOT ?2",
            [id, account_type],
        )? > 0;
    }
    let mut replaced = None;
    if let Some(currency) = input.currency.as_deref() {
        let held: String =
            connection.query_row("SELECT currency FROM account WHERE id = ?1", [id], |row| {
                row.get(0)
            })?;
        if relabel(connection, id, &currency.trim().to_uppercase())? {
            changed = true;
            replaced = Some(held);
        }
    }
    if let Some(budget) = input.on_budget {
        changed |= connection.execute(
            "UPDATE account SET on_budget = ?2 WHERE id = ?1 AND on_budget IS NOT ?2",
            rusqlite::params![id, i64::from(budget)],
        )? > 0;
    }
    if let Some(number) = input.external_ref {
        let number = number.filter(|number| !number.trim().is_empty());
        if number.is_some() {
            ensure_origin(ctx, id, number.as_deref())?;
        }
        changed |= connection.execute(
            "UPDATE origin SET ref = ?2 WHERE system = 'statement' AND fills = ?1 AND ref IS NOT ?2",
            rusqlite::params![id, origin_ref(id, number.as_deref())],
        )? > 0;
    }
    if changed {
        ctx.touch(id)?;
    }
    let mut answer = json!({ "id": id, "changed": changed });
    if let Some(held) = replaced {
        answer["replaced"] = json!({ "currency": held });
    }
    with_rev(ctx, id, answer)
}

fn pre_set_opening(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = pre_account(ctx)? {
        return Ok(Some(sentence));
    }
    opening_sentence(ctx)
}

#[derive(serde::Deserialize)]
struct SetOpeningInput {
    id: String,
    opening_minor: Option<i64>,
    opening_on: Option<String>,
}

fn set_opening(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: SetOpeningInput = ctx.parse_input()?;
    let changed = ctx.connection().execute(
        "UPDATE account SET opening_minor = ?2, opening_on = ?3
          WHERE id = ?1 AND (opening_minor, opening_on) IS NOT (?2, ?3)",
        rusqlite::params![input.id, input.opening_minor.unwrap_or(0), input.opening_on],
    )? > 0;
    Ok(json!({ "id": input.id, "changed": changed }))
}

fn pre_layout(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = pre_account(ctx)? {
        return Ok(Some(sentence));
    }
    let layout = ctx.input.get("layout").cloned().unwrap_or(Json::Null);
    if layout.is_null() {
        return Ok(None);
    }
    let has = |key: &str| layout.get(key).is_some_and(|value| !value.is_null());
    let missing = match layout.get("sign_mode").and_then(Json::as_str) {
        Some("debit_credit") => !(has("debit_col") && has("credit_col")),
        Some("indicator") => {
            !(has("amount_col") && has("indicator_col") && has("indicator_out_value"))
        }
        _ => !has("amount_col"),
    };
    Ok(missing.then(|| "This layout does not say which columns hold the amount.".to_owned()))
}

#[derive(serde::Deserialize)]
struct RememberLayoutInput {
    id: String,
    layout: Option<Json>,
}

/// Remember how the account's statements are laid out, for the next one: the layout is the
/// statement origin's `config` (a JSON object the vault defines, so it carries `"v":1`). A `null`
/// layout forgets it. The answer names the layout it replaced (`null` when none was remembered),
/// which is how the act is taken back.
fn remember_layout(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: RememberLayoutInput = ctx.parse_input()?;
    let layout = input.layout.filter(|layout| !layout.is_null());
    if layout.is_some() {
        ensure_origin(ctx, &input.id, None)?;
    }
    let stored = layout.map(|mut layout| {
        if let Some(object) = layout.as_object_mut() {
            object.insert("v".to_owned(), json!(1));
        }
        layout.to_string()
    });
    let held: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT config FROM origin WHERE system = 'statement' AND fills = ?1",
            [input.id.as_str()],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let saved = ctx.connection().execute(
        "UPDATE origin SET config = ?2
          WHERE system = 'statement' AND fills = ?1 AND config IS NOT ?2",
        rusqlite::params![input.id, stored],
    )? > 0;
    if !saved {
        return Ok(json!({ "saved": false }));
    }
    let replaced = held
        .as_deref()
        .and_then(|text| serde_json::from_str::<Json>(text).ok())
        .map(|mut layout| {
            if let Some(object) = layout.as_object_mut() {
                object.remove("v");
            }
            layout
        })
        .unwrap_or(Json::Null);
    Ok(json!({ "saved": true, "replaced": { "layout": replaced } }))
}

// ---------------------------------------------------------------------------
// What an account stood at, derived
// ---------------------------------------------------------------------------

/// The statement behind [`balance_on`]: one range of the account's lines by day. `money.rs`'s plan
/// test reads it.
pub const POSTED_BETWEEN: &str = "SELECT COALESCE(SUM(t.amount_minor), 0)
   FROM txn t CROSS JOIN entity e ON e.id = t.id
  WHERE t.account_id = ?1 AND t.posted_on > ?2 AND t.posted_on <= ?3
    AND t.status = 'posted' AND e.deleted_at IS NULL";

/// The statement behind [`spending_in_month`]: the month's lines by day, each line's parts by key.
pub const SPENDING_OF_MONTH: &str =
    "SELECT a.currency, s.category_id, COALESCE(s.amount_minor, t.amount_minor)
   FROM txn t
   CROSS JOIN entity e ON e.id = t.id
   CROSS JOIN account a ON a.id = t.account_id
   LEFT JOIN txn_split s ON s.txn_id = t.id
  WHERE t.posted_on >= ?1 AND t.posted_on < ?2 AND t.status = 'posted'
    AND e.deleted_at IS NULL AND a.on_budget = 1
    AND NOT EXISTS (SELECT 1 FROM transfer x WHERE x.a = t.id OR x.b = t.id)";

/// The sum of an account's posted lines after `after` (exclusive; `None` is the start of time) and
/// up to `until` (inclusive), the lines in the trash left out: a range of the account's lines by
/// day (`txn_by_account_day`).
fn posted_between(
    connection: &Connection,
    account_id: &str,
    after: Option<&str>,
    until: &str,
) -> Result<i64> {
    Ok(connection.query_row(
        POSTED_BETWEEN,
        rusqlite::params![account_id, after.unwrap_or(""), until],
        |row| row.get(0),
    )?)
}

/// What the account stood at on `day`: the balance it opened with plus the posted lines after the
/// day it opened on, up to `day`; before that day, the balance it opened with less the lines in
/// between. Derived at read time and written nowhere. `None` when there is no such account.
///
/// # Errors
/// A database error.
pub fn balance_on(connection: &Connection, account_id: &str, day: &str) -> Result<Option<i64>> {
    let Some((opening, opening_on)) = connection
        .query_row(
            "SELECT opening_minor, opening_on FROM account WHERE id = ?1",
            [account_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?
    else {
        return Ok(None);
    };
    Ok(Some(match opening_on.as_deref() {
        None => opening + posted_between(connection, account_id, None, day)?,
        Some(opened) if day >= opened => {
            opening + posted_between(connection, account_id, Some(opened), day)?
        }
        Some(opened) => opening - posted_between(connection, account_id, Some(day), opened)?,
    }))
}

/// A balance the bank stated, and what the lines say it should have been.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointGap {
    pub day: String,
    pub stated_minor: i64,
    pub derived_minor: i64,
}

/// An account's checkpoints, oldest first, each beside the balance the lines derive for its day.
/// A gap is where a statement is missing a line or a hand line is wrong.
///
/// # Errors
/// A database error.
pub fn checkpoint_gaps(connection: &Connection, account_id: &str) -> Result<Vec<CheckpointGap>> {
    let stated: Vec<(String, i64)> = connection
        .prepare_cached(
            "SELECT day, balance_minor FROM checkpoint WHERE account_id = ?1 ORDER BY day",
        )?
        .query_map([account_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    stated
        .into_iter()
        .map(|(day, stated_minor)| {
            Ok(CheckpointGap {
                derived_minor: balance_on(connection, account_id, &day)?.unwrap_or(0),
                day,
                stated_minor,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// What a month spent, and what was planned
// ---------------------------------------------------------------------------

/// What a month holds in one currency and one category (`None`: no category): the signed sum of
/// the parts filed there, so money out is negative.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spent {
    pub currency: String,
    pub category_id: Option<String>,
    pub amount_minor: i64,
}

/// The month's lines that count toward a plan, summed by currency and category: posted, on a
/// budgeted account, not in the trash and not a half of a transfer (money moved between the
/// member's own accounts is not spent). One walk of the month by day (`txn_by_day`) with a seek of
/// each line's parts by key; the sum is made here, so the plan has no sort.
///
/// # Errors
/// A database error.
pub fn spending_in_month(connection: &Connection, month: &str) -> Result<Vec<Spent>> {
    let first = format!("{month}-01");
    let next: String =
        connection.query_row("SELECT date(?1, '+1 month')", [&first], |row| row.get(0))?;
    let mut statement = connection.prepare_cached(SPENDING_OF_MONTH)?;
    let mut sums: BTreeMap<(String, Option<String>), i64> = BTreeMap::new();
    let mut rows = statement.query([&first, &next])?;
    while let Some(row) = rows.next()? {
        *sums.entry((row.get(0)?, row.get(1)?)).or_default() += row.get::<_, i64>(2)?;
    }
    Ok(sums
        .into_iter()
        .map(|((currency, category_id), amount_minor)| Spent {
            currency,
            category_id,
            amount_minor,
        })
        .collect())
}

/// What a category was budgeted for a month.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Budgeted {
    pub category_id: String,
    pub amount_minor: i64,
    pub carry: bool,
}

/// Every budget of one month, in the vault's currency.
///
/// # Errors
/// A database error.
pub fn budgets_of_month(connection: &Connection, month: &str) -> Result<Vec<Budgeted>> {
    Ok(connection
        .prepare_cached(BUDGETS_OF_MONTH)?
        .query_map([month], |row| {
            Ok(Budgeted {
                category_id: row.get(0)?,
                amount_minor: row.get(1)?,
                carry: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

// ---------------------------------------------------------------------------
// Budgets and checkpoints
// ---------------------------------------------------------------------------

fn pre_plan(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    if !is_month(connection, ctx.required_str("month")?)? {
        return Ok(Some("That is not a real month.".to_owned()));
    }
    if !is_live(connection, ctx.required_str("category_id")?, Kind::Category)? {
        return Ok(Some("There is no such category.".to_owned()));
    }
    Ok(None)
}

#[derive(serde::Deserialize)]
struct SetPlanInput {
    month: String,
    category_id: String,
    amount_minor: Option<i64>,
    carry: Option<bool>,
}

fn set_plan(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: SetPlanInput = ctx.parse_input()?;
    let (month, category) = (input.month.as_str(), input.category_id.as_str());
    // What the month held before, so the act is taken back by setting it again (or by removing
    // the budget when there was none): a budget is no part of a record, so the history keeps none.
    let before: Option<(i64, bool)> = ctx
        .connection()
        .query_row(
            "SELECT amount_minor, carry FROM budget WHERE month = ?1 AND category_id = ?2",
            [month, category],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let replaced = |changed: bool| -> Json {
        if !changed {
            return Json::Null;
        }
        match &before {
            Some((amount, carry)) => json!({ "amount_minor": amount, "carry": carry }),
            None => json!({ "amount_minor": null }),
        }
    };
    let Some(amount) = input.amount_minor else {
        // `null` removes the budget for that month.
        let removed = ctx.connection().execute(
            "DELETE FROM budget WHERE month = ?1 AND category_id = ?2",
            [month, category],
        )? > 0;
        return Ok(json!({ "changed": removed, "replaced": replaced(removed) }));
    };
    let carry = input.carry.map(i64::from);
    let changed = ctx.connection().execute(
        "INSERT INTO budget (category_id, month, amount_minor, carry)
         VALUES (?1, ?2, ?3, COALESCE(?4, 0))
         ON CONFLICT (category_id, month) DO UPDATE SET
           amount_minor = excluded.amount_minor,
           carry = COALESCE(?4, budget.carry)
         WHERE budget.amount_minor IS NOT excluded.amount_minor
            OR (?4 IS NOT NULL AND budget.carry IS NOT ?4)",
        rusqlite::params![category, month, amount, carry],
    )? > 0;
    Ok(json!({ "changed": changed, "replaced": replaced(changed) }))
}

fn pre_carry(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    if !is_month(connection, ctx.required_str("month")?)? {
        return Ok(Some("That is not a real month.".to_owned()));
    }
    let found: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM budget WHERE month = ?1 AND category_id = ?2)",
        [ctx.required_str("month")?, ctx.required_str("category_id")?],
        |row| row.get(0),
    )?;
    Ok(unless(found, "Set an amount for that month first."))
}

#[derive(serde::Deserialize)]
struct SetCarryInput {
    month: String,
    category_id: String,
    carry: Option<bool>,
}

fn set_carry(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: SetCarryInput = ctx.parse_input()?;
    let before: Option<bool> = ctx
        .connection()
        .query_row(
            "SELECT carry FROM budget WHERE month = ?1 AND category_id = ?2",
            [input.month.as_str(), input.category_id.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    let changed = ctx.connection().execute(
        "UPDATE budget SET carry = ?1 WHERE month = ?2 AND category_id = ?3 AND carry IS NOT ?1",
        rusqlite::params![
            i64::from(input.carry.unwrap_or(false)),
            input.month,
            input.category_id
        ],
    )? > 0;
    Ok(json!({
        "changed": changed,
        "replaced": before.filter(|_| changed).map(|carry| json!({ "carry": carry }))
    }))
}

fn pre_checkpoint(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    if !is_live(connection, ctx.required_str("account_id")?, Kind::Account)? {
        return Ok(Some("There is no such account.".to_owned()));
    }
    Ok(unless(
        is_day(connection, ctx.required_str("day")?)?,
        "That is not a real date.",
    ))
}

#[derive(serde::Deserialize)]
struct RecordCheckpointInput {
    account_id: String,
    day: String,
    balance_minor: Option<i64>,
}

/// A balance the bank stated on a day. Stating it again, or differently, is the
/// same row: the latest word for the day stands.
fn record_checkpoint(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: RecordCheckpointInput = ctx.parse_input()?;
    let written = ctx.connection().execute(
        "INSERT INTO checkpoint (account_id, day, balance_minor) VALUES (?1, ?2, ?3)
         ON CONFLICT (account_id, day) DO UPDATE SET balance_minor = excluded.balance_minor
          WHERE checkpoint.balance_minor IS NOT excluded.balance_minor",
        rusqlite::params![
            input.account_id,
            input.day,
            input.balance_minor.unwrap_or(0)
        ],
    )? > 0;
    Ok(json!({ "written": written }))
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

fn pre_new_category(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let title = squash(ctx.required_str("title")?);
    if fold_label(&title).is_empty() {
        return Ok(Some("A category needs a name.".to_owned()));
    }
    let parent_key = match ctx.optional_str("parent_id") {
        None => None,
        Some(parent) => {
            // Two levels: a category goes under a group, and a group under nothing.
            if !is_live(connection, parent, Kind::Category)? {
                return Ok(Some("There is no such group.".to_owned()));
            }
            let held: Option<(String, Option<String>)> = connection
                .query_row(
                    "SELECT c.key, e.parent_id FROM concept c JOIN entity e ON e.id = c.id
                      WHERE c.id = ?1",
                    [parent],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            match held {
                Some((key, None)) => Some(key),
                _ => {
                    return Ok(Some(
                        "A category goes under a group, not under another category.".to_owned(),
                    ));
                }
            }
        }
    };
    let key = category_key(parent_key.as_deref(), &title);
    let taken: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM concept WHERE kind = 'category' AND key = ?1)",
        [&key],
        |row| row.get(0),
    )?;
    Ok(unless(
        !taken,
        "There is already a category with that name there.",
    ))
}

/// A category's key: its folded name, under its group's key when it has one.
fn category_key(group: Option<&str>, title: &str) -> String {
    match group {
        Some(group) => format!("{group}.{}", fold_label(title)),
        None => fold_label(title),
    }
}

#[derive(serde::Deserialize)]
struct AddCategoryInput {
    id: Option<String>,
    title: String,
    parent_id: Option<String>,
}

fn add_category(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: AddCategoryInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let parent = input.parent_id.as_deref();
    let group_key: Option<String> = match parent {
        Some(parent) => Some(connection.query_row(
            "SELECT key FROM concept WHERE id = ?1",
            [parent],
            |row| row.get(0),
        )?),
        None => None,
    };
    let title = squash(&input.title);
    let key = category_key(group_key.as_deref(), &title);
    let id = match input.id.as_deref() {
        Some(id) => {
            ctx.insert_entity_in(id, Kind::Category, &title, parent)?;
            id.to_owned()
        }
        None => ctx.insert_entity_under(Kind::Category, &title, parent)?,
    };
    connection.execute(
        "INSERT INTO concept (id, kind, key) VALUES (?1, 'category', ?2)",
        rusqlite::params![id, key],
    )?;
    Ok(json!({ "id": id }))
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const NEW_ACCOUNT: &[CommandCondition] = &[CommandCondition {
        predicate: "account_is_new_and_named",
        check: pre_new_account,
    }];
    const SET_OPENING: &[CommandCondition] = &[CommandCondition {
        predicate: "account_exists_and_opening_has_its_day",
        check: pre_set_opening,
    }];
    const EDIT_ACCOUNT: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "account_edit_is_sound",
            check: pre_edit_account,
        },
    ];
    const LAYOUT: &[CommandCondition] = &[CommandCondition {
        predicate: "layout_names_its_columns",
        check: pre_layout,
    }];
    const PLAN: &[CommandCondition] = &[CommandCondition {
        predicate: "plan_is_for_a_month_and_a_category",
        check: pre_plan,
    }];
    const CARRY: &[CommandCondition] = &[CommandCondition {
        predicate: "plan_exists",
        check: pre_carry,
    }];
    const CHECKPOINT: &[CommandCondition] = &[CommandCondition {
        predicate: "checkpoint_is_for_an_account_and_a_day",
        check: pre_checkpoint,
    }];
    const NEW_CATEGORY: &[CommandCondition] = &[CommandCondition {
        predicate: "category_is_new_and_under_a_group",
        check: pre_new_category,
    }];

    vec![
        CommandDefinition::plain(
            "account.add",
            "account",
            r#"{
              "type": "object",
              "required": ["title", "type"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "minLength": 1, "maxLength": 80 },
                "type": { "type": "string", "minLength": 1, "maxLength": 40 },
                "currency": { "type": "string", "minLength": 3, "maxLength": 3 },
                "on_budget": { "type": "boolean" },
                "external_ref": { "type": "string", "minLength": 1, "maxLength": 64 },
                "opening_minor": { "type": "integer" },
                "opening_on": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }
              }
            }"#,
            Idempotency::Once,
            NEW_ACCOUNT,
            add_account,
        ),
        CommandDefinition::plain(
            "account.edit",
            "account",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "minLength": 1, "maxLength": 80 },
                "type": { "type": "string", "minLength": 1, "maxLength": 40 },
                "currency": { "type": "string", "minLength": 3, "maxLength": 3 },
                "on_budget": { "type": "boolean" },
                "external_ref": { "type": ["string", "null"], "minLength": 1, "maxLength": 64 },
                "expected_rev": { "type": "integer", "minimum": 0 }
              }
            }"#,
            Idempotency::Idempotent,
            EDIT_ACCOUNT,
            edit_account,
        ),
        CommandDefinition::plain(
            "account.set_opening",
            "account",
            r#"{
              "type": "object",
              "required": ["id", "opening_minor"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "opening_minor": { "type": "integer" },
                "opening_on": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }
              }
            }"#,
            Idempotency::Idempotent,
            SET_OPENING,
            set_opening,
        ),
        CommandDefinition::plain(
            "account.remember_layout",
            "account",
            r#"{
              "type": "object",
              "required": ["id", "layout"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "layout": {
                  "type": ["object", "null"],
                  "required": ["header_fingerprint", "delimiter", "date_order", "sign_mode", "date_col", "desc_col"],
                  "additionalProperties": false,
                  "properties": {
                    "header_fingerprint": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "delimiter": { "type": "string", "minLength": 1, "maxLength": 1 },
                    "skip_lines": { "type": "integer", "minimum": 0, "maximum": 1000 },
                    "date_order": { "enum": ["mdy", "dmy", "ymd"] },
                    "sign_mode": { "enum": ["signed", "debit_credit", "indicator", "flip"] },
                    "date_col": { "type": "integer", "minimum": 0 },
                    "amount_col": { "type": ["integer", "null"], "minimum": 0 },
                    "debit_col": { "type": ["integer", "null"], "minimum": 0 },
                    "credit_col": { "type": ["integer", "null"], "minimum": 0 },
                    "desc_col": { "type": "integer", "minimum": 0 },
                    "memo_col": { "type": ["integer", "null"], "minimum": 0 },
                    "indicator_col": { "type": ["integer", "null"], "minimum": 0 },
                    "indicator_out_value": { "type": ["string", "null"] }
                  }
                }
              }
            }"#,
            Idempotency::Idempotent,
            LAYOUT,
            remember_layout,
        ),
        CommandDefinition::plain(
            "budget.set",
            "budget",
            r#"{
              "type": "object",
              "required": ["month", "category_id", "amount_minor"],
              "additionalProperties": false,
              "properties": {
                "month": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}$" },
                "category_id": { "type": "string", "minLength": 1 },
                "amount_minor": { "type": ["integer", "null"], "minimum": 0 },
                "carry": { "type": "boolean" }
              }
            }"#,
            Idempotency::Idempotent,
            PLAN,
            set_plan,
        ),
        CommandDefinition::plain(
            "budget.set_carry",
            "budget",
            r#"{
              "type": "object",
              "required": ["month", "category_id", "carry"],
              "additionalProperties": false,
              "properties": {
                "month": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}$" },
                "category_id": { "type": "string", "minLength": 1 },
                "carry": { "type": "boolean" }
              }
            }"#,
            Idempotency::Idempotent,
            CARRY,
            set_carry,
        ),
        CommandDefinition::plain(
            "checkpoint.record",
            "checkpoint",
            r#"{
              "type": "object",
              "required": ["account_id", "day", "balance_minor"],
              "additionalProperties": false,
              "properties": {
                "account_id": { "type": "string", "minLength": 1 },
                "day": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
                "balance_minor": { "type": "integer" }
              }
            }"#,
            Idempotency::Idempotent,
            CHECKPOINT,
            record_checkpoint,
        ),
        CommandDefinition::plain(
            "category.add",
            "category",
            r#"{
              "type": "object",
              "required": ["title"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "minLength": 1, "maxLength": 60 },
                "parent_id": { "type": "string", "minLength": 1 }
              }
            }"#,
            Idempotency::Once,
            NEW_CATEGORY,
            add_category,
        ),
    ]
}
